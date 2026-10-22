# Sketch — what is left after the 2026-07-27 restore

> **Most of this park is gone.** On 2026-07-27 the drawing engine came back as
> the **SVG editor for local files** in Files → Local — see `limbo/README.md`
> under "Restored so far", and `apps/enigma/src/components/sketch/`.
>
> Restored: `sketchModel.ts`, `useSketch.ts`, `SketchCanvas.vue`,
> `SketchToolbar.vue`, both test files, and the `sketch.*` i18n namespace.
>
> **Still parked here:**
> * `components/sketchExport.ts` — SVG/PNG **export to an arbitrary path**. The
>   editor writes the open file through `writeLocalNote` instead, so this is only
>   needed to bring back "Export as PNG…". It imports `writeBase64FileToDisk` /
>   `writeTextFileToDisk`, whose Rust is still parked at `limbo/rust/fs_local.rs`
>   — and `limbo/rust/NOTES.md` recommends `@tauri-apps/plugin-fs` over restoring
>   it. Its canvas rasterizer and the WebKit pitfalls it documents are the
>   valuable part.
> * `views/EnigmaSketchView.vue` — the standalone-tab shell (route, export
>   runner, text modal, keyboard shortcuts). The editor has its own equivalents
>   in `components/local/SvgEditor.vue`; this is only useful if Sketch ever wants
>   its own tab again.
> * `i18n/*.ts.snippet` — kept as the record of what was pasted back. The live
>   catalogue drops `title`/`subtitle` (a tab had them, an editor does not) and
>   adds the refusal/opaque-notice keys.
>
> The rest of this file is the ORIGINAL park notes, left intact because its
> design rationale (board space, rotation-as-angle, validation of untrusted
> documents, palette invariants, background handling) still describes the code
> that came back. Where it says "the board" read "the open document", and note
> that the kv document keys and the module singleton are gone.

---

# Sketch board (parked 2026-07-27)

A standalone **local** drawing board: freehand strokes, boxed shapes, arrows and
text on a 1080-unit-tall elastic-width sheet, persisted in the encrypted kv store
and exported as SVG or PNG. It was the **Sketch** sub-tab of the Notes tab (beside
the group Board and the Mind map); the Notes tab went with the same cut and is
parked at `../notes-shell/`.

Nothing here is shared. The board is not tied to a chat room, never rides the MLS
`onSync`/`sendSync` seam, registers no sync handler, and its kv namespace is absent
from every sync allow-list. It had **no dedicated Rust module** — the only Rust it
used was the two-command `fs_local.rs` save-to-disk helper, parked at
`../../rust/fs_local.rs`.

These files are **not compiled or referenced** (this directory is outside the npm
`workspaces` globs and outside the `src-tauri` crate) and are **not maintained**.

## Relationship to `../sketch-collab/`

Two parks, two halves of the same feature, taken at two different times:

- **`../sketch-collab/` (parked 2026-07-20)** — the *collaboration engine*. The board
  originally shipped as a per-room shared whiteboard (LWW-element-set CRDT + hybrid
  logical clock, live stroke streaming, snapshots for late joiners) and was cut back
  to the local editor. Its `useSketch.ts` and `sketchModel.crdt.ts` are the wire
  protocol and the CRDT document.
- **this park (2026-07-27)** — the *drawing half* that stayed behind: shapes,
  geometry, SVG serialization, rotation, the toolbar, the canvas and local kv
  persistence. This is the whole board as users last saw it.

**Restore this park first.** The collab park's own checklist is written against a
live `sketchModel.ts` to reconcile with, and its wire format predates `rot` (added
after it was parked), so it must be re-derived from whatever this park's model has
become. Note also that `sketch-collab/useSketch.ts` and `sketch/components/useSketch.ts`
are different files that both claim `apps/enigma/src/components/sketch/useSketch.ts` —
restoring both is a merge, not two copies.

## Design

### Local by construction

kv namespace `sketch`, scope `default`, **three keys**:

| key | holds |
|---|---|
| `""` | the shape document, `JSON.stringify(SketchDoc)` |
| `"background"` | the board background image, a base64 data URL |
| `"palette"` | the seven colour slots, a JSON array of hex strings |

