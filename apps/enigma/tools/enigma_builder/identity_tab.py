"""Identity tab: the fixed app name, Android package id, version and icon set.

The first three fields live in two files at once: ``tauri.conf.json`` and the
build config's ``app:`` section. Name and identifier are fixed to the product's
real Android identity; only the version is editable per release.

The icon is not a file path. It is a choice from the curated sets shipped in
``assets/icons/`` (see :mod:`iconsets` and ``icons.md``), so what a product
config records is a set id that means the same thing on every machine, and
nothing unreviewed can reach a signed build.
"""

from __future__ import annotations

from pathlib import Path

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QVBoxLayout,
    QWidget,
)

import icons as icons_mod
import iconsets
import identity as identity_mod
import paths
import widgets
from config_model import ConfigModel
from identity import Identity
from validation import Issue, issues_for

PREVIEW_SIDE = 96

#: The chooser's first entry, and the default: change nothing.
KEEP_REPO_ICONS = "Keep the icons already in the repo"


class IdentityTab(QWidget):
    #: Emitted when the build engineer picks a different icon set, so the
    #: window can mark the product config unsaved. Not emitted while a config
    #: is being loaded into the form.
    icon_set_changed = pyqtSignal()

    def __init__(self, model: ConfigModel) -> None:
        super().__init__()
        self.model = model
        self._syncing = False
        self._icon_sets: dict[str, iconsets.IconSet] = {}
        self._icon_complaint = ""

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
        self.name_edit.setPlaceholderText(identity_mod.FIXED_APP_NAME)
        self.identifier_edit = QLineEdit()
        self.identifier_edit.setPlaceholderText(identity_mod.FIXED_APP_IDENTIFIER)
        self.version_edit = QLineEdit()
        self.version_edit.setPlaceholderText("0.1.0")

        # Name, identifier AND version are announcements, not inputs. The
        # version belongs to the code: every change to the app bumps it in the
        # repo, so a build engineer choosing their own would ship an artifact
        # whose number means nothing — and Android refuses an upgrade whose
        # versionCode went backwards. Editing is disabled rather than hidden,
        # because the number is the one thing a builder must be able to read.
        for field, edit in (
            ("name", self.name_edit),
            ("identifier", self.identifier_edit),
        ):
            edit.textChanged.connect(lambda text, f=field: self._set(f, text))

        form.addRow("App name", self.name_edit)
        self.name_hint = widgets.hint("", "gateHint")
        form.addRow("", self.name_hint)
        form.addRow("Android package id", self.identifier_edit)
        self.identifier_hint = widgets.hint("", "gateHint")
        form.addRow(
            "",
            self.identifier_hint,
        )
        form.addRow("Version", self.version_edit)
        self.version_hint = widgets.hint("", "gateHint")
        form.addRow("", self.version_hint)

        self.form_error = widgets.ErrorLabel()
        form.addRow("", self.form_error)
        return frame

    def _build_icon_card(self) -> QWidget:
        frame, layout = widgets.card()
        layout.addWidget(widgets.section_title("App icon"))
        layout.addWidget(
            widgets.hint(
                "One of the icon sets shipped with the Builder. Each set is a "
                "reviewed square master image, from which Tauri generates "
                "every size: the .deb / .AppImage / .rpm icon and the Android "
                "launcher. Arbitrary files are deliberately not offered — a "
                "new set is added to assets/icons/ and reviewed there (see "
                "icons.md)."
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
        self.icon_combo = QComboBox()
        self.icon_combo.currentIndexChanged.connect(self._icon_changed)
        controls.addWidget(self.icon_combo)

        self.icon_description = widgets.hint("", "gateHint")
        controls.addWidget(self.icon_description)
        self.icon_error = widgets.ErrorLabel()
        controls.addWidget(self.icon_error)
        self.icon_note = widgets.hint("", "gateHint")
        controls.addWidget(self.icon_note)
        self.icon_problems = widgets.hint("", "gateHint")
        controls.addWidget(self.icon_problems)
        controls.addStretch()
        row.addLayout(controls, 1)

        layout.addLayout(row)
        self.reload_icon_sets()
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

        return frame

    # ----- behavior -------------------------------------------------------

    # ----- icon -----------------------------------------------------------

    def reload_icon_sets(self) -> None:
        """Re-read ``assets/icons/`` and rebuild the chooser.

        Keeps the current choice if that set is still there — the Builder can
        be pointed at a different sets directory, and losing the engineer's
        pick on a refresh would be worse than showing a stale one.
        """
        wanted = self.pending_icon_id() if self._icon_sets else None

        self._icon_sets = {s.id: s for s in iconsets.available_sets()}
        self.icon_combo.blockSignals(True)
        try:
            self.icon_combo.clear()
            self.icon_combo.addItem(KEEP_REPO_ICONS, None)
            for icon_set in self._icon_sets.values():
                if icon_set.ok:
                    self.icon_combo.addItem(icon_set.name, icon_set.id)
        finally:
            self.icon_combo.blockSignals(False)

        self._refresh_icon_problems()
        if wanted:
            self.select_icon_set(wanted)
        else:
            self._refresh_icon()

    def _refresh_icon_problems(self) -> None:
        """Say what was found and rejected — never hide a broken set."""
        lines = list(iconsets.problem_report())
        if self.icon_combo.count() <= 1:
            lines.insert(0, f"No usable icon sets in {iconsets.sets_dir()}.")
        elif lines:
            lines.insert(0, "Not offered:")
        self.icon_problems.setText("\n".join(lines))
        self.icon_problems.setVisible(bool(lines))

    # ----- what the rest of the tool asks for ------------------------------

    def pending_icon_id(self) -> str | None:
        """The chosen set's id, or None for "keep the repo icons".

        This is what a product config stores: an id resolves on any machine,
        an absolute path resolves on exactly one.
        """
        data = self.icon_combo.currentData()
        return str(data) if data else None

    def pending_icon_set(self) -> iconsets.IconSet | None:
        set_id = self.pending_icon_id()
        return self._icon_sets.get(set_id) if set_id else None

    def pending_icon(self) -> Path | None:
        """The source image this build should regenerate icons from, if any.

        Still a plain path, because that is what ``npx tauri icon`` takes and
        what build_tab snapshots around. A set whose image has gone bad since
        launch is returned anyway, so the build reports it rather than quietly
        skipping the icon step.
        """
        chosen = self.pending_icon_set()
        return chosen.master if chosen is not None else None

    def select_icon_set(self, value: str | Path, base: Path | None = None) -> bool:
        """Point the chooser at the set a product config names. True if found.

        Accepts the set id the Builder writes, and — for configs written by the
        old free-file picker — a path, matched back to a set by its master
        image or its directory name. Anything else falls back to the repo's
        committed icons and says so on the tab, because silently building the
        wrong brand is the failure that matters here.
        """
        text = str(value or "").strip()
        self._icon_complaint = ""
        if not text:
            self._select_icon_index(0)
            return False

        match = self._match_icon_set(text, base)
        if match is None:
            self._select_icon_index(0)
            self._icon_complaint = (
                f"This config asks for icon set “{text}”, which this Builder "
                f"does not ship. Keeping the repo's committed icons — pick a "
                f"set below, or add the missing one to assets/icons/."
            )
            self._refresh_icon()
            return False
        if not match.ok:
            self._select_icon_index(0)
            self._icon_complaint = (
                f"Icon set “{match.id}” is present but unusable: "
                + "; ".join(match.problems)
            )
            self._refresh_icon()
            return False

        index = self.icon_combo.findData(match.id)
        self._select_icon_index(index if index >= 0 else 0)
        return index >= 0

    def _match_icon_set(
        self, text: str, base: Path | None
    ) -> iconsets.IconSet | None:
        """Delegates to the shared resolver, against the chooser's own snapshot.

        The headless build resolves ``branding.icon`` through the same function,
        so a product config cannot mean one set in the GUI and another on the
        command line.
        """
        return iconsets.resolve(text, base=base, sets=self._icon_sets)

    def _select_icon_index(self, index: int) -> None:
        if self.icon_combo.currentIndex() == index:
            self._refresh_icon()
            return
        self.icon_combo.blockSignals(True)
        try:
            self.icon_combo.setCurrentIndex(index)
        finally:
            self.icon_combo.blockSignals(False)
        self._refresh_icon()

    # ----- rendering the choice --------------------------------------------

    def _icon_changed(self) -> None:
        self._icon_complaint = ""
        self._refresh_icon()
        self.icon_set_changed.emit()

    def _refresh_icon(self) -> None:
        chosen = self.pending_icon_set()

        if chosen is None:
            existing = icons_mod.preview_icon()
            self._set_preview(existing)
            self.icon_caption.setText("current" if existing else "no icon found")
            self.icon_error.set_messages(
                [self._icon_complaint] if self._icon_complaint else []
            )
            self.icon_description.setText(
                "src-tauri/icons and the Android launcher are left exactly as "
                "committed."
            )
            self.icon_note.setText("")
            self.icon_note.hide()
            return

        if chosen.master is None:
            errors, warnings_ = list(chosen.problems), []
        else:
            errors, warnings_ = icons_mod.validate_source(chosen.master)
        self.icon_error.set_messages(errors)
        self._set_preview(None if errors else chosen.master)
        self.icon_caption.setText("new" if not errors else "unusable")
        self.icon_description.setText(self._describe_icon_set(chosen))

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

    def _describe_icon_set(self, icon_set: iconsets.IconSet) -> str:
        facts = [f"assets/icons/{icon_set.id}/"]
        if icon_set.credit:
            facts.append(icon_set.credit)
        size = icons_mod.png_size(icon_set.master) if icon_set.master else None
        if size:
            facts.append(f"{size[0]}×{size[1]}")
        joined = " · ".join(facts)
        return f"{icon_set.description}\n{joined}" if icon_set.description else joined

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
        self._refresh_identity_lock()
        self._refresh_status()
        self._refresh_icon()

    def _refresh_identity_lock(self) -> None:
        application_id = identity_mod.android_application_id()
        self.name_edit.setReadOnly(True)
        self.name_edit.setClearButtonEnabled(False)
        self.identifier_edit.setReadOnly(True)
        self.version_edit.setReadOnly(True)
        version = str(self.model.get("app.version") or "")
        self.version_hint.setText(
            f"This build is {version}. The version comes from the repository and "
            f"is bumped with the code — it is not a build-time choice."
        )
        self.identifier_edit.setClearButtonEnabled(False)
        self.name_hint.setText(
            f"Fixed to {identity_mod.FIXED_APP_NAME}. Product configs cannot "
            "rename the app."
        )
        if application_id and application_id != identity_mod.FIXED_APP_IDENTIFIER:
            self.identifier_hint.setText(
                "Android Gradle currently installs "
                f"{application_id}; this must be corrected to the fixed id "
                f"{identity_mod.FIXED_APP_IDENTIFIER} before release."
            )
        else:
            self.identifier_hint.setText(
                f"Fixed to Android package id "
                f"{identity_mod.FIXED_APP_IDENTIFIER}. Product configs "
                "cannot change it."
            )

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

    def set_issues(self, issues: list[Issue]) -> None:
        relevant = issues_for(issues, "app")
        self.form_error.set_messages([str(i) for i in relevant])
