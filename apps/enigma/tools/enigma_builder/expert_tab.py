"""Expert tab: settings clamps, network tuning, and the read-only crypto card.

Everything here is validated by build.rs, and one field (max_frame_bytes) is
wire-interop sensitive, so the whole tab sits behind a toggle. Crypto is shown
but never editable: those strings are const-asserted against the vendored
crates, and changing them does not change the algorithms.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QCheckBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

import widgets
from config_model import ConfigModel
from validation import SETTINGS_FLOORS, Issue, issues_for
from yaml_gen import SETTINGS_KEYS

MIB = 1024 * 1024

NETWORK_FIELDS: tuple[tuple[str, int, int, str], ...] = (
    (
        "max_frame_bytes",
        MIB,
        256 * MIB,
        "Caps the Tor transport frame AND the iroh-gossip message size.",
    ),
    (
        "onion_port",
        1,
        65535,
        "Virtual onion port. Rides inside each ticket, so it affects new "
        "tickets only.",
    ),
    ("max_redirects", 1, 20, "Cloud download redirect-follow cap."),
    ("tor_write_timeout_secs", 1, 600, ""),
    ("tor_handshake_timeout_secs", 1, 600, ""),
)

BYTE_FIELDS = {"max_frame_bytes"}


def _human_bytes(value: int) -> str:
    if value >= MIB and value % MIB == 0:
        return f"{value // MIB} MiB"
    if value >= 1024 and value % 1024 == 0:
        return f"{value // 1024} KiB"
    return f"{value} B"


class ExpertTab(QWidget):
    def __init__(self, model: ConfigModel) -> None:
        super().__init__()
        self.model = model
        self._syncing = False
        self._warned = False

        outer = widgets.page_layout(self)
        layout = widgets.scroll_page(outer)

        self.enable_box = QCheckBox("Enable expert editing")
        self.enable_box.toggled.connect(self._toggle_expert)
        enable_frame, enable_layout = widgets.card()
        enable_layout.addWidget(self.enable_box)
        enable_layout.addWidget(
            widgets.hint(
                "Defaults, clamp bounds and transport tuning. build.rs "
                "validates all of it, and every edition ships these values "
                "identically on purpose — a Light peer has to share rooms with "
                "a Pro peer."
            )
        )
        layout.addWidget(enable_frame)

        self.editable: list[QWidget] = []
        layout.addWidget(self._build_settings_card())
        layout.addWidget(self._build_network_card())
        layout.addWidget(self._build_crypto_card())
        layout.addStretch()

        self.preview = widgets.MonoPane("preview", "", 4000)
        self.preview.setMinimumHeight(140)
        self.preview.setMaximumHeight(220)
        outer.addWidget(
            widgets.hint("Preview — configs/build_config.custom.yaml")
        )
        outer.addWidget(self.preview)

        self._toggle_expert(False)
        self.refresh()

    # ----- construction ---------------------------------------------------

    def _build_settings_card(self) -> QWidget:
        frame, layout = widgets.card()
        layout.addWidget(widgets.section_title("Settings defaults and clamps"))
        layout.addWidget(
            widgets.hint(
                "The encrypted KV store (ns p2p:settings) stays the runtime "
                "source of truth; these seed and bound it. build.rs enforces "
                "min <= default <= max plus a per-key floor."
            )
        )

        form = QFormLayout()
        form.setHorizontalSpacing(18)
        form.setVerticalSpacing(12)
        self.clamp_rows: dict[str, widgets.ClampRow] = {}
        self.clamp_errors: dict[str, widgets.ErrorLabel] = {}

        for key in SETTINGS_KEYS:
            row = widgets.ClampRow(key)
            row.edited.connect(
                lambda field, value, k=key: self._set(f"settings.{k}.{field}", value)
            )
            error = widgets.ErrorLabel()

            container = QWidget()
            box = QVBoxLayout(container)
            box.setContentsMargins(0, 0, 0, 0)
            box.setSpacing(4)

            controls = QHBoxLayout()
            controls.setContentsMargins(0, 0, 0, 0)
            controls.addWidget(row)
            controls.addWidget(
                widgets.link_button(
                    "reset", lambda k=key: self.model.reset_to_canonical(f"settings.{k}")
                )
            )
            box.addLayout(controls)
            box.addWidget(error)

            floor = SETTINGS_FLOORS[key]
            form.addRow(f"{key}  (min ≥ {floor})", container)
            self.clamp_rows[key] = row
            self.clamp_errors[key] = error
            self.editable.append(container)

        layout.addLayout(form)
        return frame

    def _build_network_card(self) -> QWidget:
        frame, layout = widgets.card()

        header = QHBoxLayout()
        header.addWidget(widgets.section_title("Network"))
        header.addStretch()
        header.addWidget(widgets.badge("wire-interop", False))
        layout.addLayout(header)
        layout.addWidget(
            widgets.hint(
                "max_frame_bytes must match across every peer in a room: a "
                "build with a larger cap can emit messages a smaller-cap peer "
                "rejects. Change it only in lockstep across a fleet."
            )
        )

        form = QFormLayout()
        form.setHorizontalSpacing(18)
        form.setVerticalSpacing(12)
        self.network_boxes: dict[str, QSpinBox] = {}
        self.network_hints: dict[str, QLabel] = {}

        for key, low, high, description in NETWORK_FIELDS:
            box = widgets.spin(low, high)
            box.valueChanged.connect(
                lambda value, k=key: self._set(f"network.{k}", value)
            )
            self.network_boxes[key] = box

            container = QWidget()
            column = QVBoxLayout(container)
            column.setContentsMargins(0, 0, 0, 0)
            column.setSpacing(4)
            column.addWidget(box)
            if description or key in BYTE_FIELDS:
                label = widgets.hint(description, "gateHint")
                self.network_hints[key] = label
                column.addWidget(label)

            form.addRow(key, container)
            self.editable.append(container)

        self.network_error = widgets.ErrorLabel()
        layout.addLayout(form)
        layout.addWidget(self.network_error)
        return frame

    def _build_crypto_card(self) -> QWidget:
        frame, layout = widgets.card()
        layout.addWidget(widgets.section_title("Crypto (read-only)"))
        layout.addWidget(
            widgets.hint(
                "Declarations, asserted at compile time against "
                "cryptorotor/rotor_core and cryptorotor/gervasius. Changing "
                "them here would not change the algorithms — change the crates "
                "and update build_config.yaml by hand."
            )
        )

        form = QFormLayout()
        form.setHorizontalSpacing(18)
        form.setVerticalSpacing(8)
        self.crypto_labels: dict[str, QLabel] = {}
        for path in (
            "crypto.mls_ciphersuite",
            "crypto.at_rest_aead",
            "crypto.kdf.algorithm",
            "crypto.kdf.m_cost_kib",
            "crypto.kdf.t_cost",
            "crypto.kdf.p_cost",
        ):
            value_label = QLabel()
            value_label.setObjectName("details")
            value_label.setTextInteractionFlags(
                Qt.TextInteractionFlag.TextSelectableByMouse
            )
            self.crypto_labels[path] = value_label
            form.addRow(path.split(".", 1)[1], value_label)
        layout.addLayout(form)
        return frame

    # ----- behavior -------------------------------------------------------

    def _toggle_expert(self, enabled: bool) -> None:
        if enabled and not self._warned:
            self._warned = True
            QMessageBox.information(
                self,
                "Expert editing",
                "These values are validated by build.rs and shipped identically "
                "by every edition on purpose.\n\nmax_frame_bytes in particular "
                "is wire-interop sensitive: peers in one room must agree on it.",
            )
        for widget in self.editable:
            widget.setEnabled(enabled)

    def _set(self, path: str, value: int) -> None:
        if self._syncing:
            return
        self.model.set(path, value)

    def refresh(self) -> None:
        self._syncing = True
        try:
            for key, row in self.clamp_rows.items():
                clamp = self.model.get(f"settings.{key}")
                if isinstance(clamp, dict):
                    row.set_values(clamp)
            for key, box in self.network_boxes.items():
                value = self.model.get(f"network.{key}")
                if isinstance(value, int) and box.value() != value:
                    box.blockSignals(True)
                    box.setValue(value)
                    box.blockSignals(False)
        finally:
            self._syncing = False

        for key, label in self.network_hints.items():
            base = next(d for k, _l, _h, d in NETWORK_FIELDS if k == key)
            value = self.model.get(f"network.{key}")
            if key in BYTE_FIELDS and isinstance(value, int):
                label.setText(f"{_human_bytes(value)}. {base}".strip())
            else:
                label.setText(base)

        for path, label in self.crypto_labels.items():
            label.setText(str(self.model.get(path)))

        try:
            self.preview.set_content(self.model.render())
        except KeyError as exc:
            self.preview.set_content(f"# cannot render: {exc}")

    def set_issues(self, issues: list[Issue]) -> None:
        for key, error in self.clamp_errors.items():
            relevant = issues_for(issues, f"settings.{key}")
            error.set_messages([i.message for i in relevant])
        self.network_error.set_messages(
            [str(i) for i in issues_for(issues, "network", "crypto")]
        )
