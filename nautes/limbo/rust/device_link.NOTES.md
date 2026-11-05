# `device_link.rs` Pairing Backend

Status: parked from active Enigma.

`device_link.rs` here is the former full QR device-pairing backend from
`apps/enigma/src-tauri/src/device_link.rs`: ticket minting, join, human confirm,
one-shot bundle/history transfer, reverse-link offer, and the old unit tests.

Active Enigma now keeps only a small compatibility module at the original path:

- `devlink_adopt_identity` for profiles that were already linked.
- `devlink_derive_room` for hidden devlink-room rekey/unlink support.
- `shutdown` as a harmless no-op in the existing teardown fan-out.

To restore pairing in Enigma, move this file back, re-register the
`devlink_pair_*`, `devlink_reverse_*`, and `devlink_status` commands in
`src-tauri/src/lib.rs`, and restore a frontend pairing surface.
