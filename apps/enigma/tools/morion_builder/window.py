"""The Morion Builder window: build Morion, watch the log.

One app, so no app picker: the top of the window says what is being built —
Morion's name, bundle identifier, version and dev port, all read out of the
repo by `appspec` — under Morion's own icon. Below it, the package formats
this machine can actually produce, the build actions (desktop bundle, frontend
only, Android APK, dev), and the log.

Deliberately smaller than enigma's builder. That one carries feature editions,
a signing pipeline and a price table, because Enigma26 ships in editions and is
signed. Morion has none of that: it builds, it runs, and it produces a package.

The heavy lifting is `appbuilder`'s shared half — the worker that can actually
cancel a cargo build (its whole process group), the environment scrubber that
lets the result launch from a snap-poisoned parent, and the bundle-format table
that admits an .rpm built on Ubuntu will probably not run on Fedora.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from string import Template

from PyQt6.QtCore import Qt, QSettings
from PyQt6.QtGui import QIcon, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

import commands
import platforms
import runenv
import theme
import widgets
from appspec import AppSpec
from build_worker import BuildWorker

APP_NAME = "Morion Builder"
ORG_NAME = "SpectrumAI"
#: What the app bar of Morion shows; the builder wears the same mark.
ICON_FILE = "app-icon.png"
#: The ABI names `scripts/build_android.sh` accepts, most common first.
#: aarch64 is nearly every phone; x86_64 is the emulator.
ANDROID_ABIS = ("aarch64", "x86_64", "armv7", "i686", "all")


class BuilderWindow(QMainWindow):
    def __init__(self, app: AppSpec) -> None:
        super().__init__()
        self.app = app
        self.worker: BuildWorker | None = None
        self.settings = QSettings(ORG_NAME, APP_NAME)

        self.setWindowTitle(APP_NAME)
        icon = app.app_dir / ICON_FILE
        if icon.is_file():
            self.setWindowIcon(QIcon(str(icon)))
        self.resize(900, 740)
        self._apply_theme(theme.detect_system_theme())

        central = QWidget()
        self.setCentralWidget(central)
        outer = QVBoxLayout(central)
        outer.setContentsMargins(18, 18, 18, 18)
        outer.setSpacing(14)

        outer.addLayout(self._identity_row())
        outer.addLayout(self._options_row())
        outer.addLayout(self._action_row())
        outer.addLayout(self._android_row())
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

        self._restore()
        self._show_artifacts()

    def _apply_theme(self, name: str) -> None:
        """Follows the system theme and says nothing about it: one less control
        on a window whose whole job is a few buttons and a log."""
        tokens = theme.THEMES.get(name, theme.THEMES["light"])
        self.setStyleSheet(Template(theme.QSS_TEMPLATE).substitute(tokens))
        instance = QApplication.instance()
        if instance is not None:
            instance.setPalette(theme.build_palette(tokens))

    # ── the form ────────────────────────────────────────────────────────────

    def _identity_row(self) -> QHBoxLayout:
        row = QHBoxLayout()
        mark = QLabel()
        icon = self.app.app_dir / ICON_FILE
        if icon.is_file():
            mark.setPixmap(QPixmap(str(icon)).scaled(
                40, 40, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        row.addWidget(mark)
        column = QVBoxLayout()
        column.addWidget(widgets.section_title("Morion"))
        # The package name and identifier are on screen on purpose: both still
        # say Zinnia from before the rename, and the identifier is what the OS
        # files the installed app's data under — it must stay as it is.
        self.identity = widgets.hint(
            f"packaged as {self.app.product_name} · {self.app.identifier} · "
            f"v{self.app.version} · dev port {self.app.dev_port}")
        column.addWidget(self.identity)
        row.addLayout(column, 1)
        return row

    def _options_row(self) -> QHBoxLayout:
        """Package formats as CHECKBOXES, with the impossible ones disabled.

        Tauri compiles for the machine it runs on, so a .dmg is not a choice on
        Linux — it is a build that fails minutes in. Greyed out with the reason
        in the tooltip is more honest than offering it.
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
        self.debug_box.setToolTip("Far faster to build, slower to run. Applies to Android too.")
        self.debug_box.toggled.connect(self._show_artifacts)
        row.addWidget(self.debug_box)

        self.tests_box = QCheckBox("Run tests first")
        self.tests_box.setChecked(True)
        self.tests_box.setToolTip(
            "build.sh gates on Morion's own suite. Unticking skips it —\n"
            "faster, and the bundle is then unverified.")
        row.addWidget(self.tests_box)
        return row

    def _selected_targets(self) -> list[str]:
        return [k for k, box in self.target_boxes.items()
                if box.isChecked() and box.isEnabled()]

    def _action_row(self) -> QHBoxLayout:
        row = QHBoxLayout()
        self.build_btn = QPushButton("Build")
        self.build_btn.clicked.connect(lambda: self.on_build())
        row.addWidget(self.build_btn)

        self.frontend_btn = QPushButton("Frontend only")
        self.frontend_btn.setToolTip("Types and the Vite bundle, no Rust. Seconds, not minutes.")
        self.frontend_btn.clicked.connect(lambda: self.on_build(frontend_only=True))
        row.addWidget(self.frontend_btn)

        self.dev_btn = QPushButton("Run dev")
        self.dev_btn.setToolTip("Launch Morion with hot reload.")
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

    def _android_row(self) -> QHBoxLayout:
        """An APK, through scripts/build_android.sh — the same script a
        developer runs, which also copies the launcher icons in on the first
        build. Release or debug follows the Debug box above."""
        row = QHBoxLayout()
        row.addWidget(QLabel("Android"))
        self.abi_box = QComboBox()
        for abi in ANDROID_ABIS:
            self.abi_box.addItem(abi, abi)
        self.abi_box.setToolTip("Which CPU the APK is for. aarch64 covers nearly every phone;\n"
                                "x86_64 is the emulator; all builds every installed ABI.")
        row.addWidget(self.abi_box)
        self.android_btn = QPushButton("Build APK")
        self.android_btn.clicked.connect(self.on_android)
        row.addWidget(self.android_btn)
        row.addStretch(1)
        return row

    # ── state ───────────────────────────────────────────────────────────────

    def _restore(self) -> None:
        for key, box in self.target_boxes.items():
            saved = self.settings.value(f"ui/bundle/{key}")
            if saved is not None and box.isEnabled():
                box.setChecked(str(saved).lower() in ("1", "true"))
        index = self.abi_box.findData(self.settings.value("ui/abi", "aarch64"))
        if index >= 0:
            self.abi_box.setCurrentIndex(index)

    def _remember(self) -> None:
        for key, box in self.target_boxes.items():
            self.settings.setValue(f"ui/bundle/{key}", box.isChecked())
        self.settings.setValue("ui/abi", self.abi_box.currentData())

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

        self._remember()
        command = commands.desktop(
            self.app,
            debug=self.debug_box.isChecked(),
            run_tests=self.tests_box.isChecked(),
            frontend_only=frontend_only,
            bundles=targets,
        )
        self._start(command, self.app.app_dir, "Building frontend" if frontend_only else "Building")

    def on_android(self) -> None:
        if self.worker is not None:
            return
        self._remember()
        command = commands.android(
            self.app,
            build_type="debug" if self.debug_box.isChecked() else "release",
            abi_spec=self.abi_box.currentData())
        self._start(command, self.app.root, "Building the APK")

    def on_dev(self) -> None:
        """Launch dev in its own process and return at once.

        NOT through the worker: a dev server runs until it is closed, and the
        worker's contract is a command that finishes. It also needs the scrubbed
        environment — a builder started from a snap hands the app an
        LD_LIBRARY_PATH that kills it at exec.
        """
        try:
            subprocess.Popen(
                commands.dev(self.app),
                cwd=str(self.app.app_dir),
                env=runenv.clean_env(),
                start_new_session=True,
            )
            self.status.setText(f"Morion starting on port {self.app.dev_port}…")
        except OSError as exc:
            QMessageBox.warning(self, "Could not start", str(exc))

    def on_cancel(self) -> None:
        # request_cancel signals the whole process group: terminating bash
        # alone would leave cargo or gradle building unattended.
        if self.worker is not None:
            self.worker.request_cancel()

    def on_open_output(self) -> None:
        target = self.app.debug_bundle_dir() if self.debug_box.isChecked() else self.app.bundle_dir
        if not target.is_dir():
            target = self.app.app_dir
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        try:
            subprocess.Popen([opener, str(target)], env=runenv.clean_env())
        except OSError as exc:
            QMessageBox.warning(self, "Could not open", str(exc))

    # ── the worker ──────────────────────────────────────────────────────────

    def _start(self, command: list[str], cwd: Path, label: str) -> None:
        self.log.clear()
        self.log.append_line("$ " + " ".join(command))
        self._set_running(True)

        self.worker = BuildWorker(command=command, cwd=cwd, env=dict(os.environ), label=label)
        self.worker.status_changed.connect(self.status.setText)
        self.worker.log_message.connect(self.log.append_line)
        self.worker.job_finished.connect(self._on_finished)
        self.worker.job_failed.connect(self._on_failed)
        self.worker.job_cancelled.connect(self._on_cancelled)
        self.worker.start()

    def _set_running(self, running: bool) -> None:
        for button in (self.build_btn, self.frontend_btn, self.dev_btn, self.android_btn):
            button.setEnabled(not running)
        self.cancel_btn.setEnabled(running)

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

    def closeEvent(self, event) -> None:  # noqa: N802 — Qt's name
        """Closing mid-build cancels it rather than orphaning cargo."""
        if self.worker is not None:
            self.worker.request_cancel()
            self.worker.wait(15_000)
        super().closeEvent(event)


def run(app: AppSpec, argv: list[str]) -> int:
    qt = QApplication(argv)
    qt.setApplicationName(APP_NAME)
    qt.setOrganizationName(ORG_NAME)
    window = BuilderWindow(app)
    window.show()
    return qt.exec()
