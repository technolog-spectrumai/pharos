# Splitting Zinnia

## Context

Zinnia is one Tauri 2 + Vue 3 desktop app holding a writer, a spreadsheet, a
drawing board, a code editor, a file browser and file sealing. It becomes a
**monorepo of three apps and three shared packages**:

| Project | Kind | Is |
|---|---|---|
| **Lazurite** | app | the writer — documents, decks, code editor, files panel |
| **Primula** | app | sheets (Univer), plus a **CSV export** |
| **Sketch** | app | the drawing board — SVG editing, PNG export |
| **Padova** | library (Rust + Vue) | sealing: the file format, the commands, the passphrase prompt, the Security tab |
| **Substrate** | Rust crate | shared Rust below the apps |
| **Petalite** | Vue package | shared front end — theme, i18n, icons, components, the workspace store |

Padova is a **library, not an app** — decided after the survey showed the
sealing surface is tiny and cleanly separable, so a separate bundle would have
bought build plumbing and a duplicate file tree rather than capability. The
drawing board goes the other way: the survey found it is the *most* separable
thing in the repo, so it becomes an app.

### The one thing the split must not give away

`secrets.rs` is built so **no command ever returns the passphrase**:
`lock_file`/`unlock_file` take an *optional* password and ask the keyring
*inside Rust* (`lock.rs:130-136`). Lazurite renders untrusted content — opened
`.svg` files and deck HTML — in a webview whose CSP must allow
`style-src 'unsafe-inline'`. If every app registered the sealing commands, a
hostile document that got script into Lazurite could call `unlock_file` with no
password and have Rust supply the remembered passphrase silently.

So: **the code is shared, the registration is not.** `generate_handler!` is
per-app regardless of where the functions live, which is what makes this free.

Splitting Sketch out *strengthens* this. The app that opens hostile `.svg`
files becomes the app that holds nothing else — no document buffers, no
workspace, and (see step 12) no sealing commands it does not need.

### Why Sketch can leave at all

A drawing **cannot be embedded in a document**, so no code is duplicated by the
split. This needed checking, because the Stage 1 baseline lists "ink" as a
tested document feature — but in this codebase `ink` means *text colour*:
`INKS = ["accent", "success", "warn"]` (`cyprianSchema.ts:24`), a TipTap **Mark**
(`:69`) that exists because the server strips `style=`, so colour must travel as
a class. The document's TipTap extension list (`:160-183`) has no drawing node
of any kind. The only picture path is the generic `Image` node as a base64
`data:` URI — and `files/images.ts:14-23` deliberately excludes `svg` from the
allowed image types, so a drawing cannot even reach a document that way.

The proof is a grep: no file outside `src/sketch/` and `SketchEditor.vue`
imports any sketch module. Every other mention of "sketch" is a routing string,
the component import in `EditorHost.vue:22`, or a **comment citing the sketch as
precedent** (`DocumentEditor.vue:9`, `SheetEditor.vue:45`, `systemColors.ts:29`).
Comments cost nothing to move.

## Decisions taken with the user

* **Padova is a library with per-app registration.** Every app gets the sealing
  UI as a tab, but each app decides what it puts on its IPC surface.
* **Sealing UI in every app** — Lazurite, Primula and Sketch each carry a
  Security tab.
* **Sketch is its own app.** It has no importers, no Rust commands and no shared
  drawing code with the writer.
* **Per-app keyring service names.** No app's remembered passphrase silently
  unlocks another's session. Sealed files still open everywhere: each file
  carries its own salt.
* **Petalite re-exports rakotis.** Apps import from Petalite only; the
  `packages/rakotis` subtree is never edited.
* **CSV export**: active worksheet, **computed values**, merged cells write into
  the top-left with blanks elsewhere. No HTML export.
* **Per-app scripts**: `apps/<name>/run_dev.sh`, shared preflight extracted.

## Layout

Modelled on `/home/janek/Desktop/dev/enigma/enigma`, which is already
`apps/*` + `packages/*` npm workspaces with sibling Rust crates by relative
path — a working precedent rather than an invention.

```
apps/lazurite/{src,src-tauri,tests,vite.config.ts,vitest.config.ts,run_dev.sh,build.sh}
apps/primula/{ …same shape… }
apps/sketch/{   …same shape… }
packages/petalite/src/        shared Vue; re-exports the 4 rakotis primitives
packages/padova/src/          sealing front end (LockModal, SecurityView, lock.ts)
packages/rakotis/             UNTOUCHED subtree
crates/substrate/             shared Rust: frame constants, is_sealed, atomic_write
crates/padova/                sealing Rust: seal/open + secrets (keyring)
scripts/lib.sh                shared preflight, sourced by each app's scripts
Cargo.toml                    [workspace] — members = apps/*/src-tauri, crates/*
```