The empty document key is the single-record convention already used by `contacts`
and `p2p:rooms`. `sketch` is not in `DEVLINK_SYNC_KV`
(`packages/rakotis/src/deviceSyncModel.ts`) or `PEER_SCOPE_KV` (`peerSyncModel.ts`);
both are **closed** allow-lists, so an unlisted namespace never leaves the device.

Three keys rather than one because **every `kvPut` is an fsync** (`kv_put` →
protasius `put_enc` → `persist`) and the three change at wildly different rates:
the document is rewritten on every pointer release (debounced 800 ms,
`flushPersist()` before unmount and before export); the background image is a
megabyte of base64 that changes only when the user picks one; the palette is a tool
preference that must outlive any one board — inside the document, clearing the board
would reset it, and on the document's debounce a swap would be lost if the app
closed inside the window.

`load()` separates a **storage** failure from a **content** parse failure, per key,
in independent `try` blocks, because the two call for opposite responses.
Unreadable storage ⇒ `loadFailed`, persistence disabled for the rest of the session
(never overwrite a board we failed to see) and said so in the UI. Readable but
corrupt ⇒ nothing left to protect, start fresh. Hence two separate gates, `ready`
for the document and `paletteReady` for the palette: gating the palette on `ready`
would let the first swap write all-defaults over a real saved palette. Folding the
parse back into the read is a regression pinned by `a corrupt stored palette` in
`tests/sketchToolbar.test.ts` — `load()` is one-shot and nothing else rewrites that
key, so one bad byte would disable palette saving across every restart.

### Singleton, not a store, not view state

`getSketch()` lazily builds the module-level `useSketch()` instance; `resetSketch()`
is the test seam. The router uses `createMemoryHistory` and unmounts views on
navigation, so a per-view ref would drop the drawing and its undo history every time
the user looked at another tab. Deliberately **not** a Pinia store — `stores/chat.ts`
documents why: Pinia's `reactive()` deep-unwraps inner refs, and the canvas and
toolbar take the whole orchestrator as a prop and read `.value` directly.

`useSketch()` takes **no** `p2p` argument and is never instantiated in
`stores/chat.ts` (contrast the collab park, where it was `useSketch(p2p)` and an
app-lifetime singleton in the store).

### Document and shape model — `sketchModel.ts`

`SketchDoc { v: 1, shapes: Shape[], background: string | null }`. Array order **is**
paint order; the last shape drawn is on top. There is no conflict resolution because
there is nothing to resolve.

Six kinds share a base of `id, kind, color, sw, opacity, fill, rot` (`sw`, not `w`,
because `rect` already uses `w`):

- `path` — flat `pts: [x0,y0,x1,y1,…]`, half the JSON of an array of pairs
- `rect` / `triangle` — `x,y,w,h`; the triangle is isoceles, inscribed in its box
- `ellipse` — `cx,cy,rx,ry`
- `arrow` — `x1,y1,x2,y2`; the head is computed, sized from `sw` and capped to the
  shaft length
- `text` — baseline `x,y` plus `tw`/`th` **measured once at creation**, so hit-testing
  and export need no font metrics

**Rotation is stored as an angle, never baked into coordinates.** `x/y/w/h` and
`cx/cy/rx/ry` are axis-aligned by definition, so baking it in would silently restrict
which shapes can turn. `rot` is applied at render time as `rotate(deg cx cy)` about
`shapePivot(s)` — the centre of the *unrotated* bounds — and hit-testing inverts
exactly that transform (`distToShapeRotated` rotates the point by `-rot` first, then
runs the rotation-unaware per-kind maths). The canvas template, the SVG exporter, the
PNG rasterizer and the selection chrome all go through the same `shapePivot`, so they
cannot disagree about where a shape turns. Resizing a rotated shape also translates
by the pivot shift, because scaling moves the bounds centre and would otherwise swing
the shape away from the corner being dragged.

