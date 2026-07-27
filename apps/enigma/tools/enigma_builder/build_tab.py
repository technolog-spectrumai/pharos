"""Build tab: platform options, the pre-flight checks, and the build itself."""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

from PyQt6.QtCore import QUrl
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QRadioButton,
    QSizePolicy,
    QWidget,
)

import identity as identity_mod
import paths
import widgets
from build_worker import BuildWorker
from config_model import ConfigModel
from identity_tab import IdentityTab
from validation import errors as error_issues
from validation import warnings as warning_issues

GIB = 1024**3
# build.md:419 — the release link step is where a full target/ runs out of
# room, and it reports as a collect2 failure rather than anything code-shaped.
DISK_WARN_BYTES = 20 * GIB
FULL_BUILD_ESTIMATE = "~35 GB"

ABIS = (
    ("aarch64", "modern phones"),
    ("x86_64", "emulator"),
    ("armv7", "older 32-bit phones"),
    ("i686", "32-bit emulator"),
)

JAVA_CANDIDATES = (
    "/usr/lib/jvm/java-17-openjdk-amd64",
    "/usr/lib/jvm/java-17-openjdk",
    "/usr/lib/jvm/temurin-17-amd64",
)


def detect_android_env() -> list[tuple[str, str, bool]]:
    """Mirror build_android.sh's own detection, read-only.

    The script also sources ~/.bashrc, so it can find things this process
    cannot see — findings here warn, they never block.
    """
    report: list[tuple[str, str, bool]] = []

    java = os.environ.get("JAVA_HOME") or next(
        (c for c in JAVA_CANDIDATES if Path(c).is_dir()), ""
    )
    report.append(("JAVA_HOME", java or "not found", bool(java)))

    android = os.environ.get("ANDROID_HOME") or str(Path.home() / "Android" / "Sdk")
    android_ok = Path(android).is_dir()
    report.append(("ANDROID_HOME", android if android_ok else f"{android} (missing)", android_ok))

    ndk = os.environ.get("NDK_HOME", "")
    if not ndk and android_ok:
        ndk_dir = Path(android) / "ndk"
        if ndk_dir.is_dir():
            versions = sorted(p.name for p in ndk_dir.iterdir() if p.is_dir())
            if versions:
                ndk = str(ndk_dir / versions[-1])
    report.append(("NDK_HOME", ndk or "not found", bool(ndk)))

    for tool in ("node", "rustc"):
        found = shutil.which(tool)
        report.append((tool, found or "not on PATH", bool(found)))
    return report


def free_bytes(path: Path) -> int | None:
    """Free space on the filesystem holding ``path`` (or its nearest parent)."""
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return None


