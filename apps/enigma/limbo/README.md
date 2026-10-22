# limbo/ — parked features

Features moved out of the build during the serverless P2P rework (see
`technology.md` §16 at the repo root). They are **not** compiled, bundled, or
referenced anywhere — this directory is outside the npm `workspaces` globs and
outside every `src-tauri` crate.

Parked here, restorable later:

- **The Notes tab and its three workspaces** (2026-07-27) — parked together for
  lack of maintenance capacity, not because anything was wrong with them:
  - `frontend/kanban/` — the **group Kanban board**, one per room, columns owned
    by the captain and cards reconciled last-write-wins over the MLS sync seam.
  - `frontend/sketch/` — **restored on 2026-07-27** as the Files → Local SVG
    editor (see "Restored so far"). All that is still parked here is
    `views/EnigmaSketchView.vue`, the standalone-tab shell the editor no longer
    uses.
  - `frontend/mind/` — the **Mind map**, a device-local cytoscape graph with a
    Trix rich-text node editor and a Topics browser, plus its design doc
    `mind.md`.
  - `frontend/notes-shell/` — `EnigmaNotesView.vue`, the sub-tab shell that
    hosted the three. Nothing left to host once they went.
  - `rust/` — `fs_local.rs`, whose BASE64 command came back with PNG export on
    2026-07-27. What is still parked is `fs_write_text_file`: nothing calls it
    (the SVG itself saves through the sealed `local_note_write`), and leaving an
    unused command registered would widen the IPC surface for nothing.

  Each directory carries a `NOTES.md` with its design and a step-by-step restore
  checklist, plus the exact i18n blocks (`i18n/*.ts.snippet`) that were lifted
  out of `en.ts`/`pl.ts`. Their build-config sections, feature flags, routes, nav
  entries and npm dependencies (`cytoscape`, `trix`) were removed from the app —
  the checklists say precisely what to put back.

- **Map routes** (2026-07-27) — `frontend/map-routes/`. The Map tab shipped with
  hand-drawn **routes** (click waypoints → Finish → name it) alongside pins:
  private polylines in the sealed `map:routes` kv, a Routes sidebar card, and
  room sharing as `map_route` chat cards. The tab was cut back to **pins only**.
  Parked as snippets rather than whole files — route code was interleaved with
  pin/location/beacon code, so almost nothing could move wholesale. **There was
  never any route code in Rust.** Beacon's zone/route publishing is a separate
  feature and kept the shared draft-polyline engine, so restoring is purely
  additive — see `frontend/map-routes/NOTES.md` for the two fix-ups to reverse.

- **Device linking + multi-device sync** (2026-08-18) — `frontend/devices/` and
  `rust/devices/`. QR pairing, the device registry, chat-log/kv convergence
  between a user's own devices, and the Files→Devices per-file push/pull, parked
  together: pairing was the only way to create a device link, so the rest was
  unreachable once it went. Note that
  `deviceSyncModel.ts` was SPLIT rather than parked — the chat-history and
  leaf-identity half stayed as `packages/rakotis/src/chatHistoryModel.ts`,
  because chat and peer sync import it. `NOTES.md` carries the design, the
  bugs that were expensive to find (the QR ticket minted before
  `endpoint.online()`, the unbounded verdict wait that reported a timeout as a
  refusal), and a step-by-step restore checklist.

- **Peer links — scoped person-to-person sync** (2026-08-18) —
  `frontend/peers/` and `rust/peers/`. A pairwise key, a hidden gossip room and
  a per-direction allow-list of what two *different* people share. Parked
  because the grant persisted a 32-byte link key per contact — exposure that
  was not wanted — and the feature cost more to maintain than it returned.
  `NOTES.md` records the domain separation from device linking (a live test in
  `usePeerSync.test.ts` still pins it, with the foreign HMAC label inlined),
  why the allow-list is per-grant rather than global, and the restore steps.

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

- **Sketch, as an SVG editor** (2026-07-27) — the drawing engine came back as an
  editor for local `.svg` files inside **Files → Local**, beside the ACE notes
  editor, rather than as the standalone free-form board it was.
  `components/{sketchModel,useSketch,SketchCanvas,SketchToolbar}` went to
  `apps/enigma/src/components/sketch/`, joined by a new `svgDocument.ts` that
  parses a real SVG into editable shapes plus **opaque** nodes re-emitted
  verbatim, and `apps/enigma/src/components/local/SvgEditor.vue` which clones
  `NoteEditor`'s interface so the sealed save path is shared unchanged (no Rust
  change was needed — an SVG is UTF-8 text). Notable differences from the park:
  `useSketch` is a per-file **factory** rather than a module singleton, the board
  takes its geometry from the file's `viewBox` instead of the viewport, the kv
  document keys are gone (Files → Local owns saving; only the palette is still
  stored), `toSvg` now writes `data-en-*` round-trip hints, and files containing
  active content are **refused** with an offer to open them in the XML editor.
  **PNG export came with it**: `sketchExport.ts` and the base64 half of
  `fs_local.rs` are back, so a drawing can be rasterized to a path the user picks
  in the native dialog. That is the app's only unsealed write, and it is the one
  thing the sealed text path cannot carry. The old tab shell stayed parked.

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
  (feature-folder convention), surfaced as a dedicated **Vox tab**
  (`EnigmaVoxView.vue`, route `/vox` — named "Calls" until 2026-07-27) with an
  incoming-call nav dot. Three call
  flows: QR/ticket, call a room member (offer over the MLS `onSync`/`sendSync` seam,
  `vox_*` family), and call by DHT nickname / saved contact (`dht_find_nick` /
  Contacts phone button). Gated on airplane + Tor-exclusive mode with a `shutdown`
  hook; the voice-message mic button is disabled during a live call.