Geometry: `quant()` to 0.1 board units; `MIN_POINT_DIST` 1.5 thins a ~600-sample drag
to ~150; `pathD()` is quadratic-midpoint smoothing — C1-continuous in one pass with no
lookahead, therefore **append-safe** (extending a stroke never rewrites drawn geometry);
`hitTest` walks the array backwards with tolerance `sw/2 + radius` (0 + radius for text)
rather than `document.elementFromPoint`, which cannot express an eraser radius, forces
a layout flush per pointermove and is untestable.

Validation applies only to the persisted document, which is untrusted (a corrupt or
hand-edited kv entry must not poison the renderer). Every field is rebuilt rather than
spread: `pts` goes into an SVG `d` attribute and `text` into an SVG text node. Colours
are `#rrggbb` via `COLOR_RE`; coordinate bounds are keyed to `MAX_BOARD_W`, not to the
default board, so a shape drawn near the right edge of a very wide window still
validates when the board is reopened narrow; over-long text is truncated rather than
dropping the shape; a missing or malformed `background` reads as transparent, which is
also what a pre-background document should become.

Undo/redo are whole-document snapshots (`shapes` + `background` + a *reference* to the
image data URL), capped at `UNDO_LIMIT` 100, redo cleared on a fresh action. One entry
per gesture: `beginTransform`/`endTransform` bracket a drag, and the eraser takes its
snapshot lazily at the first shape actually erased so a sweep over empty canvas costs
nothing. Palette edits are deliberately outside history — see below.

### Elastic width, fixed height

`BOARD_H = 1080` is fixed and the width is elastic. Height is what stays fixed because
it anchors the unit scale: a stroke width, a font size and every coordinate in an
already-saved board keep meaning what they meant, and a wider window only adds room on
the **right**, so nothing already drawn moves or resizes. `BOARD_W = 1920` remains the
default whenever no live width is known — a headless export, a unit test, or the first
frame before the container is measured.

`boardWidthFor(elW, elH)` matches the viewBox aspect to the element's, which is what
removes the letterbox (`preserveAspectRatio` has nothing left to letterbox once the two
agree), clamped to `MIN_BOARD_W` 540 … `MAX_BOARD_W` 6×`BOARD_H`. The live width lives
in the **orchestrator** (`boardW` / `setBoardWidth`), not in the canvas that measures
it, because the export buttons are in the view and an export must match what is on
screen; it is never persisted. `SketchCanvas.vue` measures with a `ResizeObserver`, not
a window `resize` listener — the container also changes height when the toolbar wraps
to a second row, which fires no window event.

### Seven assignable colour slots

`DEFAULT_SLOT_COLORS` (7: red, green, blue, yellow, grey, black, white) +
`EXTRA_COLORS` (10) = `PICKER_COLORS` (17). The two lists **must stay disjoint** —
`PICKER_COLORS` is the concatenation and a colour in both would render twice in the
picker and collide on its `v-for` key (`palette invariants` in
`tests/sketchModel.spec.ts` pins this, along with lowercase-hex validity and full
`COLOR_NAME_KEYS` coverage).

Slots are a **per-device tool preference, not document state**: swapping one must not
touch the drawing, ride the undo stack, or change what a board looks like when opened
elsewhere. Shape colours are validated by `COLOR_RE`, never against the palette, so a
board drawn with colours no longer on the row still loads and exports as it was.
`setSlot` guards the index and the colour separately, allows duplicates on purpose, and
moves the active stroke/fill only when the old colour has left the row **entirely** —
the pre-check on `prev` rules out the tempting "is `currentColor` still on the row?"
shortcut, which yanks an already-off-palette colour whenever any unrelated slot changes.
`normalizeSlots` falls back **per slot**, so one unrecognised stored entry does not cost
the user their other six. `COLOR_NAME_KEYS` maps each hex to `sketch.colorNames.*` —
without it a screen reader announces "number E F four four four four".

In `SketchToolbar.vue` the pencil button toggles edit mode: normally a slot click picks
a drawing colour, in edit mode it opens the reassignment picker. The invariant is
`openSlot !== null ⇒ paletteEditing`. The fill row mirrors the same seven slots and goes
`disabled` (not merely `pointer-events-none`) during edit mode, so it is inert to the
keyboard too. `tests/sketchToolbar.test.ts` mounts the real toolbar against the real
singleton because the two branches are one `if` apart in `onSlotClick`, and a
copy-paste of `pickColor` into the wrong branch would silently restyle shapes.

