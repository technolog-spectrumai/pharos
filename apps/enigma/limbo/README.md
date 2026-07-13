# limbo/ — parked features

Features moved out of the build during the serverless P2P rework (see
`serverless_plan.md` at the repo root). They are **not** compiled, bundled, or
referenced anywhere — this directory is outside the npm `workspaces` globs and
outside every `src-tauri` crate.

Parked here, restorable later:

| File | Was | Notes |
|---|---|---|
| `rust/vox.rs` | `apps/enigma/src-tauri/src/vox.rs` | 1:1 voice calls over iroh QUIC (ALPN `enigma/vox/0`), self-contained MLS handshake. Depends on the removed `aster.rs` for `vox_call_node` + `load_or_create_secret` (now in `p2p_iroh.rs`), and on the `chacha20poly1305`/`rustfft` deps removed from Cargo.toml. |
| `rust/file_xfer.rs` | `apps/enigma/src-tauri/src/file_xfer.rs` | P2P file transfer over iroh QUIC. Same `load_or_create_secret` note. |
| `frontend/VoxPanel.vue` | `apps/enigma/src/components/VoxPanel.vue` | Voice-call UI incl. QR create/scan. |
| `frontend/FilePanel.vue` | `apps/enigma/src/components/FilePanel.vue` | File-transfer UI. |
| `frontend/useVoxCall.ts` | `apps/enigma/src/composables/useVoxCall.ts` | Uses the removed `aster_resolve` command for call-by-username. |
| `frontend/useFileShare.ts` | `apps/enigma/src/composables/useFileShare.ts` | Rides the p2p channel's MLS group (`onSync`/`sendSync` seam, still present in rakotis). |
| `frontend/voxCall.test.ts` | `apps/enigma/tests/unit/voxCall.test.ts` | |
| `frontend/voxPanel.test.ts` | `apps/enigma/tests/component/voxPanel.test.ts` | |

To restore a feature: move the files back, re-add the `mod`/`invoke_handler`
entries in `lib.rs`, re-`manage()` its state, re-add its Cargo deps, and re-add the
tab in `EnigmaChatView.vue` + the store wiring in `stores/chat.ts`.