**`packages/**` stays out of `members`.** The rakotis subtree ships its own
tracked `Cargo.lock`; as a path dependency *outside* the workspace, cargo
ignores it and nothing in the subtree is touched.

## What moves where

**Substrate** — frame constants (`MAGIC`/`VERSION`/`PREFIX_LEN`), `is_current`,
`is_sealed`, `atomic_write`, `read_capped`. Depends on `gervasius` by relative
path. No `tauri` dependency: it exports **plain functions**, and each app
expands its own `#[tauri::command]` shims, so command *names* stay identical and
`src/security/lock.ts`'s invoke strings never change.

**crates/padova** — `seal`/`open` + all of `secrets.rs`, keeping `recall()`
`pub(crate)` so "no command returns the passphrase" stays a property of the
crate rather than a convention. Owns the `keyring` dependency, so Lazurite and
Primula do not link vendored libsecret.

**packages/padova** — `LockModal.vue`, `SecurityView.vue`, and the write half of
`lock.ts` (`sealFile`, `unsealFile`, `rememberPassphrase`, `forgetPassphrase`,
`passphraseStatus`, `lockErrorKey`, `LOCK_ERRORS`) plus the `lock.*` and
`security.*` i18n sections — `lockErrors.test.ts` binds `LOCK_ERRORS` to both
catalogues, so they travel together or that test goes vacuous.

**Petalite** — `theme.ts`, `systemColors.ts` + `useSystemColors.ts`,
`ModalPanel.vue`, `SelectMenu.vue`, `files/format.ts`, `files/images.ts`, the
i18n *mechanism*, the shared catalogue sections (`files.`, `common.`,
`settings.colors.`), and the workspace store. Re-exports `OyaModal`,
`OyaButton`, `OyaTextField`, `OyaIconButton`.

**Petalite also owns the file tree.** The survey found `SecurityView.vue` is
largely a re-render of what `FilesPanel.vue` already draws — same rows,
chevrons, padlock, depth indent, filter box. That becomes one `FileTree`
component in Petalite, rendered by the files panel and by Padova's tab with
different row actions. It removes real duplication, and a third app gets a file
tree for nothing.

**Padova ships no primitives of its own.** It ships *views* — `LockModal`,
`SecurityView` — built from Petalite's primitives, which it imports the same
way the apps do. Both views are already app-agnostic: `LockModal`'s header
states it "knows nothing about how a file is encrypted — the caller passes an
`action`", and `SecurityView` has no Lazurite-specific content. A third styled
component set would mean three places to look for a button; the whole codebase
uses **4 distinct rakotis components across 17 imports**, which is nowhere near
enough surface to justify one.

**Sketch** — moves whole, unedited: `src/sketch/` (10 files, 3,132 lines) and
`src/editors/SketchEditor.vue` (304 lines), plus the `sketch.*` i18n block
(`en.ts:248-344` and its mirror in `pl.ts`), `nav.sketch`, and 147 tests across
five dedicated files. It claims exactly one extension, `.svg`, and that claim is
**uncontested by design**: `openWith.ts:86` reads *"no sniffer; the extension is
the claim"*, and the sheet/deck/document sniffers that run first will never
match an SVG. It uses no `invoke` — nothing in the frontend does — reaching
Tauri only through the official `plugin-fs` and `plugin-dialog`.

Two things travelling with it that are easy to lose:

* **PNG export rasterises from the model, not from the SVG.** `sketchExport.ts`
  draws through Canvas2D using the same `pathD`/`shapePivot` the renderer uses,
  because loading the SVG into an `<img>` fails three ways in WebKit — a
  dimensionless SVG rasterises 0×0, fonts resolve against a separate context so
  text silently vanishes, and taint rules make `toDataURL` throw
  (`sketchExport.ts:168-175`). That comment is hard-won platform knowledge; it
  moves verbatim.
* **The sketch writes literal hex into saved `.svg` files**, alone among the
  palette's consumers (`systemColors.ts:107`). So Petalite's palette is a
  dependency Sketch reads at draw time, not a theme it can follow live. Note the
  historical direction: the app-wide palette was *derived from* the sketch's
  drawing colours (`systemColors.ts:29`), not the reverse.

Its `open-as-text` escape hatch (`SketchEditor.vue:256` → `EditorHost.vue:99`)
needs `TextEditor.vue`, which Lazurite also wants. It goes to **Petalite**.

**Stays per-app** — `config.ts` (identity: name, bundleId, vitePort), `tabs.ts`,
`openWith.ts`, `main.ts`, `style.css`, `icons.ts` registration.

### The workspace store: the seam

The store's only coupling to sealing is **two call sites** —
`useWorkspace.ts:242` and `:344`, both `probeSealed`. Everything else in its 369
lines is generic browsing.