### Backgrounds: white / black / transparent / image

`BACKGROUND_COLORS` is `#ffffff` and `#111827` only. The other two choices are not
colours: `null` (transparent, the default) and a background image each have their own
control. **Transparent means transparent all the way through** — the SVG omits its
background rect entirely, the PNG keeps its alpha channel, and the canvas widget drops
its sunken tint so the surface drawn on is exactly the panel behind it.

The image is picked with a hidden `<input type="file">` rather than the Tauri dialog
plugin: reading needs the *bytes*, not a path, so it works identically in the desktop
webview and the browser dev build with no Rust at all (same pattern as the QR upload in
`JoinRoomModal.vue`). `backgroundImageFromFile` → `prepareBackgroundImage` crop-fills it
to the **default** board and re-encodes: PNG when small or when any pixel is not fully
opaque, otherwise JPEG q0.85. The transparency test is the point — per the HTML spec a
canvas with alpha is composited onto **black** when serialized to a format without an
alpha channel, so the earlier size-only rule flattened exactly the images that needed
alpha. `validateBackgroundImage` accepts only `data:image/(png|jpeg|webp);base64,…` up
to `MAX_BG_IMAGE_CHARS` (9,000,000): an SVG background would let arbitrary markup into
the exported file and a remote URL would make an "offline" export phone home. The crop
is baked in at import so all three renderers just draw it at the full board rect; since
it is cropped to the *default* board, on an elastic board they all cover-crop
(`preserveAspectRatio="xMidYMid slice"` in SVG, a `cover` `drawImage` on canvas) rather
than stretch.

### Export — `sketchExport.ts`

SVG is serialized **from the model, not the live DOM**: the DOM also holds the
in-progress preview, selection handles, the eraser ring, Vue's scoping attributes and
Tailwind classes, and export must work regardless of what is on screen. `width`/`height`
are emitted explicitly because a dimensionless SVG rasterizes at 0×0 in WebKit, and all
text/colour output is escaped.

PNG is drawn directly with Canvas2D from the same model, not by loading the SVG into an
`<img>`: in a WebKit webview a dimensionless SVG image rasterizes at 0×0, fonts inside
an SVG `<img>` resolve against a separate context so text can silently vanish, and
canvas-taint rules vary enough that `toDataURL` can throw. Both renderers share
`pathD`, `arrowHead`, `trianglePoints`, `shapePivot` and `SVG_FONT_STACK`, so they
cannot drift. A translucent **filled** shape is painted opaquely into a reused scratch
layer and blitted once, reproducing SVG's single element-level composite (Canvas2D's
`globalAlpha` would darken the band where a thick stroke overlaps its own fill); rects
force `lineJoin = "miter"`, matching SVG's `<rect>` default.

Both exporters take the live `boardW`, and the view calls `flushPersist()` first so
what lands on disk matches what is saved. In Tauri they call
`@tauri-apps/plugin-dialog`'s `save()` and then **`writeTextFileToDisk` /
`writeBase64FileToDisk`** — the parked Rust. In a browser they fall back to a blob
download.

## As parked

