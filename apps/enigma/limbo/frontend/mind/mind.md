# Mind — implementation plan (mind.md)

**Status: IMPLEMENTED 2026-07-26** — rakotis 193 vitest · enigma 482 vitest ·
cargo 108 · Playwright 14 · vue-tsc + vite build clean · all three edition
configs cargo-check clean.

## Deviations from the original plan (all user-directed, mid-build)

- Node **content became Trix rich-text HTML**: `trix` 2 was added as a bundled
  dep, `mind.max_content_len` grew 4000 → 20000 (markup inflates), and a
  content scrub (`scrubContentHtml`) runs at validation + in the editor,
  because the webview ships without a CSP (see Risks).
- Node text editing moved from the side inspector into **one edit modal**
  (`MindNodeEditModal`): buffered drafts, Save (one `commitNodeEdit` = one
  undo step) / Discard, content as rich (Trix) OR plain text (converted via
  `htmlToPlainText`/`plainTextToHtml` on toggle and save). Opened from the ✎
  chip on the selected node, the inspector's Edit button, F2, node creation,
  and the Topics tab. The inspector keeps quick actions + edge editing.
- The originally-planned **dump inbox was built and then replaced** by the
  **Topics sub-tab**: a list of topic hubs; a read-only details modal
  (description via read-only Trix, linked nodes in either direction,
  scrollable) with **Add note** — creates a note wired **note → topic** (that
  direction, per user decision) and hands it to the shared edit modal. All
  dump machinery (second kv key, two caps, model types, i18n) was removed,
  not dormant-ified.
- Export/import is **JSON**, not the originally-requested XML (NeoJSON-inspired
  self-describing shape).
- The canvas syncs from the doc with a **single diff watcher** instead of
  per-call-site cy patching — mutations from the view, inspector, modal,
  Topics tab and undo all flow through one place.

## Decision log (Q&A, 2026-07-26)

- D1 → export/import format is **JSON** (`format`/`version`/`metadata` +
  `nodes[]`/`edges[]`), not XML.
- D2 → edges are **directed** (arrows); collapse means the outgoing-descendant
  subtree.
- D3 → topics are **topic nodes** (visually distinct hexagonal hubs); "linked
  by topic" is an ordinary labeled edge; one single graph.
- D4 → import **replaces** the whole map after a confirmation showing the
  *validated* counts; one Undo restores the previous map.
- D5 → **no new graph deps**: cytoscape core only (already a dormant dep);
  connect/reconnect/collapse are hand-built. `trix` is the one new dep,
  bundled and offline (see Risks for the no-leak guards).
- D6 → notes added from a topic's details attach **note → topic** (the edge
  points from the new node at the topic).

## 1. Scope

