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

#: Display copy for the read-only feature list. Same voice as the old editable
#: card: what a build actually loses, not marketing copy.
GATE_HINTS: dict[str, tuple[str, str]] = {
    "p2p.allow_hosted_relays": (
        "Hosted relays and discovery",
        "n0-hosted relays plus pkarr/DNS publishing. Off = direct QUIC "
        "(ticket/QR) and Tor still work, but a bare NodeId can no longer be "
        "resolved.",
    ),
    "dht.enabled": (
        "Mainline DHT",
        "Rendezvous publishing, ticketless join-by-room-code, the nickname "
        "directory and presence. Requires hosted relays.",
    ),
    "calls.enabled": (
        "Voice calls",
        "1:1 calls. Off = no Calls tab and useVoxCall is never instantiated, "
        "so no call offer ever lands.",
    ),
    "contacts.enabled": (
        "Contacts",
        "The Contacts tab and direct room invites. DHT room codes are "
        "unaffected.",
    ),
    "calendar.enabled": (
        "Calendar",
        "Meetings, polls and the reminder tick.",
    ),
    "maps.enabled": (
        "Maps",
        "The Map tab and every map_* command. Regions come from "
        "tools/map_packager — the app never fetches tiles itself.",
    ),
    "keyring.enabled": (
        "Keyring",
        "One passphrase locking MANY local files (keyring_* commands). "
        "Per-file locking is always in — this gates only the shared ring.",
    ),
    "lock.pin_unlock": (
        "PIN unlock",
        "Re-open the vault with a short PIN on a keypad after an idle lock. "
        "Convenience only — the passphrase is still required after a restart.",
    ),
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
        layout.addWidget(self._build_features_card())
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

    def _build_features_card(self) -> QWidget:
        """The feature list, READ-ONLY: what the chosen edition compiles in.

        Rows, not checkboxes — the block informs the choice above, it is not a
        second place to make one. Values come from the live model, so the list
        always tells the truth about the file that will be saved.
        """
        frame, layout = widgets.card(spacing=6)
        layout.addWidget(widgets.section_title("What's included"))
        layout.addWidget(
            widgets.hint(
                f"Every edition ships {ALWAYS_ON}. The gated features below "
                "follow the edition chosen above.",
                "gateHint",
            )
        )

        self.feature_badges: dict[str, QWidget] = {}
        for path, (label, description) in GATE_HINTS.items():
            row = QWidget()
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(0, 0, 0, 0)
            row_layout.setSpacing(8)
            badge = widgets.badge("", True)
            self.feature_badges[path] = badge
            row_layout.addWidget(badge)
            row_layout.addWidget(
                widgets.hint(f"{label} — {description}", "gateHint"), 1
            )
            layout.addWidget(row)
        return frame

    # ----- behaviour ------------------------------------------------------

    def _apply_preset(self, edition: str) -> None:
        if self._syncing:
            return
        self.model.apply_preset(edition)

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
                self.included_label.setText("")
            else:
                # Only reachable by loading a hand-edited file that slipped
                # past the refusal — say so rather than pretending.
                self.included_label.setText(
                    "This configuration matches no edition — pick one above."
                )
            for path, badge in self.feature_badges.items():
                included = bool(self.model.get(path))
                badge.setText("included" if included else "not included")
                badge.setObjectName("successBadge" if included else "warningBadge")
                badge.style().unpolish(badge)
                badge.style().polish(badge)
            self.preview.set_content(self.model.render())
        finally:
            self._syncing = False

    def set_issues(self, issues: list[Issue]) -> None:
        # Gates are no longer editable here, so gate issues cannot originate
        # from this tab; nothing to funnel. Kept for the window's contract.
        _ = issues
