"""Features tab: presets, the ten build gates, and the runtime defaults."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QHBoxLayout,
    QPushButton,
    QWidget,
)

import paths
import widgets
from config_model import ConfigModel
from validation import Issue, issues_for

# One line per gate, distilled from the comments in build_config.yaml. These
# are what a build actually loses, not marketing copy.
GATE_HINTS: dict[str, tuple[str, str]] = {
    "cloud.allow_connections": (
        "Cloud connections",
        "Files→Cloud and every cloud_* command. Off = CLOUD_DISABLED and the "
        "cloud-server settings section is hidden.",
    ),
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
    "peers.enabled": (
        "Peer sync",
        "Person-to-person scoped sync. Off = the enigma/plink/0 ALPN is not "
        "registered, so a request from a Pro peer is refused at negotiation.",
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
    "devices.allow_linking": (
        "Device linking",
        "Linking your own devices, and with it Files→Devices file sync.",
    ),
}

RUNTIME_HINTS: dict[str, tuple[str, str]] = {
    "features.use_tor": ("Use Tor", "Route P2P through the embedded arti client."),
    "features.stable_onion": (
        "Stable onion address",
        "Reuse one persistent onion address instead of a fresh one per session.",
    ),
    "features.dht_discovery": (
        "DHT discovery",
        "Publish and look up rooms on the DHT. Stays opt-in even in Pro.",
    ),
    "features.dht_nick_publish": (
        "Publish nickname",
        "Announce a nickname in the DHT directory.",
    ),
}

PRESET_LABELS = {"light": "Light", "plus": "Plus", "pro": "Pro"}


class FeaturesTab(QWidget):
    def __init__(self, model: ConfigModel) -> None:
        super().__init__()
        self.model = model
        self._syncing = False

        outer = widgets.page_layout(self)
        layout = widgets.scroll_page(outer)

        layout.addWidget(self._build_preset_card())
        layout.addWidget(self._build_gates_card())
        layout.addWidget(self._build_runtime_card())
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
        layout.addWidget(widgets.section_title("Edition preset"))
        layout.addWidget(
            widgets.hint(
                "A preset fills in the gates below from the checked-in "
                "configs/build_config.<edition>.yaml. Builds always go out as "
                "ENIGMA_EDITION=custom — the product-line files are never "
                "modified."
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

        self.custom_chip = QPushButton("Custom")
        self.custom_chip.setObjectName("presetChip")
        self.custom_chip.setCheckable(True)
        self.custom_chip.setToolTip(
            "An indicator, not a preset — change any gate below to land here."
        )
        # Clicking it must not "select" a config that does not exist; put the
        # chips back where the model says they belong.
        self.custom_chip.clicked.connect(self._sync_preset_chips)
        self.preset_group.addButton(self.custom_chip)
        row.addWidget(self.custom_chip)
        row.addStretch()
        layout.addLayout(row)
        return frame

    def _build_gates_card(self) -> QWidget:
        frame, layout = widgets.card(spacing=6)
        layout.addWidget(widgets.section_title("Build gates"))
        layout.addWidget(
            widgets.hint(
                "Compile-time consts. A disabled feature has no tab, no route "
                "and its commands fail fast — it cannot be switched back on at "
                "runtime."
            )
        )

        self.gate_boxes: dict[str, QCheckBox] = {}
        for path, (label, description) in GATE_HINTS.items():
            box = QCheckBox(label)
            box.toggled.connect(lambda value, p=path: self._set(p, value))
            self.gate_boxes[path] = box
            layout.addWidget(box)
            layout.addWidget(widgets.hint(description, "gateHint"))

        self.gate_error = widgets.ErrorLabel()
        layout.addWidget(self.gate_error)
        return frame

    def _build_runtime_card(self) -> QWidget:
        frame, layout = widgets.card(spacing=6)
        layout.addWidget(widgets.section_title("Runtime defaults"))
        layout.addWidget(
            widgets.hint(
                "Initial values for a NEW profile's toggles — not gates. "
                "Settings still override them per profile, and existing "
                "profiles keep whatever they stored."
            )
        )

        self.runtime_boxes: dict[str, QCheckBox] = {}
        for path, (label, description) in RUNTIME_HINTS.items():
            box = QCheckBox(label)
            box.toggled.connect(lambda value, p=path: self._set(p, value))
            self.runtime_boxes[path] = box
            layout.addWidget(box)
            layout.addWidget(widgets.hint(description, "gateHint"))
        return frame

    # ----- behavior -------------------------------------------------------

    def _set(self, path: str, value: bool) -> None:
        if self._syncing:
            return
        self.model.set(path, value)

    def _apply_preset(self, edition: str) -> None:
        if self._syncing:
            return
        if not self.model.apply_preset(edition):
            self.gate_error.set_messages(
                [f"cannot read {paths.preset_yaml(edition)} — preset not applied"]
            )
            self._sync_preset_chips()

    def _sync_preset_chips(self) -> None:
        detected = self.model.detect_preset()
        self._syncing = True
        try:
            for edition, button in self.preset_buttons.items():
                button.setChecked(edition == detected)
            self.custom_chip.setChecked(detected is None)
        finally:
            self._syncing = False

    def refresh(self) -> None:
        """Pull every control's state from the model."""
        self._syncing = True
        try:
            for path, box in self.gate_boxes.items():
                box.setChecked(bool(self.model.get(path)))
            for path, box in self.runtime_boxes.items():
                box.setChecked(bool(self.model.get(path)))
        finally:
            self._syncing = False
        self._sync_preset_chips()
        try:
            self.preview.set_content(self.model.render())
        except KeyError as exc:
            # An incomplete config cannot be rendered; say which field is
            # missing rather than showing a stale preview.
            self.preview.set_content(f"# cannot render: {exc}")

    def set_issues(self, issues: list[Issue]) -> None:
        relevant = issues_for(
            issues,
            *GATE_HINTS.keys(),
            *RUNTIME_HINTS.keys(),
        )
        self.gate_error.set_messages([str(i) for i in relevant])
