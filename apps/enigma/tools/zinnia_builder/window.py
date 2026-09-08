"""The builder window: pick an app, build it, watch the log.

ONE window for all three office apps rather than three near-identical tools.
They differ only in slug, name and port — every one of which `appspec` reads
out of the repo — so a per-app window would be three copies of this file with
a constant changed, and the third copy is where a fix stops being applied.

Deliberately smaller than enigma's builder. That one carries feature editions,
a signing pipeline and a price table, because Enigma26 ships in editions and is
signed. These three have none of that: they build, they run, and they produce a
package. Inventing an edition system for them so the two tools look alike would
be inventing work.

The heavy lifting is `appbuilder`'s shared half — the worker that can actually
cancel a cargo build, the environment scrubber that lets the result launch from
a snap-poisoned parent, and the bundle-format table that admits an .rpm built
on Ubuntu will probably not run on Fedora.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from string import Template

from PyQt6.QtCore import Qt, QSettings
from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

import appspec
import commands
import platforms
import runenv
import theme
import widgets
from appspec import AppSpec
from build_worker import BuildWorker

APP_NAME = "Zinnia Builder"
ORG_NAME = "SpectrumAI"


class BuilderWindow(QMainWindow):
    def __init__(self, root: Path) -> None:
        super().__init__()
        self.root = root
        self.apps = appspec.load_all(root)
        self.worker: BuildWorker | None = None
        self.settings = QSettings(ORG_NAME, APP_NAME)

        self.setWindowTitle(APP_NAME)
        self.resize(860, 720)
        self._apply_theme(theme.detect_system_theme())

        central = QWidget()
        self.setCentralWidget(central)
        outer = QVBoxLayout(central)
        outer.setContentsMargins(18, 18, 18, 18)
        outer.setSpacing(14)

        if not self.apps:
            outer.addWidget(widgets.section_title("No apps found"))
            outer.addWidget(widgets.hint(
                f"Looked under {root / 'apps'} for "
                f"{', '.join(appspec.ZINNIA_APPS)}. Is this the right checkout?"))
            outer.addStretch(1)
            return

        outer.addLayout(self._app_row())
        outer.addLayout(self._options_row())
        outer.addLayout(self._action_row())
        outer.addWidget(widgets.separator())

        self.status = QLabel("Ready.")
        self.status.setObjectName("details")
        outer.addWidget(self.status)

        # 5,000 lines is a cargo build with room to spare; the cap is what
        # keeps a long build from growing the widget without limit.
        self.log = widgets.MonoPane("log", "The build log appears here.", 5000)
        outer.addWidget(self.log, 1)

        self.artifacts = QLabel("")
        self.artifacts.setObjectName("details")
        self.artifacts.setTextInteractionFlags(Qt.TextInteractionFlag.TextBrowserInteraction)
        self.artifacts.setWordWrap(True)
        outer.addWidget(self.artifacts)

        self._restore_app_choice()
        self._on_app_changed()

    def _apply_theme(self, name: str) -> None:
        """Enigma's builder owns a theme toggle; this one follows the system and
        says nothing about it. One less control on a window whose whole job is
        four buttons and a log."""
        tokens = theme.THEMES.get(name, theme.THEMES["light"])
        self.setStyleSheet(Template(theme.QSS_TEMPLATE).substitute(tokens))
        from PyQt6.QtWidgets import QApplication

        instance = QApplication.instance()
        if instance is not None:
            instance.setPalette(theme.build_palette(tokens))

    # ── the form ────────────────────────────────────────────────────────────

    def _app_row(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.addWidget(widgets.section_title("App"))
        self.app_box = QComboBox()
        for app in self.apps:
            self.app_box.addItem(f"{app.product_name}  ({app.slug})", app.slug)
        self.app_box.currentIndexChanged.connect(self._on_app_changed)
        row.addWidget(self.app_box, 1)
        self.identity = QLabel("")
        self.identity.setObjectName("details")
        row.addWidget(self.identity, 2)
        return row

    def _options_row(self) -> QHBoxLayout:
        """Package formats as CHECKBOXES, with the impossible ones disabled.

        Tauri compiles for the machine it runs on, so a .dmg is not a choice on
        Linux — it is a build that fails minutes in. Greyed out with the reason
        in the tooltip is more honest than offering it, and far more honest
        than a menu that silently produces the wrong thing.
        """
        row = QHBoxLayout()
        row.addWidget(QLabel("Package"))
        self.target_boxes: dict[str, QCheckBox] = {}
        for target in platforms.TARGETS:
            box = QCheckBox(target.label.split("  ")[0])
            possible = target.buildable_here()
            box.setEnabled(possible)
            box.setChecked(possible and target.key in ("deb", "rpm"))
            box.setToolTip(platforms.refuse(target.key) or target.note or target.label)
            self.target_boxes[target.key] = box
            row.addWidget(box)
        row.addStretch(1)

        self.debug_box = QCheckBox("Debug build")
        self.debug_box.setToolTip("Far faster to build, slower to run.")
        row.addWidget(self.debug_box)

        self.tests_box = QCheckBox("Run tests first")
        self.tests_box.setChecked(True)
        self.tests_box.setToolTip(
            "The app's build.sh gates on its own suite. Unticking skips it —\n"
            "faster, and the bundle is then unverified.")
        row.addWidget(self.tests_box)
        return row

    def _selected_targets(self) -> list[str]:
        return [k for k, box in self.target_boxes.items()
                if box.isChecked() and box.isEnabled()]

    def _action_row(self) -> QHBoxLayout:
        row = QHBoxLayout()
        self.build_btn = QPushButton("Build")
        self.build_btn.clicked.connect(self.on_build)
        row.addWidget(self.build_btn)

        self.frontend_btn = QPushButton("Frontend only")
        self.frontend_btn.setToolTip("Types and the Vite bundle, no Rust. Seconds, not minutes.")
        self.frontend_btn.clicked.connect(lambda: self.on_build(frontend_only=True))
        row.addWidget(self.frontend_btn)

        self.dev_btn = QPushButton("Run dev")
        self.dev_btn.setToolTip("Launch the app with hot reload.")
        self.dev_btn.clicked.connect(self.on_dev)
        row.addWidget(self.dev_btn)

        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setEnabled(False)
        self.cancel_btn.clicked.connect(self.on_cancel)
        row.addWidget(self.cancel_btn)

        row.addStretch(1)
        self.open_btn = QPushButton("Open output folder")
        self.open_btn.clicked.connect(self.on_open_output)
        row.addWidget(self.open_btn)
        return row

    # ── state ───────────────────────────────────────────────────────────────

    @property
    def app(self) -> AppSpec:
        slug = self.app_box.currentData()
        return next(a for a in self.apps if a.slug == slug)

    def _restore_app_choice(self) -> None:
        remembered = self.settings.value("ui/app", "")
        index = self.app_box.findData(remembered)
        if index >= 0:
            self.app_box.setCurrentIndex(index)

    def _on_app_changed(self) -> None:
        app = self.app
        self.settings.setValue("ui/app", app.slug)
        self.identity.setText(
            f"{app.identifier} · v{app.version} · dev port {app.dev_port}")
        self._show_artifacts()

    def _show_artifacts(self) -> None:
        found = commands.artifacts(self.app, debug=self.debug_box.isChecked())
        if not found:
            self.artifacts.setText("No bundle built yet.")
            return
        lines = [f"{p.name}  ({p.stat().st_size / 1_048_576:.1f} MB)" for p in found[:6]]
        self.artifacts.setText("Last build:  " + " · ".join(lines))

    # ── actions ─────────────────────────────────────────────────────────────

    def on_build(self, *, frontend_only: bool = False) -> None:
        if self.worker is not None:
            return
        app = self.app
        targets = self._selected_targets()
        if not targets and not frontend_only:
            QMessageBox.information(
                self, "Nothing to build",
                "Tick at least one package format. The greyed-out ones need a "
                "different operating system — see their tooltips.")
            return

        # An .rpm built on Ubuntu links THIS system's glibc and webkit2gtk, so
        # it very likely will not run on Fedora. Said before the build starts,
        # not discovered afterwards.
        if "rpm" in targets and sys.platform == "linux" and not frontend_only:
            import shutil

            if shutil.which("rpmbuild") is None:
                answer = QMessageBox.question(
                    self, "Building an .rpm here",
                    "This machine is not Fedora/RHEL. The .rpm will be linked "
                    "against this system's libraries and is unlikely to run "
                    "there — for a package that works, build inside a container "
                    "or VM of that distribution.\n\nBuild anyway?",
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
                if answer != QMessageBox.StandardButton.Yes:
                    return

        command = commands.desktop(
            app,
            debug=self.debug_box.isChecked(),
            run_tests=self.tests_box.isChecked(),
            frontend_only=frontend_only,
            bundles=targets,
        )
        self._start(command, app.app_dir, "Building" if not frontend_only else "Building frontend")

    def on_dev(self) -> None:
        """Launch dev in its own terminal-less process and return at once.

        NOT through the worker: a dev server runs until it is closed, and the
        worker's contract is a command that finishes. It also needs the scrubbed
        environment — a builder started from a snap hands the app an
        LD_LIBRARY_PATH that kills it at exec.
        """
        app = self.app
        try:
            subprocess.Popen(
                commands.dev(app),
                cwd=str(app.app_dir),
                env=runenv.clean_env(),
                start_new_session=True,
            )
            self.status.setText(f"{app.product_name} starting on port {app.dev_port}…")
        except OSError as exc:
            QMessageBox.warning(self, "Could not start", str(exc))

    def on_cancel(self) -> None:
        if self.worker is not None:
            self.status.setText("Cancelling…")
            self.worker.cancel()

    def on_open_output(self) -> None:
        target = self.app.bundle_dir
        if not target.is_dir():
            target = self.app.app_dir
        subprocess.Popen(["xdg-open", str(target)], env=runenv.clean_env())

    # ── the worker ──────────────────────────────────────────────────────────

    def _start(self, command: list[str], cwd: Path, label: str) -> None:
        self.log.clear()
        self.log.appendPlainText("$ " + " ".join(command))
        self._set_running(True)

        self.worker = BuildWorker(
            command=command, cwd=cwd, env=dict(os.environ), label=label)
        self.worker.status_changed.connect(self.status.setText)
        self.worker.log_message.connect(self.log.appendPlainText)
        self.worker.job_finished.connect(self._on_finished)
        self.worker.job_failed.connect(self._on_failed)
        self.worker.job_cancelled.connect(self._on_cancelled)
        self.worker.start()

    def _set_running(self, running: bool) -> None:
        for button in (self.build_btn, self.frontend_btn, self.dev_btn):
            button.setEnabled(not running)
        self.cancel_btn.setEnabled(running)
        self.app_box.setEnabled(not running)

    def _clear_worker(self) -> None:
        self.worker = None
        self._set_running(False)
        self._show_artifacts()

    def _on_finished(self) -> None:
        self.status.setText("Done.")
        self._clear_worker()

    def _on_failed(self, message: str) -> None:
        self.status.setText("Failed.")
        self._clear_worker()
        QMessageBox.warning(self, "Build failed", message)

    def _on_cancelled(self) -> None:
        self.status.setText("Cancelled.")
        self._clear_worker()


def run(root: Path, argv: list[str]) -> int:
    from PyQt6.QtWidgets import QApplication

    app = QApplication(argv)
    app.setApplicationName(APP_NAME)
    app.setOrganizationName(ORG_NAME)
    window = BuilderWindow(root)
    window.show()
    return app.exec()