class BuildTab(QWidget):
    def __init__(self, model: ConfigModel, identity_tab: IdentityTab) -> None:
        super().__init__()
        self.model = model
        self.identity_tab = identity_tab
        self.worker: BuildWorker | None = None
        # Radio buttons emit toggled() as the options card is assembled, before
        # the later controls exist; the handler stays inert until then.
        self._ready = False
        self._blocking_errors = 0
        self._identity_written = False
        self._started_at = 0.0
        self._on_idle = None

        outer = widgets.page_layout(self)
        layout = widgets.scroll_page(outer)

        layout.addWidget(self._build_summary_card())
        layout.addWidget(self._build_options_card())
        layout.addWidget(self._build_environment_card())
        layout.addWidget(self._build_disk_card())
        layout.addWidget(self._build_artifacts_card())
        layout.addStretch()

        self.log = widgets.MonoPane("log", "Build output will appear here…", 5000)
        self.log.setMinimumHeight(160)
        # Capped rather than Expanding: the spare height belongs to the options
        # above, which is what the user is actually reading before a build.
        self.log.setMaximumHeight(300)
        self.log.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        outer.addWidget(self.log)

        action_row = QHBoxLayout()
        action_row.setSpacing(10)
        self.cancel_button = QPushButton("Cancel")
        self.cancel_button.setObjectName("secondaryButton")
        self.cancel_button.setEnabled(False)
        self.cancel_button.clicked.connect(self.request_cancel)
        self.start_button = QPushButton("Start build")
        self.start_button.setObjectName("primaryButton")
        self.start_button.clicked.connect(self._start)
        action_row.addStretch()
        action_row.addWidget(self.cancel_button)
        action_row.addWidget(self.start_button)
        outer.addLayout(action_row)

        self._ready = True
        self.refresh()

    # ----- construction ---------------------------------------------------

    def _build_summary_card(self) -> QWidget:
        frame, layout = widgets.card()
        header = QHBoxLayout()
        self.status_label = QLabel("Ready")
        self.status_label.setObjectName("status")
        header.addWidget(self.status_label)
        header.addStretch()
        self.config_badge = widgets.badge("", True)
        header.addWidget(self.config_badge)
        layout.addLayout(header)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(False)
        layout.addWidget(self.progress)

        self.summary_label = widgets.hint("")
        layout.addWidget(self.summary_label)
        self.issue_label = widgets.ErrorLabel()
        layout.addWidget(self.issue_label)
        return frame

    def _build_options_card(self) -> QWidget:
        frame, layout = widgets.card()
        layout.addWidget(widgets.section_title("Target"))

        self.platform_group = QButtonGroup(self)
        platform_row = QHBoxLayout()
        self.platform_buttons: dict[str, QRadioButton] = {}
        for key, label in (
            ("desktop", "Linux desktop"),
            ("android", "Android"),
            ("both", "Both"),
        ):
            button = QRadioButton(label)
            button.toggled.connect(self._options_changed)
            self.platform_group.addButton(button)
            self.platform_buttons[key] = button
            platform_row.addWidget(button)
        platform_row.addStretch()
        self.platform_buttons["desktop"].setChecked(True)
        layout.addLayout(platform_row)
        layout.addWidget(
            widgets.hint(
                "Desktop produces .deb / .AppImage / .rpm. Android produces an "
                "APK (plus an AAB on release) — release outputs are unsigned "
                "and need your own keystore.",
                "gateHint",
            )
        )

        self.type_group = QButtonGroup(self)
        type_row = QHBoxLayout()
        self.release_button = QRadioButton("Release")
        self.debug_button = QRadioButton("Debug")
        for button in (self.release_button, self.debug_button):
            button.toggled.connect(self._options_changed)
            self.type_group.addButton(button)
            type_row.addWidget(button)
        type_row.addStretch()
        self.release_button.setChecked(True)
        layout.addWidget(widgets.separator())
        layout.addWidget(widgets.section_title("Build type"))
        layout.addLayout(type_row)

        layout.addWidget(widgets.separator())
        layout.addWidget(widgets.section_title("Android ABIs"))
        abi_row = QHBoxLayout()
        self.abi_boxes: dict[str, QCheckBox] = {}
        for abi, note in ABIS:
            box = QCheckBox(f"{abi} ({note})")
            box.toggled.connect(self._options_changed)
            self.abi_boxes[abi] = box
            abi_row.addWidget(box)
        self.abi_boxes["aarch64"].setChecked(True)
        abi_row.addStretch()
        layout.addLayout(abi_row)
        self.abi_all = QCheckBox("all installed ABIs")
        self.abi_all.toggled.connect(self._options_changed)
        layout.addWidget(self.abi_all)

        layout.addWidget(widgets.separator())
        self.collect_box = QCheckBox(
            "Collect artifacts into apps/enigma/deploy/dist (with SHA256SUMS)"
        )
        self.collect_box.toggled.connect(self._options_changed)
        layout.addWidget(self.collect_box)
        self.collect_hint = widgets.hint("", "gateHint")
        layout.addWidget(self.collect_hint)

        self.command_label = widgets.hint("")
        layout.addWidget(self.command_label)
        return frame

    def _build_environment_card(self) -> QWidget:
        frame, layout = widgets.card(spacing=6)
        layout.addWidget(widgets.section_title("Android toolchain"))
        layout.addWidget(
            widgets.hint(
                "What this process can see. build_android.sh sources ~/.bashrc "
                "and may find more, so a warning here is not a hard stop.",
                "gateHint",
            )
        )
        self.env_rows = QWidget()
        self.env_layout = widgets.page_layout(self.env_rows)
        self.env_layout.setSpacing(4)
        layout.addWidget(self.env_rows)
        self.environment_card = frame
        return frame

    def _build_disk_card(self) -> QWidget:
        frame, layout = widgets.card()
        header = QHBoxLayout()
        header.addWidget(widgets.section_title("Disk"))
        header.addStretch()
        self.disk_badge = widgets.badge("", True)
        header.addWidget(self.disk_badge)
        layout.addLayout(header)

        self.disk_label = widgets.hint("")
        layout.addWidget(self.disk_label)

        button_row = QHBoxLayout()
        self.clean_button = QPushButton("Clean target/")
        self.clean_button.clicked.connect(self._clean_target)
        button_row.addWidget(self.clean_button)
        button_row.addStretch()
        layout.addLayout(button_row)
        return frame

    def _build_artifacts_card(self) -> QWidget:
        frame, layout = widgets.card()
        layout.addWidget(widgets.section_title("Artifacts"))
        self.artifact_label = widgets.hint("No build has finished in this session yet.")
        layout.addWidget(self.artifact_label)
        row = QHBoxLayout()
        self.open_button = QPushButton("Open output folder")
        self.open_button.setEnabled(False)
        self.open_button.clicked.connect(self._open_artifacts)
        row.addWidget(self.open_button)
        row.addStretch()
        layout.addLayout(row)
        self._artifact_dir: Path | None = None
        return frame

    # ----- options --------------------------------------------------------

    @property
    def platform(self) -> str:
        for key, button in self.platform_buttons.items():
            if button.isChecked():
                return key
        return "desktop"

    @property
    def build_type(self) -> str:
        return "debug" if self.debug_button.isChecked() else "release"

    @property
    def abi_spec(self) -> str:
        if self.abi_all.isChecked():
            return "all"
        chosen = [abi for abi, box in self.abi_boxes.items() if box.isChecked()]
        return ",".join(chosen) if chosen else "aarch64"

    @property
    def collect(self) -> bool:
        return self.collect_box.isChecked()

    def command(self) -> list[str]:
        """The exact command for the current options."""
        if self.collect or self.platform == "both":
            return [
                "bash",
                str(paths.DEPLOY_BUILD_SH),
                self.platform,
                self.build_type,
                self.abi_spec,
            ]
        if self.platform == "desktop":
            command = ["bash", str(paths.BUILD_DESKTOP_SH)]
            if self.build_type == "debug":
                command.append("--debug")
            return command
        return [
            "bash",
            str(paths.BUILD_ANDROID_SH),
            paths.APP_SLUG,
            self.build_type,
            self.abi_spec,
        ]

    def _options_changed(self) -> None:
        if not self._ready:
            return
        android = self.platform in ("android", "both")
        for box in self.abi_boxes.values():
            box.setEnabled(android and not self.abi_all.isChecked())
        self.abi_all.setEnabled(android)
        self.environment_card.setVisible(android)

        # `both` only exists in deploy/build.sh, which always collects.
        if self.platform == "both":
            self.collect_box.blockSignals(True)
            self.collect_box.setChecked(True)
            self.collect_box.blockSignals(False)
            self.collect_box.setEnabled(False)
        else:
            self.collect_box.setEnabled(True)

        notes = []
        if self.collect and self.platform != "android" and self.build_type == "debug":
            notes.append(
                "deploy/build.sh always builds the desktop leg as release — "
                "the debug choice applies to Android only."
            )
        if self.platform == "both":
            notes.append("Both targets are sequenced by deploy/build.sh, which collects.")
        self.collect_hint.setText(" ".join(notes))
        self.collect_hint.setVisible(bool(notes))

        self.command_label.setText(
            "$ ENIGMA_EDITION=custom "
            + subprocess.list2cmdline(self.command()).replace(
                str(paths.REPO_ROOT) + "/", ""
            )
        )

    # ----- refresh --------------------------------------------------------

    def refresh(self) -> None:
        issues = self.model.validate(self.identity_tab.pending_identity().as_conf_fields())
        blocking = error_issues(issues)
        warned = warning_issues(issues)
        self._blocking_errors = len(blocking)

        if blocking:
            self.config_badge.setText(f"{len(blocking)} error(s)")
            self.config_badge.setObjectName("warningBadge")
        else:
            self.config_badge.setText("config valid")
            self.config_badge.setObjectName("successBadge")
        self.config_badge.style().unpolish(self.config_badge)
        self.config_badge.style().polish(self.config_badge)

        identity_note = "identity unchanged"
        pending = self.identity_tab.pending_identity()
        if pending != identity_mod.disk_identity():
            identity_note = "tauri.conf.json will be rewritten"
        self.summary_label.setText(
            f"Config: {self.model.provenance()} · {identity_note} · "
            f"{len(warned)} warning(s)"
        )

        messages = [str(i) for i in blocking[:3]]
        if len(blocking) > 3:
            messages.append(f"…and {len(blocking) - 3} more")
        messages += [f"warning — {i}" for i in warned]
        self.issue_label.set_messages(messages)

        self._refresh_environment()
        self._refresh_disk()
        self._options_changed()
        self.start_button.setEnabled(not blocking and not self.is_busy())

    def _refresh_environment(self) -> None:
        while self.env_layout.count():
            item = self.env_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        for name, value, ok in detect_android_env():
            row = QWidget()
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(0, 0, 0, 0)
            row_layout.setSpacing(8)
            row_layout.addWidget(widgets.badge("ok" if ok else "missing", ok))
            row_layout.addWidget(widgets.hint(f"{name}: {value}", "gateHint"), 1)
            self.env_layout.addWidget(row)

    def _refresh_disk(self) -> None:
        free = free_bytes(paths.TARGET_DIR)
        if free is None:
            self.disk_badge.setText("unknown")
            self.disk_badge.setObjectName("warningBadge")
            self.disk_label.setText("Cannot read free space for src-tauri/target.")
        else:
            ok = free >= DISK_WARN_BYTES
            self.disk_badge.setText(f"{free / GIB:.0f} GB free")
            self.disk_badge.setObjectName("successBadge" if ok else "warningBadge")
            self.disk_label.setText(
                f"A full release build needs about {FULL_BUILD_ESTIMATE} on the "
                "filesystem holding src-tauri/target. Running out shows up as a "
                "collect2/linker failure at the final link, not as a code error."
            )
        self.disk_badge.style().unpolish(self.disk_badge)
        self.disk_badge.style().polish(self.disk_badge)

    # ----- running --------------------------------------------------------

    def _start(self) -> None:
        if self.is_busy():
            return
        issues = error_issues(
            self.model.validate(self.identity_tab.pending_identity().as_conf_fields())
        )
        if issues:
            QMessageBox.critical(
                self,
                paths.APP_NAME,
                "The config is not valid yet:\n\n"
                + "\n".join(f"• {i}" for i in issues[:8]),
            )
            return

        free = free_bytes(paths.TARGET_DIR)
        if free is not None and free < DISK_WARN_BYTES:
            answer = QMessageBox.question(
                self,
                paths.APP_NAME,
                f"Only {free / GIB:.1f} GB free where src-tauri/target lives.\n\n"
                f"A full release build needs about {FULL_BUILD_ESTIMATE}; running "
                "out fails at the final link. Build anyway?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if answer == QMessageBox.StandardButton.No:
                return

        if not self._apply_identity():
            return

        try:
            written = self.model.write_custom_yaml()
        except (OSError, KeyError) as exc:
            QMessageBox.critical(
                self, paths.APP_NAME, f"Cannot write the build config:\n{exc}"
            )
            return

        command = self.command()
        self.log.clear()
        self.log.append_line(f"# config: {self.model.provenance()}")
        self.log.append_line(f"# wrote {written}")
        self.log.append_line(
            "# switching editions makes cargo rebuild the crate from scratch "
            "(build.rs reruns on ENIGMA_EDITION)"
        )
        self.log.append_line(
            "$ ENIGMA_EDITION=custom " + subprocess.list2cmdline(command)
        )

        env = os.environ.copy()
        env["ENIGMA_EDITION"] = paths.CUSTOM_EDITION
        self._started_at = time.time()
        self._run(command, env, label="Building")

    def _clean_target(self) -> None:
        if self.is_busy():
            return
        answer = QMessageBox.question(
            self,
            paths.APP_NAME,
            "Run `cargo clean` for the app crate?\n\nThis deletes "
            "src-tauri/target, so the next build recompiles everything.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer == QMessageBox.StandardButton.No:
            return
        command = ["cargo", "clean", "--manifest-path", str(paths.CARGO_TOML)]
        self.log.append_line("$ " + subprocess.list2cmdline(command))
        self._started_at = time.time()
        self._run(command, os.environ.copy(), label="Cleaning")

    def _run(self, command: list[str], env: dict[str, str], label: str) -> None:
        self.worker = BuildWorker(
            command=command, cwd=paths.REPO_ROOT, env=env, label=label
        )
        self.worker.status_changed.connect(self.status_label.setText)
        self.worker.log_message.connect(self.log.append_line)
        self.worker.job_finished.connect(self._job_finished)
        self.worker.job_failed.connect(self._job_failed)
        self.worker.job_cancelled.connect(self._job_cancelled)
        self.worker.finished.connect(self._thread_finished)
        self._set_running(True)
        self.worker.start()

    def _apply_identity(self) -> bool:
        """Write the pending identity to tauri.conf.json. False = user backed out."""
        pending = self.identity_tab.pending_identity()
        current = identity_mod.disk_identity()
        self._identity_written = False
        if pending == current:
            return True

        diff = identity_mod.conf_pending_diff(current, pending)
        answer = QMessageBox.question(
            self,
            paths.APP_NAME,
            "This build changes the app identity, so tauri.conf.json will be "
            "modified in your working tree:\n\n"
            + "\n".join(f"  {line}" for line in diff)
            + "\n\nThe Builder never commits anything. Continue?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes,
        )
        if answer == QMessageBox.StandardButton.No:
            return False
        try:
            self._identity_written = identity_mod.write_identity(pending)
        except OSError as exc:
            QMessageBox.critical(
                self, paths.APP_NAME, f"Cannot write tauri.conf.json:\n{exc}"
            )
            return False
        self.log.append_line(f"# tauri.conf.json updated: {'; '.join(diff)}")
        return True

    def _restore_identity(self) -> None:
        if not self._identity_written:
            return
        if not self.identity_tab.restore_after_build.isChecked():
            self.log.append_line(
                "# tauri.conf.json left modified (restore-after-build is off)"
            )
            return
        try:
            identity_mod.write_identity(self.identity_tab.repo_identity)
        except OSError as exc:
            self.log.append_line(f"# could not restore tauri.conf.json: {exc}")
            return
        self._identity_written = False
        self.log.append_line("# tauri.conf.json restored to the committed identity")
        self.identity_tab.refresh()

    def _set_running(self, running: bool) -> None:
        # cargo and gradle give no usable percentage, so the bar is a busy
        # indicator rather than a lie about progress.
        if running:
            self.progress.setRange(0, 0)
        else:
            self.progress.setRange(0, 100)
            self.progress.setValue(0)
        self.start_button.setEnabled(not running and not self._blocking_errors)
        self.clean_button.setEnabled(not running)
        self.cancel_button.setEnabled(running)

    def _job_finished(self) -> None:
        self.status_label.setText("Complete")
        self._restore_identity()
        self._show_artifacts()

    def _job_failed(self, message: str) -> None:
        self.status_label.setText("Failed")
        self._restore_identity()
        QMessageBox.critical(self, "Build failed", message)

    def _job_cancelled(self) -> None:
        self.status_label.setText("Cancelled")
        self.log.append_line("Build cancelled.")
        self._restore_identity()

    def _thread_finished(self) -> None:
        self._set_running(False)
        if self.worker:
            self.worker.deleteLater()
            self.worker = None
        self.refresh()
        if self._on_idle is not None:
            callback, self._on_idle = self._on_idle, None
            callback()

    # ----- artifacts ------------------------------------------------------

    def _show_artifacts(self) -> None:
        found: list[Path] = []
        directories: list[Path] = []

        if self.collect:
            directories.append(paths.DEPLOY_DIST)
        if self.platform in ("desktop", "both"):
            directories.append(paths.TARGET_DIR / self.build_type / "bundle")
        if self.platform in ("android", "both"):
            directories.append(paths.ANDROID_OUTPUTS)

        patterns = ("*.deb", "*.AppImage", "*.rpm", "*.apk", "*.aab", "SHA256SUMS")
        for directory in directories:
            if not directory.is_dir():
                continue
            for pattern in patterns:
                for path in directory.rglob(pattern):
                    # gen/android keeps every previous build; only show this one.
                    if path.is_file() and path.stat().st_mtime >= self._started_at - 1:
                        found.append(path)

        if not found:
            self.artifact_label.setText(
                "The build finished but no new artifacts were found in the "
                "expected output directories."
            )
            self.open_button.setEnabled(False)
            return

        found.sort()
        lines = [
            f"{path.name}  ({path.stat().st_size / (1024 * 1024):.1f} MB)\n"
            f"    {path.parent}"
            for path in found
        ]
        self.artifact_label.setText("\n".join(lines))
        self._artifact_dir = found[0].parent
        self.open_button.setEnabled(True)

    def _open_artifacts(self) -> None:
        if self._artifact_dir is not None:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(self._artifact_dir)))

    # ----- lifecycle ------------------------------------------------------

    def is_busy(self) -> bool:
        return self.worker is not None and self.worker.isRunning()

    def request_cancel(self) -> None:
        if self.worker and self.worker.isRunning():
            self.cancel_button.setEnabled(False)
            self.log.append_line("Cancellation requested — signalling the process group…")
            self.worker.request_cancel()

    def cancel_for_close(self, callback) -> None:
        """Cancel, then run ``callback`` once the worker has actually stopped.

        cargo and gradle can take several seconds to unwind, which is too long
        to block the GUI thread on, so the close is deferred instead.
        """
        self._on_idle = callback
        self.request_cancel()
