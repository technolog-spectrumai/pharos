# limbo/ — parked features

Features moved out of the build during the serverless P2P rework (see
`technology.md` §16 at the repo root). They are **not** compiled, bundled, or
referenced anywhere — this directory is outside the npm `workspaces` globs and
outside every `src-tauri` crate.

Parked here, restorable later:

- **Sketch realtime collaboration** (2026-07) — `frontend/sketch-collab/`. The Sketch
  board shipped as a shared per-room whiteboard (LWW-element-set CRDT + hybrid logical
  clock, live stroke streaming, snapshots for late joiners, all over the MLS `onSync`/
  `sendSync` seam) and was cut back to a standalone local SVG/PNG editor. The engine
  (`useSketch.ts`), its matching CRDT model and its tests are kept here; the drawing
  half (shapes, geometry, SVG serialization, rotation) stayed in the app. See
  `frontend/sketch-collab/NOTES.md` for the design and a step-by-step restore checklist.
  Deliberately not kept compiling — it no longer typechecks against the live model.

To restore a feature: move the files back, re-add the `mod`/`invoke_handler`
entries in `lib.rs`, re-`manage()` its state, re-add its Cargo deps, and mount the
UI as its own route/view + nav entry (`router/index.ts` + `App.vue`) + the store
wiring in `stores/chat.ts`.

**Restored so far:**

- **File transfer** (2026-07) — `file_xfer.rs`, `FilePanel.vue`, `useFileShare.ts`
  went back as `apps/enigma/src-tauri/src/file_xfer.rs` +
  `apps/enigma/src/components/chat/{FilePanel.vue,useFileShare.ts}`, surfaced as the
  Files tab (`EnigmaFilesView.vue`, route `/files`); commands gated on airplane mode
  and Tor-exclusive mode, with a max-file-size guard in Settings.
- **Voice calls (Vox)** (2026-07) — `vox.rs` went back as
  `apps/enigma/src-tauri/src/vox.rs`, but now accepts `VOX_ALPN` on the **main** p2p
  endpoint (registered in `p2p_iroh::ensure_started`, via `p2p_iroh::vox_endpoint`)
  instead of a dedicated aster-published node — so a callee is reachable at the same
  NodeId their contacts/nickname resolve to, and the removed `aster.rs` dependency is
  gone. `rustfft` was re-added to Cargo.toml (chacha20poly1305 was already back).
  Frontend went to `apps/enigma/src/components/vox/{VoxPanel.vue,useVoxCall.ts}`
  (feature-folder convention), surfaced as a dedicated **Calls tab**
  (`EnigmaCallsView.vue`, route `/calls`) with an incoming-call nav dot. Three call
  flows: QR/ticket, call a room member (offer over the MLS `onSync`/`sendSync` seam,
  `vox_*` family), and call by DHT nickname / saved contact (`dht_find_nick` /
  Contacts phone button). Gated on airplane + Tor-exclusive mode with a `shutdown`
  hook; the voice-message mic button is disabled during a live call.
