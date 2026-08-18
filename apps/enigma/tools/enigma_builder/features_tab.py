"""Features tab — the EDITION PICKER.

There is deliberately no per-gate editing here. The product line is three
presets — Basic, Standard, Professional — and a product config always carries
exactly one of them: a hand-assembled "custom" feature set is refused at save,
at load, and at build (see ConfigModel), because a fourth product that exists
only on one developer's machine is not a product. What IS free per product:
identity and branding (Identity tab) and the expert tuning clamps (Expert
tab), which are invariant-preserving.

The description under each chip is derived from the checked-in preset YAMLs at
runtime — the values that compile are the values shown, never a hardcoded
marketing list (a comment drifting from a value has happened before).
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QButtonGroup, QHBoxLayout, QPushButton, QWidget

import paths
import widgets
from config_model import ConfigModel
from validation import FEATURE_GATES, Issue, get_path

PRESET_LABELS = {
    "basic": "Basic",
    "standard": "Standard",
    "professional": "Professional",
}

#: Features every edition ships because they have no gate at all.
ALWAYS_ON = "P2P encrypted chat · Tor transport · file transfer · local locked files · vault / panic code"


class FeaturesTab(QWidget):
    def __init__(self, model: ConfigModel) -> None:
        super().__init__()
        self.model = model
        self._syncing = False

        outer = widgets.page_layout(self)
        layout = widgets.scroll_page(outer)

        layout.addWidget(self._build_preset_card())
        layout.addStretch()

        preview_header = QHBoxLayout()
        preview_header.addWidget(
            widgets.hint(
                "Preview — configs/build_config.custom.yaml (written when you build)"
            ),
            1,
        )
        outer.addLayout(preview_header)

        self.preview = widgets.MonoPane("preview", "", 4000)
        self.preview.setMinimumHeight(150)
        self.preview.setMaximumHeight(260)
        outer.addWidget(self.preview)

        self.refresh()

    # ----- construction ---------------------------------------------------

    def _build_preset_card(self) -> QWidget:
        frame, layout = widgets.card()
        layout.addWidget(widgets.section_title("Edition"))
        layout.addWidget(
            widgets.hint(
                "The product IS one of these three. Identity and branding are "
                "yours to change on the Identity tab; the feature set is not "
                "— a product config that matches no edition is refused."
            )
        )

        row = QHBoxLayout()
        row.setSpacing(8)
        self.preset_group = QButtonGroup(self)
        self.preset_group.setExclusive(True)
        self.preset_buttons: dict[str, QPushButton] = {}

        for edition in paths.PRESETS:
            button = QPushButton(PRESET_LABELS[edition])
            button.setObjectName("presetChip")
            button.setCheckable(True)
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            button.clicked.connect(lambda _checked, e=edition: self._apply_preset(e))
            self.preset_group.addButton(button)
            self.preset_buttons[edition] = button
            row.addWidget(button)
        row.addStretch()
        layout.addLayout(row)

        # What the selected edition actually compiles in, read from its YAML.
        self.included_label = widgets.hint("", "gateHint")
        layout.addWidget(widgets.separator())
        layout.addWidget(self.included_label)
        return frame

    # ----- behaviour ------------------------------------------------------

    def _apply_preset(self, edition: str) -> None:
        if self._syncing:
            return
        self.model.apply_preset(edition)

    def _describe(self, edition: str) -> str:
        """The edition's real gate values, phrased as in/out lists."""
        preset = self.model.preset(edition)
        if not preset:
            return ""
        on = [label for path, label in FEATURE_GATES if get_path(preset, path)]
        off = [label for path, label in FEATURE_GATES if not get_path(preset, path)]
        lines = [f"Always included: {ALWAYS_ON}."]
        if on:
            lines.append(f"{PRESET_LABELS[edition]} adds: " + " · ".join(on) + ".")
        if off:
            lines.append("Not in this edition: " + " · ".join(off) + ".")
        return "\n".join(lines)

    def refresh(self) -> None:
        if not self.model.ready:
            # No repo yet: nothing to detect, nothing to render.
            self.preview.set_content("")
            self.included_label.setText("")
            return
        self._syncing = True
        try:
            detected = self.model.detect_preset()
            for edition, button in self.preset_buttons.items():
                button.setChecked(edition == detected)
            if detected:
                self.included_label.setText(self._describe(detected))
            else:
                # Only reachable by loading a hand-edited file that slipped
                # past the refusal — say so rather than pretending.
                self.included_label.setText(
                    "This configuration matches no edition — pick one above."
                )
            self.preview.set_content(self.model.render())
        finally:
            self._syncing = False

    def set_issues(self, issues: list[Issue]) -> None:
        # Gates are no longer editable here, so gate issues cannot originate
        # from this tab; nothing to funnel. Kept for the window's contract.
        _ = issues