Petalite ships `createWorkspace({ probe })` where `probe?: (path) =>
Promise<boolean>`. Absent, `probeAll` is a no-op and `isSealed` is always false
— which is exactly today's behaviour off-desktop, since `probeSealed` already
returns `false` when not in Tauri (`lock.ts:116`). Each app injects Padova's
probe at boot, **before the first `read()`** (`useWorkspace.ts:228-232`).

The store must become a **factory**, not stay the module-level singleton it is
today (refs at `:49-78` are module-scope). A thin `useWorkspace()` over one
instance keeps Lazurite's panel and Security tab sharing one tree — which
`SecurityView.vue:5-8` documents as deliberate.

## Primula's CSV export

Reuse the existing three-layer export mechanism rather than inventing one:
an editor declares `exports: [{labelKey, icon, run}]`
(`SketchEditor.vue:238-241`), the host reads it off the editor
(`EditorHost.vue:260-264`), the app menu renders it (`App.vue:147`). CSV becomes
the **second** use of a mechanism already built for a list.

Do **not** reuse `EditorHost.saveAs` — it renames the open file and derives its
filter from `KIND_FILES[kind].extensions` (`["json"]` for sheets).

**Two facts that shape the implementation:**

* **`cellsToTsv` is not reusable as-is** (`sheet.ts:149-154`): hardcoded `\t`,
  **no quoting whatsoever**, and a trailing `.trim()`. A value containing a
  comma, a quote or a newline would corrupt the file. CSV needs its own writer
  with RFC-4180 quoting; the TSV one keeps its one existing test.
* **Formulas are an untested gap.** No fixture, no code path, reads an `f` key
  — verified by grep across `src/`, the goldens and the tests. The snapshot's
  `v` *is* the computed value, but it is whatever the engine last wrote, and
  Univer recalculates asynchronously after load. The guaranteed-computed read is
  the facade: `getActiveSheet().getDataRange().getValues()`. The test stub
  implements only `createWorkbook` + `save()`, so it needs extending either way.
  **Add a formula fixture as part of this work** — the CSV claim is otherwise
  unverifiable.

`cellData` is a sparse string-keyed map with absent all-empty rows
(`from_rows.json` has no row `"3"`), so the used range must come from
`Object.keys()` and `Number()`, never from `.length`.

## Traps found (each would have bitten silently)

1. **`[profile.dev] split-debuginfo` is ignored in a workspace member.**
   `Cargo.toml:55-58` exists because the GNU linker OOM-kills the build. It must
   move to the workspace root or the OOM returns for every app.
2. **`.gitignore:9` is path-anchored** — `src-tauri/gen/schemas/` stops matching
   once crates move; it must become `**/gen/schemas/`.
3. **`icons.test.ts:49-53` has an anti-vacuity floor of `> 20`** calibrated
   against the *union* tree. Split, a small app may not clear it — and
   `it.each` over an empty file list is itself a silent pass. Each app needs its
   own floor. Its four indirect assertions (`TONE_ICONS`, `APP_TABS`,
   `SKETCH_TOOLS`, heading digits) each follow the app that owns the symbol.
4. **The dev port lives in five places**, including the `devCsp` string
   (`ws://localhost:1431`). `smoke.test.ts` guards three; all its reads are
   CWD-relative, so each app needs its own vitest root.
5. **`tabs.test.ts:20-22` hard-codes the tab id list** — a literal enumeration
   of the union across apps.
6. **`style.css:7`'s `@source "../packages/rakotis/src"`** is relative to `src/`
   and breaks when the stylesheet moves. Tailwind silently renders rakotis
   components unstyled — no error.
7. **Five Tauri crates share one cargo build dir** and serialise behind an
   exclusive lock. Enigma solved this with per-profile target dirs
   (`scripts/dev_target.sh`) and documents the disk cost; borrow it.
8. **`base64` is a dead direct dependency** (`Cargo.toml:45`) — no `use`
   anywhere; it arrives transitively through gervasius. Drop it while moving.
9. **`pdf.rs` is bound to its script** by `include_str!("../pdf/render.py")`;
   `src-tauri/pdf/` moves with the module. Lazurite-only.
10. **`run_dev.sh --reset` never touches the keyring** — the entry survives it.
    Worth saying in the help text.
11. **Sketch is the export mechanism's only producer.** `appMenu.test.ts` tests
    it, and `:137` says *"Export is per-editor: the sketch has PNG, the writer
    has nothing"* — still true while PDF stays unwired. When sketch leaves,
    Lazurite has **no exports at all** until CSV or PDF lands, so those tests
    must be re-anchored or they assert an empty menu and pass vacuously.
