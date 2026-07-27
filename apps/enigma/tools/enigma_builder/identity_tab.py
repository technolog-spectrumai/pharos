"""Identity tab: the app name, bundle identifier and version.

These three live in two files at once — ``tauri.conf.json`` (authoritative for
the native bundle) and the build config's ``app:`` section — and build.rs
asserts they are equal. The form edits both together, and only writes
tauri.conf.json at build time, so trying out a name never dirties the tree.
"""

from __future__ import annotations

from pathlib import Path

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import (
    QCheckBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

import icons as icons_mod
import identity as identity_mod
import paths
import widgets
from config_model import ConfigModel
from identity import Identity
from validation import Issue, issues_for

PREVIEW_SIDE = 96


class IdentityTab(QWidget):
    def __init__(self, model: ConfigModel) -> None:
        super().__init__()
        self.model = model
        self._syncing = False

        self.launch_identity = identity_mod.disk_identity()
        self.repo_identity = self.launch_identity
        self.reload_repo_identity()

        outer = widgets.page_layout(self)
        layout = widgets.scroll_page(outer)

        layout.addWidget(self._build_form_card())
        layout.addWidget(self._build_icon_card())
        layout.addWidget(self._build_status_card())
        layout.addStretch()

        self.refresh()

    # ----- construction ---------------------------------------------------

    def _build_form_card(self) -> QWidget:
        frame, form = widgets.form_card()

        self.name_edit = QLineEdit()
        self.name_edit.setPlaceholderText("Enigma")
        self.identifier_edit = QLineEdit()
        self.identifier_edit.setPlaceholderText("com.example.enigma")
        self.version_edit = QLineEdit()
        self.version_edit.setPlaceholderText("0.1.0")

        for field, edit in (
            ("name", self.name_edit),
            ("identifier", self.identifier_edit),
            ("version", self.version_edit),
        ):
            edit.textChanged.connect(lambda text, f=field: self._set(f, text))

        form.addRow("Product name", self.name_edit)
        form.addRow("", widgets.hint("Window title and bundle name.", "gateHint"))
        form.addRow("Identifier", self.identifier_edit)
        form.addRow(
            "",
            widgets.hint(
                "Reverse-DNS bundle id, [a-zA-Z0-9.-] only. Two builds sharing "
                "an identifier cannot be installed side by side.",
                "gateHint",
            ),
        )
        form.addRow("Version", self.version_edit)

        self.form_error = widgets.ErrorLabel()
        form.addRow("", self.form_error)
        return frame

    def _build_icon_card(self) -> QWidget:
        frame, layout = widgets.card()
        layout.addWidget(widgets.section_title("App icon"))
        layout.addWidget(
            widgets.hint(
                "One square source image, from which Tauri generates every "
                "size: the .deb / .AppImage / .rpm icon and the Android "
                "launcher. Leave it empty to keep the icons already in the "
                "repo."
            )
        )

        row = QHBoxLayout()
        row.setSpacing(16)

        preview_column = QVBoxLayout()
        preview_column.setSpacing(4)
        self.icon_preview = QLabel()
        self.icon_preview.setFixedSize(PREVIEW_SIDE, PREVIEW_SIDE)
        self.icon_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.icon_caption = widgets.hint("", "gateHint")
        self.icon_caption.setAlignment(Qt.AlignmentFlag.AlignCenter)
        preview_column.addWidget(self.icon_preview)
        preview_column.addWidget(self.icon_caption)
        preview_column.addStretch()
        row.addLayout(preview_column)

        controls = QVBoxLayout()
        controls.setSpacing(8)
        picker = QHBoxLayout()
        picker.setSpacing(8)
        self.icon_edit = QLineEdit()
        self.icon_edit.setPlaceholderText("Keep the icons already in the repo")
        self.icon_edit.setClearButtonEnabled(True)
        self.icon_edit.textChanged.connect(self._icon_changed)
        icon_browse = QPushButton("Choose image…")
        icon_browse.clicked.connect(self._browse_icon)
        picker.addWidget(self.icon_edit, 1)
        picker.addWidget(icon_browse)
        controls.addLayout(picker)

        controls.addWidget(
            widgets.hint(
                f"Square PNG or SVG, at least {icons_mod.MIN_SIDE}px — "
                f"{icons_mod.RECOMMENDED_SIDE}px recommended. Transparency is "
                "preserved.",
                "gateHint",
            )
        )
        self.icon_error = widgets.ErrorLabel()
        controls.addWidget(self.icon_error)
        self.icon_note = widgets.hint("", "gateHint")
        controls.addWidget(self.icon_note)
        controls.addStretch()
        row.addLayout(controls, 1)

        layout.addLayout(row)
        return frame

    def _build_status_card(self) -> QWidget:
        frame, layout = widgets.card()

        header = QHBoxLayout()
        header.addWidget(widgets.section_title("tauri.conf.json"))
        header.addStretch()
        self.state_badge = widgets.badge("", True)
        header.addWidget(self.state_badge)
        layout.addLayout(header)

        self.state_detail = widgets.hint("")
        layout.addWidget(self.state_detail)

        self.restore_button = widgets.link_button(
            "Restore repo identity", self._restore_repo_identity
        )
        self.restore_button.hide()
        restore_row = QHBoxLayout()
        restore_row.addWidget(self.restore_button)
        restore_row.addStretch()
        layout.addLayout(restore_row)

        self.restore_after_build = QCheckBox(
            "Restore identity and icons after every build"
        )
        self.restore_after_build.setChecked(True)
        layout.addWidget(self.restore_after_build)
        layout.addWidget(
            widgets.hint(
                "Puts the committed values back once the build finishes — this "
                "file and, if the icon was replaced, everything under "
                "src-tauri/icons and the Android launcher. So "
                "`ENIGMA_EDITION=pro ./build_desktop.sh` keeps working straight "
                "afterwards. The Builder never commits anything.",
                "gateHint",
            )
        )

        self.android_warning = widgets.hint("", "gateHint")
        self.android_warning.hide()
        layout.addWidget(self.android_warning)
        return frame

    # ----- behavior -------------------------------------------------------

    # ----- icon -----------------------------------------------------------

    def pending_icon(self) -> Path | None:
        """The source image this build should regenerate icons from, if any."""
        text = self.icon_edit.text().strip()
        return Path(text).expanduser() if text else None

    def _browse_icon(self) -> None:
        start = self.icon_edit.text().strip() or str(Path.home())
        chosen, _filter = QFileDialog.getOpenFileName(
            self, "Choose an app icon", start, "Images (*.png *.svg)"
        )
        if chosen:
            self.icon_edit.setText(chosen)

    def _icon_changed(self) -> None:
        self._refresh_icon()

    def _refresh_icon(self) -> None:
        source = self.pending_icon()

        if source is None:
            existing = icons_mod.preview_icon()
            self._set_preview(existing)
            self.icon_caption.setText("current" if existing else "no icon found")
            self.icon_error.set_messages([])
            self.icon_note.setText("")
            self.icon_note.hide()
            return

        errors, warnings_ = icons_mod.validate_source(source)
        self.icon_error.set_messages(errors)
        self._set_preview(None if errors else source)
        self.icon_caption.setText("new" if not errors else "unusable")

        notes = list(warnings_)
        if not errors:
            notes.append(
                "Applied at build time, then the generated files are restored "
                "— nothing is written until you press Start build."
            )
            if not paths.ANDROID_GEN.is_dir():
                notes.append(
                    "No Android project yet, so only the desktop icons change "
                    "for now."
                )
        self.icon_note.setText(" ".join(notes))
        self.icon_note.setVisible(bool(notes))

    def _set_preview(self, path: Path | None) -> None:
        if path is None or not path.is_file():
            self.icon_preview.clear()
            self.icon_preview.setText("—")
            return
        pixmap = QPixmap(str(path))
        if pixmap.isNull():
            self.icon_preview.clear()
            self.icon_preview.setText("—")
            return
        self.icon_preview.setPixmap(
            pixmap.scaled(
                PREVIEW_SIDE,
                PREVIEW_SIDE,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
        )

    def reload_repo_identity(self) -> None:
        """Re-read the committed identity — at startup and on a repo change.

        The launch-time snapshot is the fallback when git cannot tell us what
        HEAD holds (no git, or a checkout that is not a repo).
        """
        self.launch_identity = identity_mod.disk_identity()
        self.repo_identity = identity_mod.head_identity() or self.launch_identity

    def _set(self, field: str, text: str) -> None:
        if self._syncing:
            return
        self.model.set(f"app.{field}", text)

    def pending_identity(self) -> Identity:
        """What the Builder would write to tauri.conf.json for this config."""
        return Identity(
            name=str(self.model.get("app.name") or ""),
            identifier=str(self.model.get("app.identifier") or ""),
            version=str(self.model.get("app.version") or ""),
        )

    def _restore_repo_identity(self) -> None:
        identity_mod.write_identity(self.repo_identity)
        with self.model.batch():
            for field, value in self.repo_identity.as_app_section().items():
                self.model.set(f"app.{field}", value)
        self.refresh()

    def refresh(self) -> None:
        self._syncing = True
        try:
            for field, edit in (
                ("name", self.name_edit),
                ("identifier", self.identifier_edit),
                ("version", self.version_edit),
            ):
                value = str(self.model.get(f"app.{field}") or "")
                if edit.text() != value:
                    edit.setText(value)
        finally:
            self._syncing = False
        self._refresh_status()
        self._refresh_icon()

    def _refresh_status(self) -> None:
        on_disk = identity_mod.disk_identity()
        pending = self.pending_identity()

        if on_disk != self.repo_identity:
            self.state_badge.setText("modified in working tree")
            self.state_badge.setObjectName("warningBadge")
            self.state_detail.setText(
                "tauri.conf.json on disk does not match the committed version "
                f"— it currently reads {on_disk.name} / {on_disk.identifier} / "
                f"{on_disk.version}. A crashed or cancelled build can leave it "
                "this way."
            )
            self.restore_button.show()
        elif pending != on_disk:
            diff = identity_mod.conf_pending_diff(on_disk, pending)
            self.state_badge.setText("will be modified at build time")
            self.state_badge.setObjectName("warningBadge")
            self.state_detail.setText(
                "Starting a build writes these changes to tauri.conf.json:\n"
                + "\n".join(f"  {line}" for line in diff)
            )
            self.restore_button.hide()
        else:
            self.state_badge.setText("matches the repo")
            self.state_badge.setObjectName("successBadge")
            self.state_detail.setText(
                "Nothing to write — the form matches the committed values."
            )
            self.restore_button.hide()

        # Re-polish so the objectName swap actually repaints.
        self.state_badge.style().unpolish(self.state_badge)
        self.state_badge.style().polish(self.state_badge)

        changed_identifier = pending.identifier != self.repo_identity.identifier
        if changed_identifier and paths.ANDROID_GEN.is_dir():
            self.android_warning.setText(
                "⚠ src-tauri/gen/android already exists and has the old "
                "identifier baked into its Gradle project. Delete that "
                "directory before an Android build if you need the new one "
                "(the Builder will not delete it for you)."
            )
            self.android_warning.show()
        else:
            self.android_warning.hide()

    def set_issues(self, issues: list[Issue]) -> None:
        relevant = issues_for(issues, "app")
        self.form_error.set_messages([str(i) for i in relevant])
