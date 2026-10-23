# Device Pairing

Status: parked from active Enigma UI.

The former Files -> Devices -> Pairing surface lives here as a reference for
Zinnia. The archived `PairingPanel.vue` is a source snapshot from
`apps/enigma/src/components/devices/PairingPanel.vue`; its imports still point at
the app tree and it is not compiled from limbo. The full Rust pairing backend is
parked separately at `limbo/rust/device_link.rs`.

Active Enigma keeps existing linked-device sync and file sync alive, but no
longer exposes QR device pairing:

- `DevicesTab.vue` renders the linked-device header and file sync only.
- `stores/devices.ts` no longer exposes begin/join/confirm/cancel pairing state.
- Tauri no longer registers the `devlink_pair_*`, `devlink_reverse_*`, or
  `devlink_status` commands.
- `devlink_adopt_identity` and `devlink_derive_room` remain active for profiles
  that were already linked.