| file | was at | what it is |
|---|---|---|
| `views/EnigmaSketchView.vue` | `apps/enigma/src/views/EnigmaSketchView.vue` | the tab shell: text-entry modal, clear confirm, image file input, export runner, keyboard shortcuts (Ctrl/Cmd+Z, Ctrl+Y, Delete, Escape) |
| `components/SketchCanvas.vue` | `apps/enigma/src/components/sketch/SketchCanvas.vue` | the SVG surface: pointer→board mapping, gesture state machine, `ResizeObserver`, previews, selection box + resize/rotate handles, eraser ring |
| `components/SketchToolbar.vue` | `apps/enigma/src/components/sketch/SketchToolbar.vue` | tools, palette slots + picker, width/opacity/fill, background row, rotation field, history and export buttons |
| `components/sketchModel.ts` | `apps/enigma/src/components/sketch/sketchModel.ts` | pure model: board space, palette, shapes, geometry, validation, SVG serialization. No Vue/Tauri/DOM imports |
| `components/useSketch.ts` | `apps/enigma/src/components/sketch/useSketch.ts` | orchestrator + `getSketch`/`resetSketch` singleton: kv persistence, undo/redo, tool state, creation, selection, transforms, erase |
| `components/sketchExport.ts` | `apps/enigma/src/components/sketch/sketchExport.ts` | the canvas/DOM/Tauri half: SVG + PNG save, the rasterizer, background-image import |
| `tests/sketchModel.spec.ts` | `apps/enigma/tests/unit/sketchModel.spec.ts` | model unit tests (geometry, rotation, validation, palette invariants, elastic width, `toSvg`) |
| `tests/sketchToolbar.test.ts` | `apps/enigma/tests/component/sketchToolbar.test.ts` | toolbar/palette component tests against the real singleton |
| `i18n/en.ts.snippet`, `i18n/pl.ts.snippet` | `apps/enigma/src/i18n/{en,pl}.ts` | the `nav.sketch` key + the whole `sketch` namespace |

Outside this directory, but part of the same feature:

- `../../rust/fs_local.rs` — was `apps/enigma/src-tauri/src/fs_local.rs`
- `../../rust/fs_local_wrappers.ts.snippet` — was in `packages/rakotis/src/services/appStorage.ts`
- `../notes-shell/` — the Notes tab that hosted this board as a sub-tab
- `../sketch-collab/` — the older collaboration park (see above)

## Restore checklist

1. **Move the six source files back** to the paths in the table above
   (`apps/enigma/src/views/EnigmaSketchView.vue` and
   `apps/enigma/src/components/sketch/{SketchCanvas,SketchToolbar}.vue`,
   `{sketchModel,useSketch,sketchExport}.ts`). Their imports use the original relative
   paths — move the files, don't rewrite the imports.

2. **Move the two test files back**, to *different* directories:
   `tests/sketchModel.spec.ts` → `apps/enigma/tests/unit/sketchModel.spec.ts`,
   `tests/sketchToolbar.test.ts` → `apps/enigma/tests/component/sketchToolbar.test.ts`.
   Both are covered by `vitest.config.ts`'s `include` globs at those paths.

3. **Restore the Rust.** `../../rust/fs_local.rs` → `apps/enigma/src-tauri/src/fs_local.rs`;
   re-add `mod fs_local;` in `src-tauri/src/lib.rs` (it sat between `mod tor;` and
   `mod local_lock;`); re-add the two `invoke_handler` entries
   `fs_local::fs_write_text_file` and `fs_local::fs_write_base64_file` (they sat between
   `beacon::beacon_delete_route` and `local_lock::local_lock_file`). No new crate:
   `data_encoding` is already a dependency, and these are **app** commands, not plugin
   commands, so no capability entry is needed. `@tauri-apps/plugin-dialog` (package.json)
   and `tauri-plugin-dialog = "2"` (Cargo.toml) are both still present, so `save()` needs
   nothing.
   *Alternative:* replace both writes with the Tauri fs plugin, in which case
   `sketchExport.ts`'s two imports change and steps 3–4 are skipped entirely.

4. **Restore the two rakotis wrappers.** Paste `../../rust/fs_local_wrappers.ts.snippet`
   into `packages/rakotis/src/services/appStorage.ts` (it sat after `removeNoteRecent`,
   before the "Local-file key-rotation reminder interval" section). `isTauri` and
   `invoke` are already imported there, and `packages/rakotis/src/index.ts` does
   `export * from "./services/appStorage"`, so there is nothing else to export.

