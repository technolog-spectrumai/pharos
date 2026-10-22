# Mind — mind map tab (parked 2026-07-27)

The Mind tab shipped 2026-07-26 as a **private, device-local mind map**: one directed
graph per profile on a cytoscape canvas, nodes carrying a title plus Trix rich-text
content, labeled directed edges, collapse-a-branch, whole-document undo/redo, JSON
export/import, and a **Topics** sub-tab that browses the graph's topic hubs. It was
one of the three sub-tabs of the Notes tab (Board / Sketch / Mind); the Notes tab was
removed and all three were parked.

These files are the feature exactly as it stood when it was parked. They are **not
compiled, bundled or referenced** — `limbo/` is outside the npm `workspaces` globs and
outside the `src-tauri` crate — and they are **not maintained**.

`mind.md` (moved here alongside the code) is the authoritative design document: scope,
the decision log, the collapse proof sketch, the test inventory and the full
changed-file list. This file summarizes only what a restorer needs and then tells them
exactly what to re-wire.

## What it was, in the parts worth preserving

**Zero Rust.** The feature is pure frontend over the sealed kv store; the only Rust it
ever touched was `fs_local.rs`, and only for "save the export to a path the user
picked". The build gate (`mind.enabled` + four caps) was the only backend surface.

**Device-local by construction, not by policy.** Persistence is ns `mind`, scope
`default`, key `""` (one document, the `contacts`/`sketch` empty-key convention). The
namespace is **deliberately absent from both allow-lists** — `DEVLINK_SYNC_KV` and
`PEER_SCOPE_KV` in `packages/rakotis/src/deviceSyncModel.ts` — so the map cannot leave
the device even by accident. There is no `mind_*` wire message type at all. The
exclusion is documented in the allow-list comment (still present in the live tree,
~line 302):

> Everything else is deliberately device-local: … `kanban` (its room seam already
> converges), `mind` (the mind map is this device's only — a design promise, not an
> oversight) …

and pinned negatively by tests that also survive in the live tree —
`isSyncableKv("mind", …) === false` (`packages/rakotis/tests/unit/deviceSyncModel.test.ts`)
and `isPeerWritableNs("mind") === false` (`packages/rakotis/tests/unit/peerSyncModel.test.ts`).
**Restoring the feature must not touch either allow-list.**

**Module singleton, not Pinia, not view state.** `getMind()` lazily builds the
orchestrator on first use and every view shares it; `resetMind()` is the test seam that
drops it. The router uses `createMemoryHistory` and unmounts views on navigation, so a
per-view ref would throw away the graph and its undo history on every tab switch. Pinia
is refused for the documented `stores/chat.ts` reason: `reactive()` deep-unwraps inner
refs and the canvas/inspector take the whole orchestrator as a prop and read `.value`.

**Persistence gates.** `ready` flips only after the kv read comes back, and `persist()`
returns early until then — a flush in that window (tab switch, export) would otherwise
write the initial empty document over a map the user has not seen. Storage failure and
content corruption are handled oppositely on purpose: an unreadable *store* sets
`loadFailed` and disables writing for the session (surfaced as a banner); readable but
corrupt *content* starts fresh. Writes are debounced 800 ms because every `kvPut` is an
fsync; `flushPersist()` forces one before unmount, before export and after import.

**Undo = whole-document snapshots**, bounded at 100, taken *before* each mutation, with
a forked redo stack. Two refinements: a drag is one entry (snapshot at grab, committed
in `endNodeDrag`, no-op drags cost nothing), and free-text field editing takes one entry
per editing *session* via the lazy `editSnapshot()` (the eraser-sweep pattern from
`useSketch`). The edit modal buffers drafts so title + kind + content land in a single
`commitNodeEdit` step, and `addNoteToTopic` creates node + edge atomically.

**Collapse is derived, never stored.** Only the `collapsed` flag lives on the node;
`computeHiddenNodes` (`mindGraphModel.ts`) derives visibility in two O(V+E) passes with
the rule *hidden iff unreachable except through a collapsed frontier* — not "any
collapsed ancestor", which would punch holes in other expanded subtrees around
cross-linked topic hubs. A collapsed root is seeded out of its own candidate set so a
cycle can never hide it. Boundary edges vanish for free (cytoscape does not render an
edge with a hidden endpoint). Collapse follows *outgoing* edges, and Topics-attached
notes point note → topic, so they deliberately do not fold under their topic.

