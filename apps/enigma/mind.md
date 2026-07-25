# Mind — implementation plan (mind.md)

**Status: IMPLEMENTED 2026-07-26** — rakotis 195 vitest · enigma 484 vitest ·
cargo 108 · Playwright 14 · vue-tsc + vite build clean · all three edition
configs cargo-check clean.

## Deviations from this plan

- Node **content became Trix rich-text HTML** mid-build (user request): `trix` 2
  was added as a bundled dep, `mind.max_content_len` grew 4000 → 20000 (markup
  inflates), dump→node conversion escapes plain text (`plainTextToHtml`), and a
  content scrub (`scrubContentHtml`) runs at validation + in the editor, because
  the webview ships without a CSP (see Risks).
- Export/import is **JSON**, not the originally-requested XML (user decision;
  NeoJSON-inspired self-describing shape).
- The canvas syncs from the doc with a **single diff watcher** instead of
  per-call-site cy patching + a revision counter — mutations from the view,
  inspector, dump link and undo all flow through one place.
- The interaction plan's hover collapse-chip became a **selected-node** chip
  (touch-friendly, less overlay churn); double-tap and Space cover the fast path.

## Decision log (Q&A, 2026-07-26)

- D1 → export/import format is **JSON** (NeoJSON-style `format`/`version`/
  `metadata` + `nodes[]`/`edges[]`), not XML.
- D2 → edges are **directed** (arrows); collapse means the outgoing-descendant
  subtree.
- D3 → topics are **topic nodes** (a visually distinct hexagonal hub); "linked
  by topic" is an ordinary labeled edge; one single graph.
- D4 → linking a dump entry to a topic **converts it to a note node**
  (first line → title, rest → content) under a topic→note edge and removes it
  from the dump — the dump is an inbox, not an archive.
- D5 → import **replaces** the whole map after a confirmation showing the
  *validated* counts; one Undo restores the previous map.
- D6 → **no new graph deps**: cytoscape core only (already a dormant dep);
  connect/reconnect/collapse are hand-built. `trix` is the one new dep (D-Trix
  above), bundled and offline.

## 1. Scope