5. **Restore the build-config keys across the four coordinated files.** `RawConfig` is
   `#[serde(deny_unknown_fields)]`, and *all four* YAMLs are parsed by the same struct,
   so the struct and every YAML must land together or the build fails.

   a. `apps/enigma/src-tauri/build_config.yaml` (the annotated reference copy), after
      `peers:`:
      ```yaml
      sketch:
        # false = this build has no sketch board: no Sketch tab and /sketch redirects.
        # The board is local and standalone — nothing is shared with room members.
        enabled: true
        # Caps enforced in the composable + validators (memory / render cost).
        max_shapes_per_board: 1000
        max_text_len: 200
      ```
   b. `apps/enigma/src-tauri/configs/build_config.{light,plus,pro}.yaml` — same three
      keys, `enabled: false  # Pro only` in light and plus, `true` in pro. Also put
      `sketch` back in each file's header `IN:`/`OUT:` comment.
   c. `apps/enigma/src-tauri/build.rs` — the `SketchSection` struct (`enabled`,
      `max_shapes_per_board`, `max_text_len`), the `sketch: SketchSection` field on
      `RawConfig`, the `// sketch.` validation loop asserting both caps are `> 0`, the
      `pub mod sketch {{ … }}` codegen block (`ENABLED`, `MAX_SHAPES_PER_BOARD`,
      `MAX_TEXT_LEN`), and the three `format!` args (`sketch_enabled`,
      `sketch_max_shapes`, `sketch_max_text`).
   d. `apps/enigma/src-tauri/src/lib.rs` — `sketch_enabled: bool`,
      `sketch_max_shapes_per_board: u32`, `sketch_max_text_len: u32` on
      `BuildConfigSummary`; `sketch` back in the `use build_config::{…}` list in
      `app_get_build_config`; the three initializers.
   e. `packages/rakotis/src/services/appStorage.ts` — the same three fields on the
      `BuildConfig` interface (with their doc comments) **and** in
      `FALLBACK_BUILD_CONFIG` (`true`, `1000`, `200`). The fallback is what the vitest
      environment sees; `apps/enigma/tests/setup.ts` seeds nothing sketch-specific and
      needs no change.

   `useSketch()` reads `cfg.sketch_max_shapes_per_board` / `cfg.sketch_max_text_len` at
   construction, so do this **with** the code, not after it.

6. **Paste both i18n snippets.** `i18n/en.ts.snippet` → `apps/enigma/src/i18n/en.ts`,
   `i18n/pl.ts.snippet` → `apps/enigma/src/i18n/pl.ts`. Each snippet has two parts: the
   nav key (`sketch: "Sketch"` / `"Szkic"`) goes inside the `nav:` block, the `sketch: {…}`
   namespace at the top level. The two locales must stay in **exact** key lockstep —
   `tests/unit/i18n.test.ts` compares their trees. Note `sketch.title` and
   `sketch.subtitle` are in the snippets but nothing in the parked code references them
   (leftovers from when Sketch was its own top-level tab with a header); keep them or
   delete them from **both** files.

7. **Routing and nav** — pick one:

   a. *Own tab.* Add to `apps/enigma/src/router/index.ts`:
      `{ path: "/sketch", component: EnigmaSketchView, name: "sketch", beforeEnter: () => getBuildConfig().sketch_enabled || "/chat" }`.
      `beforeEnter` (not a top-level `if`) because it must run after `initBuildConfig`
      resolves. Then a nav link in `apps/enigma/src/App.vue`, in **both** the desktop row
      and the mobile menu: `to="/sketch"`, `icon="pencil"`, `$t('nav.sketch')`, guarded by
      `const sketchEnabled = getBuildConfig().sketch_enabled`.
      **No attention dot** — Sketch has no remote events; do not add one.

   b. *Back under Notes.* Additionally restore
      `../notes-shell/views/EnigmaNotesView.vue` → `apps/enigma/src/views/`, its `/notes`
      route + guard, the `/board` `/sketch` `/mind` redirects, the `nav.notes` key from
      `../notes-shell/{en,pl}.nav.snippet`, and re-register `faNoteSticky` in
      `apps/enigma/src/main.ts` (both the import and the `library.add` call were removed).
      The shell as parked imports all three sibling views and reads `kanban_enabled` /
      `mind_enabled` — either restore those features too or trim the shell down to Sketch.