**In:** Mind tab (Pro edition) with Map + Topics sub-tabs; one directed graph
per profile; note/topic nodes (title + rich content), labeled edges;
create/delete/connect/**reconnect**; the shared node edit modal (Save/Discard,
rich/plain content); collapse-a-branch with derived visibility; positions
persisted; debounced autosave; whole-doc undo/redo (100); breadthfirst
auto-arrange + zoom-to-fit; JSON export/import; Topics browser (read-only
details + add-note); en/pl i18n; unit, component and e2e coverage;
build-config gate + caps.

**Out (explicitly):** any sharing or sync (no chat cards, no device-link, no
peer-link — ns `mind` is pinned OUT of both allow-lists), multiple maps,
meta-edges across collapse boundaries, Trix attachments (blocked by design),
canvas minimap/box-select, editing from the Topics details modal (read-only by
design — the Edit door is the shared modal), Rust-side code of any kind.

## 2. Core decisions (each names its in-repo template)

| Decision | Template |
| --- | --- |
| Zero Rust; sealed kv is already encrypted at rest | Sketch (`useSketch.ts` header) |
| Module singleton, NOT Pinia (memory router unmounts views) | `useSketch.ts:12-17` |
| Debounced doc key, `ready`/`loadFailed` split | `useSketch.ts` persistence block |
| Whole-doc undo snapshots, drag = one entry, session snapshot for edge labels | `useSketch.ts` undo + eraser pattern |
| Sub-tab pills | `EnigmaFilesView.vue` |
| Build gate + caps chain (yaml ×4 → build.rs → lib.rs → appStorage) | `sketch:`/`kanban:` blocks |
| Export = save dialog + `writeTextFileToDisk`, blob fallback; import = hidden file input + FileReader | `sketchExport.ts` / `EnigmaSketchView.vue` |
| Canvas theming from CSS tokens, re-read per theme flip | toto bento `colors(dark)` pattern |
| Heavy-lib vitest stub + alias | `tests/stubs/maplibre.ts` |

## 3. Data model

`apps/enigma/src/components/mind/mindModel.ts` (pure): `MindNode { id(nanoid),
kind: "note"|"topic", title, content(Trix HTML, opaque+scrubbed), x, y,
collapsed }`, `MindEdge { id, source, target, label }`, `MindDoc { v:1, nodes,
edges }`.

Validation rebuilds every field (never spreads): empty title drops the node,
overlong text slices, coords bounded ±1e6, self-loops and dangling edges drop,
duplicate ids keep the first, caps truncate (nodes first, edges against the
survivors). `scrubContentHtml` strips figures/img/script/iframe/etc. and
non-http(s)/mailto hrefs from content. `plainTextToHtml`/`htmlToPlainText`
carry the edit modal's plain-text mode (lossy rich→plain by design).

Export file: `{ format: "enigma-mind", version: 1, exportedAt, metadata:
{ nodeCount, edgeCount }, nodes, edges }` — the discriminator is checked before
anything else; the metadata is informational and never trusted (the confirm
modal shows validated counts).

Persistence: ns `mind`, scope `default`, key `""` — one doc, debounced 800 ms
(every kvPut is an fsync).

## 4. Collapse rule (the one piece of graph theory)

Hidden ⇔ unreachable except through a collapsed frontier — NOT "any collapsed
ancestor", which would punch holes in other expanded subtrees around
cross-linked topic hubs. Two O(V+E) passes in `computeHiddenNodes`
(`mindGraphModel.ts`): candidates below any collapsed node, then a visibility
flood from all non-candidates through non-collapsed nodes. A collapsed root is
seeded out of its own candidacy, so cycles can never hide it. Badge counts =
descendants ∩ hidden (overlaps between hubs are honest). Boundary edges simply
disappear (cytoscape doesn't render an edge with a hidden endpoint) — no
meta-edges in v1. Note: a Topics-tab note attaches note → topic, so collapsing
the topic does NOT tuck those notes away — collapse follows outgoing edges.

## 5. Rust backend

None. Only the build gate: `mind:` block (enabled + four caps) in
`build_config.yaml` and all three `configs/build_config.{light,plus,pro}.yaml`
(light/plus `false`, pro `true`), `MindSection` + validate + codegen in
`build.rs`, five fields through `BuildConfigSummary`/`app_get_build_config`.

## 6. rakotis additions

None in source (local-only = **omission** from `DEVLINK_SYNC_KV` and
`PEER_SCOPE_KV`). Changes: `BuildConfig` + `FALLBACK_BUILD_CONFIG` mind fields
(`appStorage.ts`), the allow-list comment names `mind` as deliberately
device-local (`deviceSyncModel.ts`), and negative pinning assertions in
`deviceSyncModel.test.ts` / `peerSyncModel.test.ts`.

## 7. App frontend

| File | Role |
| --- | --- |
| `views/EnigmaMindView.vue` | Sub-tab shell (Map/Topics), header + export/import + confirm modal, failure banner, keyboard (Ctrl+Z/Y; Delete/Space/F2 map-only, all silent while the edit modal is open), hosts the shared `MindNodeEditModal`, load/flush lifecycle |
| `components/mind/mindModel.ts` | Pure model + validation + export shape + scrub + plain⇄rich conversion (§3) |
| `components/mind/useMind.ts` | Singleton orchestrator: persistence gates, undo, all mutations (`commitNodeEdit`, `addNoteToTopic`, …), UI seams (`editNodeId`, `reconnectRequest`, viewport cache) |
| `components/mind/mindGraphModel.ts` | Pure canvas logic: collapse sets + counts, element defs, edge validation, layout roots, materialization, ring placement |
| `components/mind/mindGraphStyle.ts` | Palette from CSS tokens + the full static cytoscape stylesheet |
| `components/mind/MindGraph.vue` | cy lifecycle, doc→cy diff watcher, gesture state machine (two-click connect + ghost rubber band, reconnect via `ele.move()`), DOM overlays (✎ edit chip, ⊖/⊕ collapse chip, endpoint handles, hint), auto-layout/fit, Esc/F keys |
| `components/mind/MindMapPanel.vue` | Toolbar + graph + inspector composition; owns the tool ref |
| `components/mind/MindToolbar.vue` | Tool modes, undo/redo, auto-arrange, zoom-fit |
| `components/mind/MindInspector.vue` | Side panel: selection summary + Edit door, collapse/expand, delete; full edge editing (label/swap/reattach/delete) |
| `components/mind/MindNodeEditModal.vue` | THE node editor: buffered drafts, kind toggle, rich/plain content, Save (one undo step) / Discard |
| `components/mind/MindTopicsPanel.vue` | Topics browser: list + read-only details modal + add-note handoff |
| `components/mind/MindRichText.vue` | Trix wrapper: modelValue bridge, attachment refusal, capture-phase paste scrub, `readonly` display mode |
| `components/mind/mindExport.ts` | JSON save (dialog/blob) + file read with stable error codes |
| router / `App.vue` / `main.ts` / i18n | Route gate, two nav links, six icons, `mind:` namespace en+pl |
| `vitest.config.ts` + `tests/stubs/{cytoscape,trix}.ts` | jsdom stand-ins; trix custom elements flagged in both vite configs |
| `src/style.css` | Trix theming vs Tailwind v4 layers + dark mode; attach button hidden; readonly mode |

## 8. Tests

- `tests/unit/mindModel.spec.ts` (32) — validation matrix, round-trip, caps,
  scrub, plain⇄rich conversion.
- `tests/unit/mindGraphModel.spec.ts` (17) — the collapse contract (chains,
  diamonds, cycles, self-cycle, nesting, cross-linked hubs), counts, elements,
  edge validation, roots, materialization, placement.
- `tests/unit/useMind.test.ts` (23) — persistence gates (no write before
  ready, 800 ms debounce), undo bookkeeping (drag = one step, modal commit =
  one step, add-note-to-topic = atomic, bounded at 100), mutation guards,
  import replace.
- `tests/component/mind.test.ts` (17) — view/pills/banner, import flow
  end-to-end, edit modal (seed/save/discard/plain-mode/self-close), Topics
  list + details + add-note handoff, inspector summary + edge editing.
- rakotis pinning — `isSyncableKv("mind", …) === false`,
  `isPeerWritableNs("mind") === false`.
- `tests/e2e/mind.spec.ts` — real build: canvas height > 0 probe + cytoscape
  canvas attached; add-topic → edit modal → Topics details → add note →
  persists across reload (flush on navigation, localStorage kv fallback).
- Gates: vitest rakotis 193 · vitest enigma 482 · cargo 108 + 3× edition
  cargo check · vue-tsc + vite build · Playwright 14.

## 9. Docs

technology.md §3 (cytoscape + trix active, dormant list corrected), §10 (Mind
tab bullet), §13 (mind at-rest + scrub note), §15 (mind config row); build.md
(kill-switch bullet); pland.md (feature matrix row + Out lists). This file.

## 10. Build order (as executed — each step ended green)

1. `mindModel.ts` + spec → 2. build-gate chain (atomic) → 3. sync pinning →
4. `useMind.ts` + tests → 5. tab skeleton (router/App/i18n/stubs) →
6. canvas wiring + `mindGraphModel` spec → 7. inspector + Trix (+ offline/leak
hardening) → 8. export/import → 9. e2e → 10. edit modal + Topics tab replace
the dump (user pivot; caps chain shrunk in lockstep) → 11. docs.

## 11. Risks & accepted limitations

- **No webview CSP** (`tauri.conf.json csp: null`): content HTML is therefore
  scrubbed at every boundary (validation + paste) and attachments are refused;
  a real CSP remains the roadmap fix (technology.md §9).
- Regex scrub is defense-in-depth, not a sanitizer — safe because content only
  ever renders through Trix's parser (editable or read-only), never `v-html`.
- One modal at a time: OyaModal backdrops stack in MOUNT order, not open
  order, so the Topics details modal closes before the edit modal opens (a
  stacked backdrop would swallow the editor's clicks — found by e2e).
- Collapse hides; it never deletes. Deleting a collapsed node deletes only the
  node + its edges; formerly hidden descendants resurface (orphans become
  visible roots) rather than silently dying.
- Topics-attached notes (note → topic) are upstream of the topic, so they
  don't fold under it — documented behavior of D6's edge direction.
- Browser/vitest kv fallback is plaintext localStorage — the documented,
  accepted degradation shared by every feature.
- Parallel-edge imports are legal (bezier bundles them); the *editor* refuses
  same-direction duplicates.

## 12. Full changed/new file list

```
apps/enigma/src/components/mind/mindModel.ts        +  pure model/validation/scrub/export shape
apps/enigma/src/components/mind/useMind.ts          +  singleton orchestrator
apps/enigma/src/components/mind/mindGraphModel.ts   +  collapse/elements/layout logic
apps/enigma/src/components/mind/mindGraphStyle.ts   +  palette + cytoscape stylesheet
apps/enigma/src/components/mind/MindGraph.vue       +  canvas: gestures, diff sync, overlays
apps/enigma/src/components/mind/MindMapPanel.vue    +  map sub-tab composition
apps/enigma/src/components/mind/MindToolbar.vue     +  tools/history/layout bar
apps/enigma/src/components/mind/MindInspector.vue   +  side panel: summary + edge editing
apps/enigma/src/components/mind/MindNodeEditModal.vue +  THE node editor (Save/Discard, rich/plain)
apps/enigma/src/components/mind/MindTopicsPanel.vue +  topics browser + details + add-note
apps/enigma/src/components/mind/MindRichText.vue    +  Trix wrapper (offline, no-leak, readonly)
apps/enigma/src/components/mind/mindExport.ts       +  JSON export/import plumbing
apps/enigma/src/views/EnigmaMindView.vue            +  tab shell + import confirm + edit modal host
apps/enigma/src/router/index.ts                     ~  /mind route (gated)
apps/enigma/src/App.vue                             ~  nav links + flag
apps/enigma/src/main.ts                             ~  6 icons
apps/enigma/src/i18n/{en,pl}.ts                     ~  nav.mind + mind: namespace
apps/enigma/src/style.css                           ~  trix theme/dark/readonly rules
apps/enigma/src/vite-env.d.ts                       ~  declare module "trix"
apps/enigma/vite.config.ts                          ~  trix-* custom elements
apps/enigma/vitest.config.ts                        ~  cytoscape/trix stubs + custom elements
apps/enigma/package.json                            ~  + trix
apps/enigma/tests/stubs/cytoscape.ts                +  jsdom core stand-in
apps/enigma/tests/stubs/trix.ts                     +  inert trix
apps/enigma/tests/unit/mindModel.spec.ts            +
apps/enigma/tests/unit/mindGraphModel.spec.ts       +
apps/enigma/tests/unit/useMind.test.ts              +
apps/enigma/tests/component/mind.test.ts            +
apps/enigma/tests/e2e/mind.spec.ts                  +
apps/enigma/src-tauri/build_config.yaml             ~  mind: block
apps/enigma/src-tauri/configs/build_config.*.yaml   ~  mind: block ×3 + header lists
apps/enigma/src-tauri/build.rs                      ~  MindSection/validate/codegen
apps/enigma/src-tauri/src/lib.rs                    ~  BuildConfigSummary + command
packages/rakotis/src/services/appStorage.ts         ~  BuildConfig + fallback
packages/rakotis/src/deviceSyncModel.ts             ~  allow-list comment names mind
packages/rakotis/tests/unit/deviceSyncModel.test.ts ~  negative pinning
packages/rakotis/tests/unit/peerSyncModel.test.ts   ~  negative pinning
technology.md · build.md · pland.md · mind.md       ~/+ docs
```
