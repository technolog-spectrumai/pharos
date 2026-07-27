"""Build tab: platform options, the pre-flight checks, and the build itself."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from PyQt6.QtCore import QUrl, pyqtSignal
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QRadioButton,
    QSizePolicy,
    QWidget,
)

import appdata
import bundles
import icons as icons_mod
import identity as identity_mod
import paths
import widgets
from build_worker import BuildWorker
from config_model import ConfigModel
from identity_tab import IdentityTab
from validation import errors as error_issues
from validation import warnings as warning_issues


@dataclass
class Step:
    """One command in a build. Steps run in order and stop at the first failure."""

    command: list[str]
    cwd: Path
    label: str
    env: dict[str, str] = field(default_factory=dict)
    #: Runs on this step's success, before the next step starts. Returns a log
    #: line, or None for nothing to say.
    after: Callable[[], str | None] | None = None


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
    #: Emitted when the user picks a different Enigma checkout to build.
    repo_root_changed = pyqtSignal(object)
    #: Emitted when the output folder changes, so the window can persist it.
    output_dir_changed = pyqtSignal(str)

    def __init__(self, model: ConfigModel, identity_tab: IdentityTab) -> None:
        super().__init__()
        self.model = model
        self.identity_tab = identity_tab
        self.worker: BuildWorker | None = None
        # Radio buttons emit toggled() as the options card is assembled, before
        # the later controls exist; the handler stays inert until then.
        self._ready = False
        self._blocking_errors = 0
        self._conf_snapshot = ""
        self._started_at = 0.0
        self._on_idle = None
        self._steps: list[Step] = []
        self._step_index = 0
        self._step_ok = False
        self._failure = ""
        self._cancelled = False
        self._icon_snapshot: dict[Path, bytes] = {}

        outer = widgets.page_layout(self)
        layout = widgets.scroll_page(outer)

        layout.addWidget(self._build_repo_card())
        layout.addWidget(self._build_summary_card())
        layout.addWidget(self._build_options_card())
        layout.addWidget(self._build_environment_card())
        layout.addWidget(self._build_disk_card())
        layout.addWidget(self._build_appdata_card())
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

    def _build_repo_card(self) -> QWidget:
        frame, layout = widgets.card()
        header = QHBoxLayout()
        header.addWidget(widgets.section_title("Enigma repository"))
        header.addStretch()
        self.repo_badge = widgets.badge("", True)
        header.addWidget(self.repo_badge)
        layout.addLayout(header)

        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(8)
        self.repo_edit = QLineEdit()
        self.repo_edit.setPlaceholderText("Path to an Enigma checkout…")
        self.repo_edit.setClearButtonEnabled(True)
        self.repo_edit.editingFinished.connect(self._repo_typed)
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse_repo)
        row.addWidget(self.repo_edit, 1)
        row.addWidget(browse)
        layout.addLayout(row)

        layout.addWidget(
            widgets.hint(
                "The checkout this tool configures and builds. Found "
                "automatically when the Builder sits inside a repo; set it "
                "yourself when running the standalone binary.",
                "gateHint",
            )
        )
        return frame

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
                "Desktop produces a package per distribution chosen below. "
                "Android produces an APK (plus an AAB on release) — release "
                "outputs are unsigned and need your own keystore.",
                "gateHint",
            )
        )

        layout.addWidget(widgets.separator())
        layout.addWidget(widgets.section_title("Target distribution"))
        distro_row = QHBoxLayout()
        self.distro_boxes: dict[str, QCheckBox] = {}
        for key in bundles.KEYS:
            box = QCheckBox(bundles.label(key))
            box.setChecked(key in bundles.DEFAULT)
            box.toggled.connect(self._options_changed)
            self.distro_boxes[key] = box
            distro_row.addWidget(box)
        distro_row.addStretch()
        layout.addLayout(distro_row)
        self.distro_hint = widgets.hint("", "gateHint")
        layout.addWidget(self.distro_hint)

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
        layout.addWidget(widgets.section_title("Output folder"))
        self.collect_box = QCheckBox(
            "Copy the finished artifacts here (with SHA256SUMS)"
        )
        self.collect_box.setChecked(True)
        self.collect_box.toggled.connect(self._options_changed)
        layout.addWidget(self.collect_box)

        output_row = QHBoxLayout()
        output_row.setContentsMargins(0, 0, 0, 0)
        output_row.setSpacing(8)
        self.output_edit = QLineEdit()
        self.output_edit.setPlaceholderText("Where to put the built files…")
        self.output_edit.setClearButtonEnabled(True)
        self.output_edit.textChanged.connect(self._output_edited)
        self.output_browse = QPushButton("Browse…")
        self.output_browse.clicked.connect(self._browse_output)
        self.output_reset = widgets.link_button("default", self._reset_output)
        output_row.addWidget(self.output_edit, 1)
        output_row.addWidget(self.output_browse)
        output_row.addWidget(self.output_reset)
        layout.addLayout(output_row)

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

    def _build_appdata_card(self) -> QWidget:
        frame, layout = widgets.card()
        header = QHBoxLayout()
        header.addWidget(widgets.section_title("Local app data"))
        header.addStretch()
        self.appdata_badge = widgets.badge("", True)
        header.addWidget(self.appdata_badge)
        layout.addLayout(header)

        self.appdata_label = widgets.hint("")
        layout.addWidget(self.appdata_label)
        layout.addWidget(
            widgets.hint(
                "The vault lives outside the build, under the bundle "
                "identifier, so a rebuild keeps the previous passphrase, rooms "
                "and files. Clear it to get a genuine first run.",
                "gateHint",
            )
        )

        row = QHBoxLayout()
        row.setSpacing(8)
        self.appdata_combo = QComboBox()
        self.appdata_combo.setMinimumWidth(320)
        self.clear_data_button = QPushButton("Clear app data…")
        self.clear_data_button.clicked.connect(self._clear_app_data)
        row.addWidget(self.appdata_combo, 1)
        row.addWidget(self.clear_data_button)
        layout.addLayout(row)
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
    def distros(self) -> list[str]:
        return [k for k, box in self.distro_boxes.items() if box.isChecked()]

    @property
    def collect(self) -> bool:
        return self.collect_box.isChecked()

    @property
    def output_dir(self) -> Path:
        text = self.output_edit.text().strip()
        return Path(text).expanduser() if text else paths.default_output_dir()

    def command(self) -> list[str]:
        """The exact command for the current options.

        Copying to the output folder is done afterwards, in Python, so the
        choice of folder never changes which script runs. Only `both` needs
        deploy/build.sh, because that script is what sequences the two legs.
        """
        if self.platform == "both":
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
        if not self._blocking_errors:
            self.start_button.setEnabled(not self.is_busy() and self._targets_chosen())
        android = self.platform in ("android", "both")
        desktop = self.platform in ("desktop", "both")
        for box in self.abi_boxes.values():
            box.setEnabled(android and not self.abi_all.isChecked())
        self.abi_all.setEnabled(android)
        self.environment_card.setVisible(android)
        for box in self.distro_boxes.values():
            box.setEnabled(desktop)

        distro_notes = []
        if desktop and not self.distros:
            distro_notes.append(
                "Choose at least one distribution — otherwise the desktop build "
                "produces no package."
            )
        elif desktop:
            warning = bundles.cross_build_warning(self.distros)
            if warning:
                distro_notes.append("⚠ " + warning)
        self.distro_hint.setText(" ".join(distro_notes))
        self.distro_hint.setVisible(bool(distro_notes))

        for widget in (self.output_edit, self.output_browse, self.output_reset):
            widget.setEnabled(self.collect)

        notes = []
        if self.platform == "both" and self.build_type == "debug":
            notes.append(
                "deploy/build.sh sequences both legs but always builds the "
                "desktop bundle as release — the debug choice applies to "
                "Android only."
            )
        if self.collect and self.output_dir.resolve() == paths.DEPLOY_DIST.resolve():
            notes.append(
                "Default folder: apps/enigma/deploy/dist (already gitignored)."
            )
        self.collect_hint.setText(" ".join(notes))
        self.collect_hint.setVisible(bool(notes))

        self.command_label.setText(
            "$ ENIGMA_EDITION=custom "
            + subprocess.list2cmdline(self.command()).replace(
                str(paths.REPO_ROOT) + "/", ""
            )
        )

    # ----- repository and output folder -----------------------------------

    def _browse_repo(self) -> None:
        start = str(paths.REPO_ROOT if paths.have_repo() else Path.home())
        chosen = QFileDialog.getExistingDirectory(
            self, "Choose an Enigma checkout", start
        )
        if chosen:
            self.set_repo_path(Path(chosen))

    def _repo_typed(self) -> None:
        text = self.repo_edit.text().strip()
        if text and Path(text).expanduser() != paths.REPO_ROOT:
            self.set_repo_path(Path(text).expanduser())

    def set_repo_path(self, root: Path) -> None:
        """Repoint the whole tool at ``root``, if it really is a checkout."""
        root = root.expanduser()
        if not paths.is_repo(root):
            QMessageBox.warning(
                self,
                paths.APP_NAME,
                f"{root}\n\nis not an Enigma checkout — expected to find\n"
                f"{paths.MARKER} inside it.",
            )
            self.refresh_repo()
            return
        self.repo_root_changed.emit(root)

    def refresh_repo(self) -> None:
        """Sync the repository row and badge with whatever paths now resolve to."""
        found = paths.have_repo()
        text = str(paths.REPO_ROOT) if found else ""
        if self.repo_edit.text() != text:
            self.repo_edit.blockSignals(True)
            self.repo_edit.setText(text)
            self.repo_edit.blockSignals(False)
        self.repo_badge.setText("found" if found else "not set")
        self.repo_badge.setObjectName("successBadge" if found else "warningBadge")
        self.repo_badge.style().unpolish(self.repo_badge)
        self.repo_badge.style().polish(self.repo_badge)

    def _browse_output(self) -> None:
        chosen = QFileDialog.getExistingDirectory(
            self, "Choose an output folder", str(self.output_dir)
        )
        if chosen:
            self.output_edit.setText(chosen)

    def _reset_output(self) -> None:
        self.output_edit.setText(str(paths.default_output_dir()))

    def _output_edited(self) -> None:
        self.output_dir_changed.emit(self.output_edit.text().strip())
        self._options_changed()

    def set_output_dir(self, path: str) -> None:
        if self.output_edit.text() != path:
            self.output_edit.blockSignals(True)
            self.output_edit.setText(path)
            self.output_edit.blockSignals(False)
        self._options_changed()

    # ----- refresh --------------------------------------------------------

    def refresh(self) -> None:
        self.refresh_repo()
        if not self.model.ready:
            self.config_badge.setText("no repository")
            self.config_badge.setObjectName("warningBadge")
            self.config_badge.style().unpolish(self.config_badge)
            self.config_badge.style().polish(self.config_badge)
            self.summary_label.setText(
                "Point the Builder at an Enigma checkout above to get started."
            )
            self.issue_label.set_messages([])
            self.start_button.setEnabled(False)
            self.clean_button.setEnabled(False)
            self._refresh_appdata()
            return
        self.clean_button.setEnabled(not self.is_busy())

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
        self._refresh_appdata()
        self._options_changed()
        self.start_button.setEnabled(
            not blocking and not self.is_busy() and self._targets_chosen()
        )

    def _targets_chosen(self) -> bool:
        """A desktop build with no distribution ticked would produce nothing."""
        return self.platform == "android" or bool(self.distros)

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

    # ----- local app data -------------------------------------------------

    def _identifier(self) -> str:
        """The identifier the built app will store its data under."""
        return str(self.identity_tab.pending_identity().identifier or "")

    def _refresh_appdata(self) -> None:
        identifier = self._identifier()
        found = appdata.targets(identifier)

        previous = self.appdata_combo.currentData()
        self.appdata_combo.blockSignals(True)
        self.appdata_combo.clear()
        for target in found:
            self.appdata_combo.addItem(
                f"{target.label} — {appdata.human_size(target.size)}", target
            )
        if previous is not None:
            for index in range(self.appdata_combo.count()):
                if self.appdata_combo.itemData(index).key == previous.key:
                    self.appdata_combo.setCurrentIndex(index)
                    break
        self.appdata_combo.blockSignals(False)

        has_any = bool(found)
        self.appdata_combo.setEnabled(has_any and not self.is_busy())
        self.clear_data_button.setEnabled(has_any and not self.is_busy())

        vault = appdata.has_vault(identifier, "default")
        self.appdata_badge.setText("vault present" if vault else "clean")
        self.appdata_badge.setObjectName("warningBadge" if vault else "successBadge")
        self.appdata_badge.style().unpolish(self.appdata_badge)
        self.appdata_badge.style().polish(self.appdata_badge)
        self.appdata_label.setText(appdata.summary(identifier))

    def _clear_app_data(self) -> None:
        target = self.appdata_combo.currentData()
        if target is None:
            return

        contents = (
            "the vault, rooms, chat history, transferred files and map regions"
            if target.has_vault
            else "cached state for the app"
        )
        answer = QMessageBox.warning(
            self,
            paths.APP_NAME,
            f"Clear local app data so the next launch starts fresh?\n\n"
            f"{target.path}\n"
            f"{appdata.human_size(target.size)} — {contents}\n\n"
            f"This is MOVED ASIDE, not deleted: it is renamed with a "
            f"“.cleared-<timestamp>” suffix beside itself, so the app starts "
            f"with passphrase setup and you can still get the data back. "
            f"Delete that folder yourself once you are sure.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return

        try:
            aside = appdata.remove(self._identifier(), target.path)
        except (OSError, ValueError) as exc:
            QMessageBox.critical(
                self, paths.APP_NAME, f"Could not clear the app data:\n{exc}"
            )
            self._refresh_appdata()
            return

        self.log.append_line(
            f"# cleared app data ({appdata.human_size(target.size)}): "
            f"{target.path} → {aside}"
        )
        self.log.append_line(
            f"# recover with: mv {aside} {target.path}  ·  "
            f"delete for good with: rm -rf {aside}"
        )
        QMessageBox.information(
            self,
            paths.APP_NAME,
            f"The next launch will start with passphrase setup.\n\n"
            f"Your old data is still on disk at:\n{aside}\n\n"
            f"Restore it with:\n  mv {aside} {target.path}",
        )
        self._refresh_appdata()

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

        icon_source = self.identity_tab.pending_icon()
        if icon_source is not None and not self._confirm_icon(icon_source):
            return

        # Cleared here, before anything writes: the steps below log what they
        # change to disk, and clearing afterwards would erase exactly the lines
        # that say the working tree was touched.
        self.log.clear()

        if not self._apply_conf():
            return

        try:
            written = self.model.write_custom_yaml()
        except (OSError, KeyError) as exc:
            QMessageBox.critical(
                self, paths.APP_NAME, f"Cannot write the build config:\n{exc}"
            )
            return

        self.log.append_line(f"# config: {self.model.provenance()}")
        self.log.append_line(f"# wrote {written}")
        self.log.append_line(
            "# switching editions makes cargo rebuild the crate from scratch "
            "(build.rs reruns on ENIGMA_EDITION)"
        )

        env = os.environ.copy()
        env["ENIGMA_EDITION"] = paths.CUSTOM_EDITION

        steps: list[Step] = []
        if icon_source is not None:
            self._icon_snapshot = icons_mod.snapshot()
            self.log.append_line(
                f"# icon: {icon_source} → {len(self._icon_snapshot)} generated "
                f"file(s) will be replaced and restored afterwards"
            )
            self.log.append_line(f"# if this run dies mid-way: {icons_mod.recovery_hint()}")
            steps.append(
                Step(
                    command=icons_mod.icon_command(icon_source),
                    cwd=paths.APP_DIR,
                    label="Generating icons",
                    env=os.environ.copy(),
                    after=self._sync_android_icons,
                )
            )

        steps.append(
            Step(
                command=self.command(),
                cwd=paths.REPO_ROOT,
                label="Building",
                env=env,
            )
        )

        self._started_at = time.time()
        self._run_queue(steps)

    def _confirm_icon(self, source: Path) -> bool:
        errors, _warnings = icons_mod.validate_source(source)
        if errors:
            QMessageBox.critical(
                self,
                paths.APP_NAME,
                "That icon cannot be used:\n\n" + "\n".join(f"• {e}" for e in errors),
            )
            return False
        answer = QMessageBox.question(
            self,
            paths.APP_NAME,
            "This build regenerates the app icons, which rewrites the tracked "
            "files under src-tauri/icons and the Android launcher in "
            "src-tauri/gen.\n\nThey are restored when the build finishes "
            "(unless you turned that off on the Identity tab). Continue?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes,
        )
        return answer == QMessageBox.StandardButton.Yes

    def _sync_android_icons(self) -> str | None:
        """Copy the freshly generated mipmaps into the Gradle project.

        `tauri icon` only writes icons/android/; the generated project keeps
        its own copy from `android init` and would otherwise ship the old
        launcher.
        """
        copied = icons_mod.sync_android_icons()
        if not copied:
            return (
                "# no src-tauri/gen/android yet — its launcher icons will be "
                "taken from icons/android at `tauri android init`"
            )
        return f"# copied {copied} launcher icon file(s) into src-tauri/gen/android"

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
        self._started_at = time.time()
        self._run_queue(
            [
                Step(
                    command=["cargo", "clean", "--manifest-path", str(paths.CARGO_TOML)],
                    cwd=paths.REPO_ROOT,
                    label="Cleaning",
                    env=os.environ.copy(),
                )
            ]
        )

    def _run_queue(self, steps: list[Step]) -> None:
        self._steps = steps
        self._step_index = 0
        self._step_ok = False
        self._set_running(True)
        self._run_step()

    def _run_step(self) -> None:
        step = self._steps[self._step_index]
        if len(self._steps) > 1:
            self.log.append_line(
                f"# step {self._step_index + 1}/{len(self._steps)}: {step.label}"
            )
        prefix = (
            "ENIGMA_EDITION=custom "
            if step.env.get("ENIGMA_EDITION") == paths.CUSTOM_EDITION
            else ""
        )
        self.log.append_line("$ " + prefix + subprocess.list2cmdline(step.command))

        self.worker = BuildWorker(
            command=step.command, cwd=step.cwd, env=step.env, label=step.label
        )
        self.worker.status_changed.connect(self.status_label.setText)
        self.worker.log_message.connect(self.log.append_line)
        self.worker.job_finished.connect(self._job_finished)
        self.worker.job_failed.connect(self._job_failed)
        self.worker.job_cancelled.connect(self._job_cancelled)
        self.worker.finished.connect(self._thread_finished)
        self.worker.start()

    def _apply_conf(self) -> bool:
        """Write the build's identity and target distributions to tauri.conf.json.

        Both edits land in one file, so the original text is snapshotted whole
        and restored verbatim afterwards — no field-by-field undo that could
        drift. Returns False if the user backed out.
        """
        self._conf_snapshot = ""
        original = identity_mod.read_conf_text()
        conf = identity_mod.read_conf()
        if not conf:
            QMessageBox.critical(
                self, paths.APP_NAME, f"Cannot read {paths.TAURI_CONF}"
            )
            return False

        pending = self.identity_tab.pending_identity()
        identity_mod.apply_identity(conf, pending)
        if self.platform in ("desktop", "both"):
            bundles.apply_to_config(conf, self.distros)

        updated = identity_mod.render_conf(conf)
        if updated == original:
            return True

        changes = identity_mod.conf_pending_diff(
            identity_mod.Identity.from_conf(identity_mod.read_conf()), pending
        )
        before = bundles.read_from_config(identity_mod.read_conf())
        if self.platform in ("desktop", "both") and before != self.distros:
            changes.append(
                "bundle.targets: "
                f"{bundles.to_config_value(before)} → "
                f"{bundles.to_config_value(self.distros)}"
            )

        answer = QMessageBox.question(
            self,
            paths.APP_NAME,
            "This build modifies tauri.conf.json in your working tree:\n\n"
            + "\n".join(f"  {line}" for line in changes)
            + "\n\nIt is restored when the build finishes. The Builder never "
            "commits anything. Continue?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes,
        )
        if answer == QMessageBox.StandardButton.No:
            return False

        try:
            identity_mod.write_conf_text(updated)
        except OSError as exc:
            QMessageBox.critical(
                self, paths.APP_NAME, f"Cannot write tauri.conf.json:\n{exc}"
            )
            return False

        self._conf_snapshot = original
        self.log.append_line(f"# tauri.conf.json: {'; '.join(changes)}")
        return True

    def _restore_conf(self) -> None:
        if not self._conf_snapshot:
            return
        if not self.identity_tab.restore_after_build.isChecked():
            self.log.append_line(
                "# tauri.conf.json left modified (restore-after-build is off)"
            )
            self._conf_snapshot = ""
            return
        try:
            identity_mod.write_conf_text(self._conf_snapshot)
        except OSError as exc:
            self.log.append_line(f"# could not restore tauri.conf.json: {exc}")
            return
        self._conf_snapshot = ""
        self.log.append_line("# tauri.conf.json restored")
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
        # Deleting the vault out from under a running build would be a bad
        # surprise; otherwise this is available whether or not you ever build.
        self.clear_data_button.setEnabled(not running)
        self.appdata_combo.setEnabled(not running)
        self.cancel_button.setEnabled(running)

    def _job_finished(self) -> None:
        step = self._steps[self._step_index]
        if step.after is not None:
            try:
                note = step.after()
            except Exception as exc:  # a post-step must not strand the queue
                self._failure = f"{step.label}: {type(exc).__name__}: {exc}"
                self.status_label.setText("Failed")
                return
            if note:
                self.log.append_line(note)
        self._step_ok = True

    def _job_failed(self, message: str) -> None:
        self._failure = message
        self.status_label.setText("Failed")

    def _job_cancelled(self) -> None:
        self._cancelled = True
        self.status_label.setText("Cancelled")
        self.log.append_line("Build cancelled.")

    def _thread_finished(self) -> None:
        if self.worker:
            self.worker.deleteLater()
            self.worker = None

        more = self._step_index + 1 < len(self._steps)
        if self._step_ok and not self._failure and not self._cancelled and more:
            self._step_index += 1
            self._step_ok = False
            self._run_step()
            return

        self._set_running(False)
        self._finish_run()

        self.refresh()
        if self._on_idle is not None:
            callback, self._on_idle = self._on_idle, None
            callback()

    def _finish_run(self) -> None:
        """Undo what the run changed on disk, then report the result.

        Runs on every ending — success, failure and cancellation — because a
        half-finished icon regeneration leaves the working tree dirty just as
        surely as a successful one.
        """
        failure, cancelled = self._failure, self._cancelled
        self._failure, self._cancelled = "", False

        self._restore_conf()
        self._restore_icons()

        if cancelled:
            return
        if failure:
            QMessageBox.critical(self, "Build failed", failure)
            return

        self.status_label.setText("Complete")
        self._show_artifacts()

    def _restore_icons(self) -> None:
        if not self._icon_snapshot:
            return
        if not self.identity_tab.restore_after_build.isChecked():
            self.log.append_line(
                "# generated icons left in place (restore-after-build is off) — "
                f"undo with: {icons_mod.recovery_hint()}"
            )
            self._icon_snapshot = {}
            return
        restored = icons_mod.restore(self._icon_snapshot)
        self._icon_snapshot = {}
        self.log.append_line(f"# restored {restored} icon file(s) to the committed set")

    # ----- artifacts ------------------------------------------------------

    def _copy_artifacts(self, found: list[Path]) -> list[Path]:
        """Copy the build's output into the chosen folder, with SHA256SUMS.

        Done here rather than by deploy/build.sh so that the folder choice is
        independent of which script ran. Android files get the app prefix the
        deploy script would have given them — Tauri's `app-universal-*.apk`
        names are otherwise indistinguishable between builds.
        """
        dest = self.output_dir
        try:
            dest.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            self.log.append_line(f"# cannot create {dest}: {exc}")
            return found

        copied: list[Path] = []
        for path in found:
            name = path.name
            if path.suffix.lower() in (".apk", ".aab") and name.startswith("app-"):
                name = f"{paths.APP_SLUG}-{name[len('app-'):]}"
            target = dest / name
            try:
                if path.resolve() == target.resolve():
                    copied.append(target)
                    continue
                shutil.copy2(path, target)
            except OSError as exc:
                self.log.append_line(f"# could not copy {path.name}: {exc}")
                continue
            copied.append(target)

        if not copied:
            return found

        try:
            lines = []
            for path in sorted(copied):
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                lines.append(f"{digest}  {path.name}")
            (dest / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
        except OSError as exc:
            self.log.append_line(f"# could not write SHA256SUMS: {exc}")

        self.log.append_line(f"# copied {len(copied)} artifact(s) to {dest}")
        return copied

    def _show_artifacts(self) -> None:
        found: list[Path] = []
        directories: list[Path] = []

        if self.platform == "both":
            # deploy/build.sh has already gathered both legs here under
            # self-identifying names; scanning the sources too would find every
            # file twice, once under Tauri's generic `app-*` name.
            directories.append(paths.DEPLOY_DIST)
        elif self.platform == "desktop":
            directories.append(paths.TARGET_DIR / self.build_type / "bundle")
        else:
            directories.append(paths.ANDROID_OUTPUTS)

        # SHA256SUMS is deliberately absent: we regenerate it for whatever
        # actually lands in the output folder.
        patterns: list[str] = []
        if self.platform in ("desktop", "both"):
            patterns += bundles.globs(self.distros)
        if self.platform in ("android", "both"):
            patterns += ["*.apk", "*.aab"]
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

        found = sorted({p.resolve() for p in found})
        if self.collect:
            found = self._copy_artifacts(found)
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