**Canvas.** cytoscape **core only** — no layout or interaction plugins. Connect,
reconnect and collapse are hand-built from primitives: two-click connect with a ghost
node/edge rubber band (drag is taken by node repositioning), reconnect through
`ele.move()` because cytoscape edge endpoints are immutable data, and DOM overlay
widgets (✎ edit chip, ⊖/⊕ collapse chip, endpoint handles) because cytoscape cannot
paint interactive sub-elements. `MindGraph.vue` syncs the document into cy through a
**single diff watcher**, so no call site — view, inspector, edit modal, Topics tab,
keyboard, undo — ever patches cy by hand. Theming comes from `mindGraphStyle.ts`, which
resolves the `style.css` colour tokens (canvas pixels cannot see CSS variables) and
re-reads them on theme flip.

**Trix, offline and leak-proofed.** `MindRichText.vue` bridges `modelValue` to Trix's
hidden input. The app ships with **no webview CSP** (`tauri.conf.json csp: null`), so a
remote `<img>` in pasted or imported content would be fetched the moment Trix parses it
— an IP leak in an app that promises offline. Three guards: `trix-file-accept` is
cancelled and the attach button hidden in CSS, `trix-attachment-add` removes anything
that slips through, and rich pastes are intercepted in the **capture** phase and
scrubbed *before* Trix assigns `innerHTML`. `scrubContentHtml` runs again at every
validation boundary (kv load, import, `commitNodeEdit`). Content is only ever rendered
through Trix's own parser (editable or read-only) — **never `v-html`**.