8. **Icons: nothing to re-add for Sketch.** Every FontAwesome icon this feature uses is
   still registered in `apps/enigma/src/main.ts` — `arrow-pointer`, `pencil`, `square`,
   `circle`, `play`, `arrow-right`, `font`, `eraser`, `ban`, `image`, `file-image`,
   `xmark`, `rotate`, `rotate-left`, `rotate-right`, `trash`, `broom`, `download`,
   `check`, `triangle-exclamation`. Verify before assuming; a later cleanup may have
   pruned them. (`faNoteSticky` and `faDiagramProject` *were* removed, but they belong to
   the Notes shell and Mind.)

9. **No dependencies to reinstall and no bundler config to change.** Sketch adds no npm
   package; `cytoscape` / `trix` and the `isCustomElement` + alias entries removed from
   `vite.config.ts` / `vitest.config.ts` belonged to Mind.

10. **Keep `sketch` out of the sync allow-lists.** `DEVLINK_SYNC_KV`
    (`packages/rakotis/src/deviceSyncModel.ts`) and `PEER_SCOPE_KV`
    (`packages/rakotis/src/peerSyncModel.ts`) are closed lists; adding the namespace turns
    a device-local board into a different feature with a different threat model. The board
    stays local by omission.

11. **Run the gates**, from `apps/enigma`:
    - `npx vitest run tests/unit/sketchModel.spec.ts tests/component/sketchToolbar.test.ts tests/unit/i18n.test.ts`, then the full unit/component suites.
    - `npx vue-tsc --noEmit`.
    - `cargo test` in `src-tauri` — `fs_local.rs` carries its own three tests
      (base64 round-trip, malformed base64 leaves no file, text round-trip).
    - A full `cargo build` / `npm run build`, which regenerates `build_config_gen.rs`
      and re-runs the `build.rs` validation from step 5.

    `tests/unit/chatStore.test.ts`'s `onSync` call-count assertion does **not** change:
    Sketch registers no sync handler.

12. **Clean up the park.** Delete this directory and drop its entry from
    `limbo/README.md`, moving it to that file's "Restored so far" list.

## Caveats

- **It does not typecheck against the live tree and has not been run since parking.**
  It passed `vue-tsc` and its tests at the moment it was cut, and nothing has been
  verified since. Things it reaches into that may have moved: `getBuildConfig`,
  `kvGet`/`kvPut`/`kvDelete`, and `OyaButton`/`OyaModal`/`OyaTextField`/`OyaIconButton`
  from `rakotis`; the Tailwind tokens it styles with (`bg-sunken-light`, `text-warn-dark`,
  `border-accent-2`, `bg-bubble-bg-light`, `bg-accent-light`, …); and `../../src/i18n` in
  the toolbar test.
- The parked files still import each other by their **original** relative paths, and the
  tests import `../../src/components/sketch/…`. They resolve only once everything is back
  where it came from.
- `sketch_max_shapes_per_board` and `sketch_max_text_len` no longer exist anywhere in
  `BuildConfig`. Restore the code without step 5 and `caps` is `{ undefined, undefined }`:
  `atCapacity()` is never true, `validateDoc` drops every shape it loads, and text is
  sliced to `undefined`. Config and code go back together.
- `tests/sketchToolbar.test.ts` scopes its queries by English `title` attributes
  (`[title='Colour']`, `[title='Fill']`), so it depends on the `en` snippet being restored
  verbatim. Retranslating those two strings breaks the test, not the app.
- **The user data outlived the code.** Parking removed the feature, not the kv records:
  anyone who drew a board before this cut still has `sketch:default:{"",background,palette}`
  sitting in their encrypted store. Restoring the code re-surfaces those boards, and
  `validateDoc` / `validateBackgroundImage` are the only things between an old record and
  the renderer — do not "simplify" them away on the grounds that the writer is trusted.
- `build.md` (feature-flag list, `ENIGMA_EDITION` example) and `pland.md` (edition matrix,
  `sketch.enabled` row) were **not** updated when this was parked and still describe Sketch
  as a live Pro feature. Restoring the flag makes them true again; restoring the board
  *without* a build flag means fixing those references instead.
