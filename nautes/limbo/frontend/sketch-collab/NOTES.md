# Sketch — realtime collaboration (parked 2026-07-20)

The Sketch board originally shipped as a **realtime collaborative whiteboard**: one
shared board per chat room, live stroke streaming, and convergence across peers over
the MLS-encrypted sync seam. It was cut back to a standalone local SVG/PNG editor.

These files are the collaborative implementation as it stood when it was parked. They
are **not compiled or referenced** (this directory is outside the npm `workspaces`
globs), and they are **not maintained** — they will not typecheck against the current
`sketchModel.ts`, which has since dropped every field they depend on.

| file | what it is |
|---|---|
| `useSketch.ts` | the collaboration engine: wire protocol, outbox, snapshots, receive handler |
| `sketchModel.crdt.ts` | the matching CRDT document model (kept so the engine has a coherent counterpart) |
| `sketchModel.crdt.spec.ts` | its tests, including the CRDT-law proofs |

## What it did

**Document = LWW-element-set CRDT.** Shapes keyed by `id`, last-write-wins on
`updatedAt` with `author` breaking ties; tombstones `id -> deletedAt` max-merged;
`clearedAt` a grow-only max register. Merge is idempotent, commutative and associative,
so ops and snapshots apply in any order, any number of times, and peers converge. Add
*and* delete are both LWW (not remove-wins) specifically so undo can resurrect an erased
shape by re-stamping it later than its tombstone.

**Hybrid logical clock** (`makeClock`) — `observe()` on every inbound timestamp. Without
it, a peer with a slow wall clock stamps work below a clear it has already seen (silently
voided everywhere) and loses every LWW race.

**Wire types** (`sketch_` family): `sketch_stroke_delta` (ephemeral live strokes, never
persisted), `sketch_shape_upsert` (authoritative; carries the full point list so dropped
deltas self-heal, plus a `count` digest that triggers a throttled `sketch_want`),
`sketch_shape_delete`, `sketch_clear`, `sketch_snapshot`, `sketch_want`.

**The batching is the load-bearing part.** Every message sent *or received* is a full MLS
state export + AEAD seal + `PersistMode::SyncAll` **fsync**, and every `kvPut` is an fsync
too — so the budget is messages per second, not bytes. Hence ≤1 stroke delta per 150 ms
tick (never per pointermove), batched eraser deletes, ONE compacted snapshot for late
joiners, and debounced persistence. The outbox uses **coalescing buffers, not queues**: a
tick that can't send merges into the pending batch, so backpressure makes batches bigger
rather than the backlog longer. Snapshot policy is captain-preferred with a jittered
non-captain fallback and a 5 s hard rate limit.

## To restore

1. Move `useSketch.ts` back to `apps/enigma/src/components/sketch/useSketch.ts` and
   reconcile it with the live `sketchModel.ts` — the model must regain `author`,
   `createdAt`, `updatedAt`, `tombstones`, `clearedAt`, `upsertShape`/`deleteShapes`/
   `clearAll`/`mergeSnapshot`/`gcTombstones`/`truncateSnapshot`/`compareShapes`,
   `makeClock`, and the `validateShape`/`validateStrokeDelta`/`validateSnapshot`
   validators. `sketchModel.crdt.ts` here is the reference for all of it.
   **Rotation (`rot`) was added after parking** — a restored wire format must carry it,
   and `validateShape` must accept it.
2. Re-add the `sketch_` clause to the sync-family allowlist in
   `packages/rakotis/src/useChatChannel.ts` (~line 1000), beside `kanban_` / `dlink_`.
   Without it, `sketch_*` messages fall through and render as raw JSON chat bubbles.
3. Restore the build-config keys `sketch.max_points_per_stroke` and
   `sketch.snapshot_max_bytes` plus the `snapshot_max_bytes * 2 <= network.max_frame_bytes`
   assert, across the four coordinated files: `build_config.yaml` → `build.rs` (section
   struct, asserts, codegen template, format args) → `src/lib.rs` (`BuildConfigSummary`
   field + initializer) → `packages/rakotis/src/services/appStorage.ts` (`BuildConfig`
   interface + `FALLBACK_BUILD_CONFIG`).
4. Re-wire the app-lifetime singleton in `apps/enigma/src/stores/chat.ts`
   (`const sketch = sketchEnabled ? useSketch(p2p) : null;` + `sketch.reload()` in
   `applyRuntimeProfile` + the return object), and bump the `onSync` registration count
   assertion in `apps/enigma/tests/unit/chatStore.test.ts`.
5. Re-add the room scoping: persistence keyed by room slug rather than the singleton
   `""` key, and the `switchRoom` teardown that drops pending buffers on room change
   (they would otherwise be encrypted under the *new* room's MLS group).
6. Restore the collab UI: per-peer live-stroke overlay with author name chips
   (`SketchCanvas.vue`), the resync button (`SketchToolbar.vue`, icon `faArrowsRotate` —
   removed from `main.ts`), the no-room empty state and truncation warning
   (`EnigmaSketchView.vue`), the nav attention dots (`App.vue`), and the i18n keys
   `subtitle`, `noRoom`, `resync`, `truncatedWarning`, `attentionTitle` in **both**
   `en.ts` and `pl.ts` (`tests/unit/i18n.test.ts` asserts exact key parity).

Note: "Send to chat" also went with this cut. It used `sendImageDataUrl`, which was
removed from `packages/rakotis/src/useChatChannel.ts` as dead code — restore it from git
history (it predates Sketch) if that button comes back.