**Topics sub-tab** (this replaced an earlier "dump inbox", which was removed outright,
not left dormant): the topic hubs as a list with link counts, a **read-only** details
modal (description through a read-only Trix, plus every node linked in either
direction), and "Add note" — which creates a note wired **note → topic** and hands it to
the shared edit modal. Only one modal at a time: `OyaModal` backdrops stack in **mount**
order, not open order, so the details modal closes before the editor opens (a stacked
backdrop swallowed the editor's clicks — found by e2e).

**Export/import is JSON** (`{ format: "enigma-mind", version: 1, exportedAt, metadata,
nodes, edges }`). The `format`/`version` discriminator is checked before any field is
read; the metadata counts are informational and never trusted — the confirm modal shows
the **validated** counts. Import **replaces** the whole map and is one Ctrl+Z away from
undone. Export uses the Tauri save dialog + `writeTextFileToDisk` with a blob-download
fallback in the browser build; import uses a hidden `<input type="file">` + `FileReader`
so it works identically in the webview and the browser dev build.

## As parked

| file | what it is |
|---|---|
| `mind.md` | the design doc — status, decision log, risks, full changed-file list |
| `views/EnigmaMindView.vue` | tab shell: Map/Topics pills, export/import + confirm modal, failure banner, keyboard shortcuts, hosts the shared edit modal, load/flush lifecycle |
| `components/mindModel.ts` | pure model: types, validation, caps truncation, `scrubContentHtml`, export shape, `plainTextToHtml`/`htmlToPlainText` |
| `components/useMind.ts` | singleton orchestrator: persistence gates, undo/redo, every mutation, UI seams (`editNodeId`, `reconnectRequest`, viewport cache), `getMind`/`resetMind` |
| `components/mindGraphModel.ts` | pure canvas logic: collapse sets + badge counts, element defs, editor-side edge validation, layout roots, materialization, ring placement |
| `components/mindGraphStyle.ts` | palette read from CSS tokens + the static cytoscape stylesheet |
| `components/MindGraph.vue` | cy lifecycle, doc→cy diff watcher, gesture state machine, DOM overlays, auto-layout/fit, Esc/F keys |
| `components/MindMapPanel.vue` | Map sub-tab composition (toolbar + graph + inspector); owns the tool ref |
| `components/MindToolbar.vue` | tool modes, undo/redo, auto-arrange, zoom-to-fit |
| `components/MindInspector.vue` | selection summary + Edit door, collapse/expand, delete; full edge editing (label/swap/reattach/delete) |
| `components/MindNodeEditModal.vue` | the node editor: buffered drafts, kind toggle, rich/plain content, Save (one undo step) / Discard |
| `components/MindTopicsPanel.vue` | Topics browser: list + read-only details modal + add-note handoff |
| `components/MindRichText.vue` | Trix wrapper: modelValue bridge, attachment refusal, capture-phase paste scrub, `readonly` display mode |
| `components/mindExport.ts` | JSON save (dialog/blob) + file read with stable error codes (`unreadable`, `not-json`) |
| `tests/mindModel.spec.ts` | unit — validation matrix, round-trip, caps, scrub, plain⇄rich (was `tests/unit/`) |
| `tests/mindGraphModel.spec.ts` | unit — the collapse contract, counts, elements, edge validation, roots, placement (was `tests/unit/`) |
| `tests/useMind.test.ts` | unit — persistence gates, debounce, undo bookkeeping, import replace (was `tests/unit/`) |
| `tests/mind.test.ts` | component — view/pills/banner, import flow, edit modal, Topics, inspector (was `tests/component/`) |
| `tests/mind.spec.ts` | Playwright — canvas-height probe, add topic → edit → Topics → add note → reload (was `tests/e2e/`) |
| `stubs/cytoscape.ts` | inert jsdom stand-in for cytoscape (was `tests/stubs/`) |
| `stubs/trix.ts` | inert jsdom stand-in for trix (was `tests/stubs/`) |
| `i18n/en.ts.snippet`, `i18n/pl.ts.snippet` | the whole `mind:` namespace plus the `nav.mind` key, lifted out of `apps/enigma/src/i18n/{en,pl}.ts` |

Related parked pieces this feature needs: `limbo/rust/fs_local.rs` +
`limbo/rust/fs_local_wrappers.ts.snippet` (export path), and — if Mind goes back as a
Notes sub-tab rather than its own tab — `limbo/frontend/notes-shell/`.

## Restore checklist

1. **Move the source back.**
   `components/*` → `apps/enigma/src/components/mind/` (all twelve files: five `.ts`
   and seven `.vue`), and `views/EnigmaMindView.vue` →
   `apps/enigma/src/views/EnigmaMindView.vue`. `mind.md` goes back to the repo root
   (`technology.md`, `build.md` and `pland.md` link to it there).

2. **Move the tests and stubs back**, to the directories their relative imports assume
   (`../../src/...`):
   - `tests/mindModel.spec.ts`, `tests/mindGraphModel.spec.ts`, `tests/useMind.test.ts`
     → `apps/enigma/tests/unit/`
   - `tests/mind.test.ts` → `apps/enigma/tests/component/`
   - `tests/mind.spec.ts` → `apps/enigma/tests/e2e/`
   - `stubs/cytoscape.ts`, `stubs/trix.ts` → `apps/enigma/tests/stubs/`

3. **Reinstall the npm dependencies** removed from `apps/enigma/package.json`:
   `"cytoscape": "^3.30.2"` and `"trix": "^2.1.19"` under `dependencies`,
   `"@types/cytoscape": "^3.21.9"` under `devDependencies`. Then `npm install` from the
   repo root (workspaces).

4. **`apps/enigma/vite.config.ts`** — restore the Vue compiler option that keeps Trix's
   self-registering custom elements from being treated as components. The plugin line
   is currently `plugins: [vue(), tailwindcss()]`; it must become
   `vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("trix-") } } })`.

5. **`apps/enigma/vitest.config.ts`** — four separate things, all removed:
   - the same `isCustomElement: (tag) => tag.startsWith("trix-")` on the `vue()` plugin
     (currently plain `vue()`);
   - the two stub path constants (`cytoscapeStub`, `trixStub`, built with
     `new URL("./tests/stubs/…", import.meta.url).pathname` like `aceStub`);
   - the three aliases, in this order after the maplibre ones:
     `{ find: /^cytoscape$/, replacement: cytoscapeStub }`,
     `{ find: /^trix\/dist\/trix\.css$/, replacement: cssStub }`,
     `{ find: /^trix$/, replacement: trixStub }`.
   (`cssStub` → `tests/stubs/empty-css.ts` still exists; it is shared with maplibre.)

6. **`apps/enigma/src/vite-env.d.ts`** — re-add `declare module "trix";` (trix ships no
   type declarations; it is imported for the side effect of registering
   `<trix-editor>`/`<trix-toolbar>`, and driven through DOM events and the element's
   `editor` property).

7. **`apps/enigma/src/style.css`** — nothing to do: the `.mind-trix-wrap` /
   `.mind-trix-readonly` rules (Trix vs the Tailwind v4 layers, dark mode, hidden attach
   button, read-only mode) were **left in the live tree**. Verify they are still there
   before assuming it, since they are dead CSS while the feature is parked and a later
   cleanup may have swept them.

8. **Build-config chain — all four coordinated files, atomically.** The section was
   deleted from `apps/enigma/src-tauri/build_config.yaml` and from
   `apps/enigma/src-tauri/configs/build_config.{light,plus,pro}.yaml`. Restore:

   ```yaml
   mind:
     enabled: true          # light: false, plus: false, pro: true
     max_nodes: 500
     max_edges: 1000
     max_title_len: 200     # also caps edge labels
     max_content_len: 20000 # Trix markup inflates; 4000 was not enough
   ```

   The caps are `deny_unknown_fields`-validated even when `enabled: false`, so the three
   edition files need the full block, not just the switch. Also put `mind` back in the
   `# OUT:` / `# = Plus, PLUS:` header comment lists of the edition files.
   Then, in order:
   - `apps/enigma/src-tauri/build.rs` — the `MindSection` struct (`enabled`, `max_nodes`,
     `max_edges`, `max_title_len`, `max_content_len`), its `mind: MindSection` field on
     the root config struct, the `> 0` validation loop over the four caps, the
     `pub mod mind {{ … }}` codegen block (`ENABLED`, `MAX_NODES`, `MAX_EDGES`,
     `MAX_TITLE_LEN`, `MAX_CONTENT_LEN`), and the five `format!` args
     (`mind_enabled`, `mind_max_nodes`, `mind_max_edges`, `mind_max_title`,
     `mind_max_content`).
   - `apps/enigma/src-tauri/src/lib.rs` — the five `mind_*` fields on
     `BuildConfigSummary`, their initializers in `app_get_build_config`, and `mind` in
     that function's `use build_config::{…}` list.
   - `packages/rakotis/src/services/appStorage.ts` — `mind_enabled`,
     `mind_max_nodes`, `mind_max_edges`, `mind_max_title_len`, `mind_max_content_len` on
     the `BuildConfig` interface **and** in `FALLBACK_BUILD_CONFIG` (`true`, 500, 1000,
     200, 20000). Without the fallback entries the browser/vitest builds read `undefined`
     caps and every create is refused.

9. **Restore the export path's Rust.** `mindExport.ts` calls `writeTextFileToDisk`,
   which is parked with `fs_local`:
   - `limbo/rust/fs_local.rs` → `apps/enigma/src-tauri/src/fs_local.rs`;
   - re-add `mod fs_local;` and the two `invoke_handler` entries
     (`fs_local::fs_write_text_file`, `fs_local::fs_write_base64_file`) in
     `src-tauri/src/lib.rs`;
   - paste `writeTextFileToDisk` from `limbo/rust/fs_local_wrappers.ts.snippet` back into
     `packages/rakotis/src/services/appStorage.ts` (it is re-exported by
     `packages/rakotis/src/index.ts` via `export * from "./services/appStorage"`).
     `writeBase64FileToDisk` in the same snippet belongs to Sketch — restore it only if
     Sketch comes back too.

10. **i18n.** Paste `i18n/en.ts.snippet` into `apps/enigma/src/i18n/en.ts` and
    `i18n/pl.ts.snippet` into `pl.ts`: the single `mind: "Mind"` / `mind: "Myśli"` line
    goes **inside the `nav:` block**, the `mind: { … }` namespace at the **top level**.
    Both files must gain exactly the same key tree —
    `apps/enigma/tests/unit/i18n.test.ts` compares them and fails on any drift.

11. **Routing and nav.** Two options; pick one before touching `router/index.ts`:
    - *Own tab* — add a `/mind` route pointing at `EnigmaMindView` with
      `beforeEnter: () => getBuildConfig().mind_enabled || "/chat"` (the guard must be
      `beforeEnter`, not a module-level `if`: the table is evaluated before
      `initBuildConfig` resolves), plus desktop and mobile `RouterLink`s in `App.vue`
      guarded by `getBuildConfig().mind_enabled`.
    - *Notes sub-tab, as parked* — restore `limbo/frontend/notes-shell/views/EnigmaNotesView.vue`
      to `apps/enigma/src/views/`, its `nav.notes` key from
      `limbo/frontend/notes-shell/{en,pl}.nav.snippet`, the `/notes` route with the
      `kanban_enabled || sketch_enabled || mind_enabled` guard, the
      `/board` `/sketch` `/mind` → `/notes?tab=…` redirects, and the Notes nav links.
      Note the shell hard-codes all three sub-tabs and their build flags, so bringing it
      back Mind-only means editing `ORDER` / `enabled` / `TAB_META` down to one entry.
    There is **no store wiring**: `stores/chat.ts` never held a mind reference, and the
    Mind tab has no attention dot (that dot was kanban's).

12. **Icons — `apps/enigma/src/main.ts`.** Only `faDiagramProject` (Mind's own tab icon,
    used by the Map pill and the parked Notes shell) was removed and must be re-imported
    *and* re-added to `library.add(...)`. `faNoteSticky` is the Notes shell's icon —
    re-add it only with option B above. Everything else the Mind UI renders
    (`circle-nodes`, `sitemap`, `arrow-pointer`, `square-plus`, `square-minus`,
    `circle-plus`, `link`, `expand`, `rotate`, `rotate-left`, `rotate-right`, `pen`,
    `check`, `xmark`, `trash`, `download`, `upload`, `triangle-exclamation`) is still
    registered for other features — verify before assuming.

13. **Do NOT touch the sync allow-lists.** `mind` must stay out of `DEVLINK_SYNC_KV` and
    `PEER_SCOPE_KV` in `packages/rakotis/src/deviceSyncModel.ts`. Its justification
    comment and the two negative-pinning assertions
    (`packages/rakotis/tests/unit/deviceSyncModel.test.ts`,
    `packages/rakotis/tests/unit/peerSyncModel.test.ts`) were deliberately left in the
    live tree; if a later cleanup removed them, put them back with the feature.

14. **Docs.** `technology.md` (§3 cytoscape + trix, §10 Mind tab bullet, §13 mind
    at-rest + scrub note, §15 config row), `build.md` (kill-switch bullet) and `pland.md`
    (feature matrix row + the per-edition Out lists) still describe Mind as shipping —
    they were **not** updated when it was parked. Read them before editing; a restore
    likely needs no doc change at all, only a re-check that the described behaviour still
    matches the code.

15. **Run the gates**, from `apps/enigma` unless noted:
    - `npm test` (vitest: unit + component — mind adds 32 + 17 + 23 + 17 tests),
    - `npm test` in `packages/rakotis` (the negative pinning assertions),
    - `npm run build` (`vue-tsc --noEmit && vite build` — this is what catches a missed
      `BuildConfig` field or a missing `declare module "trix"`),
    - `npm run test:e2e` (Playwright; the mind spec probes canvas height > 0, then
      topic → edit modal → Topics → add note → reload),
    - `cargo check` in `src-tauri` for all three editions
      (`ENIGMA_EDITION=light|plus|pro`) — `build.rs` validates every config file it is
      pointed at.

## Caveats

- **This does not typecheck against the live tree**, by construction. `useMind.ts` reads
  `cfg.mind_max_nodes` and friends off `BuildConfig`, `mindExport.ts` imports
  `writeTextFileToDisk` from `rakotis`, and `MindGraph.vue`/`MindRichText.vue` import
  `cytoscape`/`trix` — none of which exist in the live tree any more. Steps 3, 8 and 9
  are what make it compile again; expect nothing to build until all three are done.
- APIs it depends on may have moved. It uses `kvGet`/`kvPut`/`getBuildConfig` and the
  Oya components `OyaButton`, `OyaIconButton`, `OyaModal`, `OyaTextField`, `OyaTextArea`,
  `OyaEmptyState` from `rakotis`; `nanoid`; and `@tauri-apps/plugin-dialog`'s `save`.
  Check each against the current rakotis surface before assuming the imports resolve.
- The parked e2e spec navigates **Notes tab → Mind sub-tab** and asserts there is no
  "Mind" page heading. Restoring Mind as its own top-level tab (option A in step 11)
  means rewriting that navigation.
- `stubs/cytoscape.ts` is a shallow stand-in — an element map deep enough for
  `MindGraph`'s patch calls, plus `emit` so tests can fire cytoscape events by hand. It
  will need extending for any canvas behaviour added after the restore.
- The no-CSP situation the scrub defends against (`tauri.conf.json csp: null`) was still
  true at parking time. If a real CSP has landed since, the scrub and the three Trix
  guards are still correct — just no longer load-bearing.
- Trix content is safe **because** it is only ever parsed by Trix, editable or read-only.
  The regex scrub is defense in depth, not a sanitizer; never route node content through
  `v-html`.
- The kv fallback in the browser and vitest builds is plaintext `localStorage`
  (`enigma:db:mind:default:`) — the documented, accepted degradation shared by every
  feature, not a Mind-specific one.