12. **Sketch is the smoke test's default editor** (`smoke.test.ts:8,55` — *"mounts
    the shell with the sketch editor inside"*) and the representative editor in
    `editorHost.test.ts:22,54,58,93`. Both are host-contract tests, not sketch
    tests; each app needs its own representative editor or the host contract goes
    untested in two of three apps.
13. **`sketchModel.test.ts` is classified as binary by `file(1)`** — non-ASCII
    degree signs at lines 103/126/780 mean plain `grep` silently returns nothing
    on its 853 lines. Use `grep -a`. This will bite anyone scripting the
    migration.

## Migration order

Each commit leaves `npm test`, `npx vue-tsc --noEmit` and `cargo check` green.
Commit messages: max 8 words, single line, no AI mentions.

1. `extract shared preflight into scripts lib` — no move yet, just
   `scripts/lib.sh` sourced by the current scripts.
2. `workspace store takes an injected seal probe` — `createWorkspace({probe})`,
   singleton preserved. The two call sites vanish; `security/*` import gone.
3. `cargo workspace with substrate crate` — root `[workspace]`, `[profile.dev]`
   moved up, `.gitignore` globbed, `base64` dropped.
4. `padova crate owns sealing and secrets` — Rust split; the app registers all
   six commands still, so behaviour is unchanged.
5. `npm workspaces with petalite package` — the shared Vue moves; `zinnia` stays
   one app but now imports from Petalite.
6. `one file tree for panel and security tab` — the duplicated rendering becomes
   Petalite's `FileTree`, taking row actions as a slot. Done before the Padova
   move so the tab that leaves is already the shared component.
7. `padova package owns the sealing surface` — `LockModal`, `SecurityView`,
   `lock.ts` write half, `lock.*`/`security.*` catalogues.
8. `lazurite becomes an app under apps` — the move, with per-app config, port
   pair, vitest root and generalised smoke/icons tests.
9. `primula becomes an app under apps` — sheets out of Lazurite; delete
   `openWith.ts:83`, `tabs.ts:26/43/66`, `EditorHost` sheet block.
10. `sketch becomes an app under apps` — `src/sketch/` and `SketchEditor.vue`
    move unedited; the `sketch.*` catalogue and 147 tests follow; the `"sketch"`
    entries leave `tabs.ts:26/42/65` and `openWith.ts:31/86`. Re-anchor
    `appMenu`, `smoke` and `editorHost` tests on each app's own editor.
11. `csv export from the active worksheet` — the writer, a formula fixture, the
    stub extension.
12. `register only detection where sealing is not offered` — the capability
    reduction, once all three apps exist.

**Order note:** the PDF work that was mid-flight is now committed and no longer
blocks anything. The `exports` refactor it carried landed separately (`40c11ab`,
`export menu takes a list of commands`) because it is not PDF-specific — it is
the mechanism Primula's CSV export builds on, and it removes the stale
`appMenu.test.ts:137` comment.

### Deferred: PDF export (todo, not abandoned)

The renderer is committed at `b8cb6da` and **works** — `pdf.rs`'s three tests
pass, including a real render against WeasyPrint 69.0 via
`ZINNIA_PDF_PYTHON=/tmp/wpv/bin/python`. Note that test **skips itself** without
that variable, so a plain `cargo test` proves the plumbing, not the render.

It is deliberately **not wired**: `src/pdf/` has zero importers and
`DocumentEditor.vue:263` exposes no `exports`. The reason is that WeasyPrint is
**Python**, so the feature only exists where an interpreter with it does —
`app_data_dir/pdf-venv/bin/python` (the documented setup) or `python3` on PATH.
Missing WeasyPrint is already handled as a *state*, not a failure (`pdf.rs:26`):
`pdf_status` reports it and editing continues.

Wiring waits for the pure-Rust **printpdf** backend behind the same three
commands, so the first PDF path zinnia actually ships carries no Python
dependency. Lazurite owns all of it; nothing here affects Primula or Sketch.

**Rollback point:** steps 1-7 are reversible in place and leave one app. The
directory move (8) is the first irreversible commit.

## Verification

* `npm test` per app and at the root (`npm run test --workspaces`).
* `npx vue-tsc --noEmit` per app; `cargo check --workspace`; `cargo test`.
* All three `run_dev.sh` start simultaneously, on three port pairs.
* Seal a file in one app; confirm the others **badge and refuse** it, and that
  their `generate_handler!` has no `unlock_file`.
* Sketch: open a drawing, export PNG, and confirm the raster still carries text
  (the WebKit font trap above fails *silently* — a blank spot, not an error).
  Open a refused `.svg` — one with a script or a DOCTYPE — and confirm the
  `open-as-text` fallback still lands in the text editor from Petalite.
* CSV: export a sheet containing a formula, a merged range, a comma, a quote
  and a newline; open the result in another spreadsheet.
* `./build.sh` per app produces a bundle with the right identifier.