**In:** Mind tab (Pro edition) with Map + Dump sub-tabs; one directed graph per
profile; note/topic nodes (title + rich content), labeled edges;
create/edit/delete/connect/**reconnect**; collapse-a-branch with derived
visibility; positions persisted; debounced autosave; whole-doc undo/redo (100);
breadthfirst auto-arrange + zoom-to-fit; JSON export/import; dump inbox with
immediate persistence and link-to-topic conversion; en/pl i18n; unit, component
and e2e coverage; build-config gate + caps.

**Out (explicitly):** any sharing or sync (no chat cards, no device-link, no
peer-link — ns `mind` is pinned OUT of both allow-lists), multiple maps,
meta-edges across collapse boundaries, Trix attachments (blocked by design),
canvas minimap/box-select, Rust-side code of any kind.

## 2. Core decisions (each names its in-repo template)

| Decision | Template |
| --- | --- |
| Zero Rust; sealed kv is already encrypted at rest | Sketch (`useSketch.ts` header) |
| Module singleton, NOT Pinia (memory router unmounts views) | `useSketch.ts:12-17` |
| Debounced doc key + immediate second key, `ready`/`loadFailed` split | `useSketch.ts` persistence block |
| Whole-doc undo snapshots, drag = one entry, lazy session snapshot for typing | `useSketch.ts` undo + eraser pattern |
| Sub-tab pills | `EnigmaFilesView.vue` |
| Build gate + caps chain (yaml ×4 → build.rs → lib.rs → appStorage) | `sketch:`/`kanban:` blocks |
| Export = save dialog + `writeTextFileToDisk`, blob fallback; import = hidden file input + FileReader | `sketchExport.ts` / `EnigmaSketchView.vue` |
| Canvas theming from CSS tokens, re-read per theme flip | toto bento `colors(dark)` pattern |
| Heavy-lib vitest stub + alias | `tests/stubs/maplibre.ts` |

## 3. Data model

`apps/enigma/src/components/mind/mindModel.ts` (pure): `MindNode { id(nanoid),
kind: "note"|"topic", title, content(Trix HTML, opaque+scrubbed), x, y,
collapsed }`, `MindEdge { id, source, target, label }`, `MindDoc { v:1, nodes,
edges }`, `MindDumpEntry { id, text, createdAt }`, `MindDump { v:1, entries }`.

Validation rebuilds every field (never spreads): empty title drops the node,
overlong text slices, coords bounded ±1e6, self-loops and dangling edges drop,
duplicate ids keep the first, caps truncate (nodes first, edges against the
survivors). `scrubContentHtml` strips figures/img/script/iframe/etc. and
non-http(s)/mailto hrefs from content.

Export file: `{ format: "enigma-mind", version: 1, exportedAt, metadata:
{ nodeCount, edgeCount }, nodes, edges }` — the discriminator is checked before
anything else; the metadata is informational and never trusted (the confirm
modal shows validated counts).

Persistence: ns `mind`, scope `default` — key `""` (doc, debounced 800 ms;
every kvPut is an fsync) and key `dump` (immediate; a capture must hit disk).

## 4. Collapse rule (the one piece of graph theory)

Hidden ⇔ unreachable except through a collapsed frontier — NOT "any collapsed
ancestor", which would punch holes in other expanded subtrees around
cross-linked topic hubs. Two O(V+E) passes in `computeHiddenNodes`
(`mindGraphModel.ts`): candidates below any collapsed node, then a visibility
flood from all non-candidates through non-collapsed nodes. A collapsed root is
seeded out of its own candidacy, so cycles can never hide it. Badge counts =
descendants ∩ hidden (overlaps between hubs are honest). Boundary edges simply
disappear (cytoscape doesn't render an edge with a hidden endpoint) — no
meta-edges in v1.

## 5. Rust backend

None. Only the build gate: `mind:` block (enabled + six caps) in
`build_config.yaml` and all three `configs/build_config.{light,plus,pro}.yaml`
(light/plus `false`, pro `true`), `MindSection` + validate + codegen in
`build.rs`, seven fields through `BuildConfigSummary`/`app_get_build_config`.

## 6. rakotis additions

None in source (local-only = **omission** from `DEVLINK_SYNC_KV` and
`PEER_SCOPE_KV`). Changes: `BuildConfig` + `FALLBACK_BUILD_CONFIG` mind fields
(`appStorage.ts`), the allow-list comment names `mind` as deliberately
device-local (`deviceSyncModel.ts`), and negative pinning assertions in
`deviceSyncModel.test.ts` / `peerSyncModel.test.ts`.

## 7. App frontend

| File | Role |
| --- | --- |
| `views/EnigmaMindView.vue` | Sub-tab shell, header + export/import buttons + confirm modal, failure banners, keyboard (Ctrl+Z/Y, Delete, Space, F2), load/flush lifecycle |
| `components/mind/mindModel.ts` | Pure model + validation + export shape + scrub + dump split (§3) |
| `components/mind/useMind.ts` | Singleton orchestrator: persistence gates, undo, all mutations, UI seams (`focusTitleRequest`, `reconnectRequest`, viewport cache) |
| `components/mind/mindGraphModel.ts` | Pure canvas logic: collapse sets + counts, element defs, edge validation, layout roots, materialization, ring placement |
| `components/mind/mindGraphStyle.ts` | Palette from CSS tokens + the full static cytoscape stylesheet |
| `components/mind/MindGraph.vue` | cy lifecycle, doc→cy diff watcher, gesture state machine (two-click connect + ghost rubber band, reconnect via `ele.move()`), DOM overlays (endpoint handles, collapse chip, hint), auto-layout/fit, Esc/F keys |
| `components/mind/MindMapPanel.vue` | Toolbar + graph + inspector composition; owns the tool ref |
| `components/mind/MindToolbar.vue` | Tool modes, undo/redo, auto-arrange, zoom-fit |
| `components/mind/MindInspector.vue` | Side panel: title (draft guard vs empty), kind toggle, Trix content, collapse/expand, edge label/swap/reattach/delete |
| `components/mind/MindRichText.vue` | Trix wrapper: modelValue bridge, attachment refusal, capture-phase paste scrub |
| `components/mind/MindDumpPanel.vue` | Capture inbox: Ctrl+Enter add, newest-first list, topic picker, delete |
| `components/mind/mindExport.ts` | JSON save (dialog/blob) + file read with stable error codes |
| router / `App.vue` / `main.ts` / i18n | Route gate, two nav links, five icons, `mind:` namespace en+pl |
| `vitest.config.ts` + `tests/stubs/{cytoscape,trix}.ts` | jsdom stand-ins; trix custom elements flagged in both vite configs |
| `src/style.css` | Trix theming vs Tailwind v4 layers + dark mode; attach button hidden |

## 8. Tests

- `tests/unit/mindModel.spec.ts` (32) — validation matrix, round-trip, caps,
  scrub, dump split.
- `tests/unit/mindGraphModel.spec.ts` (17) — the collapse contract (chains,
  diamonds, cycles, self-cycle, nesting, cross-linked hubs), counts, elements,
  edge validation, roots, materialization, placement.
- `tests/unit/useMind.test.ts` (21) — persistence gates (no write before ready,
  800 ms debounce, immediate dump), undo bookkeeping (drag = one step, link =
  atomic, bounded at 100), mutation guards, import replace.
- `tests/component/mind.test.ts` (15) — view/pills/banners, dump capture +
  topic picker, inspector forms, import flow end-to-end (validated counts,
  foreign-JSON refusal).
- rakotis pinning — `isSyncableKv("mind", …) === false`,
  `isPeerWritableNs("mind") === false`.
- `tests/e2e/mind.spec.ts` — real build: canvas height > 0 probe + cytoscape
  canvas attached, dump capture persists across reload.
- Gates run at the end: vitest rakotis 195 · vitest enigma 484 · cargo 108 +
  3× edition cargo check · vue-tsc + vite build · Playwright 14.

## 9. Docs

technology.md §3 (cytoscape + trix active, dormant list corrected), §10 (Mind
tab bullet), §13 (mind at-rest + scrub note), §15 (mind config row); build.md
(kill-switch bullet); pland.md (§ feature matrix row + Out lists). This file.

## 10. Build order (as executed — each step ended green)

1. `mindModel.ts` + spec → 2. build-gate chain (atomic) → 3. sync pinning →
4. `useMind.ts` + tests → 5. tab skeleton (router/App/i18n/stubs) →
6. canvas wiring + `mindGraphModel` spec → 7. inspector + Trix (+ offline/leak
hardening) → 8. export/import → 9. e2e → 10. docs.

## 11. Risks & accepted limitations

- **No webview CSP** (`tauri.conf.json csp: null`): content HTML is therefore
  scrubbed at every boundary (validation + paste) and attachments are refused;
  a real CSP remains the roadmap fix (technology.md §9).
- Undo covers the dump (deliberate: link-to-topic must unwind atomically), so
  Ctrl+Z on the map can also restore/remove a dump entry — one user, one doc,
  same trade sketch makes with its background image.
- Regex scrub is defense-in-depth, not a sanitizer — safe because content only
  ever renders through Trix's parser, never `v-html`.
- Collapse hides; it never deletes. Deleting a collapsed node deletes only the
  node + its edges; formerly hidden descendants resurface (orphans become
  visible roots) rather than silently dying.
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
apps/enigma/src/components/mind/MindInspector.vue   +  side-panel editor
apps/enigma/src/components/mind/MindRichText.vue    +  Trix wrapper (offline, no-leak)
apps/enigma/src/components/mind/MindDumpPanel.vue   +  dump inbox
apps/enigma/src/components/mind/mindExport.ts       +  JSON export/import plumbing
apps/enigma/src/views/EnigmaMindView.vue            +  tab shell + import confirm
apps/enigma/src/router/index.ts                     ~  /mind route (gated)
apps/enigma/src/App.vue                             ~  nav links + flag
apps/enigma/src/main.ts                             ~  5 icons
apps/enigma/src/i18n/{en,pl}.ts                     ~  nav.mind + mind: namespace
apps/enigma/src/style.css                           ~  trix theme/dark rules
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
