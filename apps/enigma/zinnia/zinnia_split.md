# Splitting Zinnia

## Status

**Steps 1-6 done.** The tree is clean; 461 frontend tests and 24 Rust tests
(padova 12, substrate 8, zinnia 3) plus padova's `compile_fail` doctest green,
clippy clean, `npm run build` succeeds. Nothing has moved into `apps/` yet —
steps 1-7 are in-place refactors.

Run the Rust side with **`npm run test:rust`** (`cargo test --workspace`), never
`cargo test` from inside `src-tauri/` — that compiles only the app and silently
skips padova's doctest, which is the one guarding the passphrase property.
`npm run test:all` runs both suites; `build.sh` now runs both too.

| # | Step | State |
|---|---|---|
| 0 | groundwork — plan, `exports` list, PDF parked unwired | **done** |
| 1 | extract shared preflight into scripts lib | **done** |
| 2 | workspace store takes an injected seal probe | **done** |
| 3 | cargo workspace with substrate crate | **done** |
| 4 | padova crate owns sealing and secrets | **done** |
| 5 | npm workspaces with petalite package | **done** |
| 6 | one file tree for panel and security tab | **done** |
| 7 | padova package owns the sealing surface | todo |
| 8 | lazurite becomes an app under apps ← **first irreversible** | todo |
| 9 | primula becomes an app under apps | todo |
| 10 | sketch becomes an app under apps | todo |
| 11 | csv export from the active worksheet | todo |
| 12 | register only detection where sealing is not offered | todo |

Deferred, after the split: deck PDF on printpdf, then the title-page template.
Both are Lazurite-only and neither blocks any step above.

Step detail is in [Migration order](#migration-order) — this table is the state,
that section is the content. **Keep this table current as work lands**: mark a
step done in the same commit that completes it, and when reality diverges from
the plan, correct the plan rather than leaving it aspirational. A stale plan is
worse than none, because it is trusted.

Commits so far: `2dd4751` plan · `40c11ab` exports list · `b8cb6da` pdf renderer
· `0fa82c7` pdf deferral · `e07f60d` native pdf plan · `4f03c99` title-page todo
· `0bfd0a9` weasyprint stays in zenobia.

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

**`packages/rakotis` must be `exclude`d, not merely left out of `members`.**
The plan first assumed a path dependency stays out on its own. It does not:
cargo automatically adopts any path dependency that sits *inside the workspace
root directory*, and `packages/rakotis/crates/gervasius` does. Found in step 3
when `cargo test --workspace` ran the subtree's own tests — gervasius had
become an implicit member. `exclude = ["packages/rakotis"]` is the documented
fix; excluded, it compiles as a plain dependency and the subtree is never
written to. Verified: two members after, subtree `git status` clean.

**The lockfile moved to the root** (`git mv src-tauri/Cargo.lock Cargo.lock`)
because a workspace resolves at its root. Moved rather than regenerated, so
every pinned version survived; substrate was the only addition.

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

*Built in step 4 as a `Locker` struct*, not free functions: the keyring
**service name is a field**, which is how "per-app keyring service names" is
honoured by construction — each app names its service in exactly one constant
(`src-tauri/src/lib.rs`: `LOCKER`). `recall()` is `pub(crate)` **and pinned by
a `compile_fail` doctest** on `Locker`, so `cargo test` fails the day anyone
makes it public. `src-tauri/src/{lock,secrets}.rs` became six one-line shims
with identical names, parameter names and `async` attributes; `lib.rs`'s
`generate_handler!` did not change. Neither `keyring` nor `gervasius` is named
in `src-tauri/Cargo.toml` any more.

Two things the move improved on the way past. Padova's tests use a service of
their own (`com.spectrumaipl.padova.test`), so `cargo test` no longer clears
whatever passphrase the user's real app has remembered — the old tests did. And
keyring-touching tests now hold a shared mutex, because the runner is parallel
and they share one entry and one in-memory slot.

One trap fired, correctly: `lockErrors.test.ts` scanned `src-tauri/src/lock.rs`
for error prefixes and found **zero** once it became a shim — its `> 0` floor
refused to pass. It now reads the whole crate chain and pins one prefix per file
(`wrong_password`, `no_passphrase`, `too_large`), so a file moving out from
under the scan is caught rather than satisfied by a stray hit elsewhere.

**The guard itself was weaker than its own comment**, found by adversarial
review and fixed before the commit. The doctest body was `locker.recall()` — a
*call*, which fails to compile for a private method but equally for a **public**
one whose signature changed, so `cargo test` stayed green while the passphrase
read-back was public API. Reproduced directly: on one sabotaged crate with
`pub fn recall(&self, _why: &str)`, the call form reports `ok` and the path form
`let _ = padova::Locker::recall;` reports FAILED. The path form is now the body,
because it compiles for *any* public signature and fails only on privacy.

The `E0624` in the annotation is documentation only — **rustdoc checks doctest
error codes on nightly, not stable** — so the body has to do the discriminating,
not the code.

And the guard was never actually run by anything: `cargo test` inside
`src-tauri/` skips other crates' doctests entirely. Hence `test:rust` /
`test:all` and the `build.sh` step. A guard nothing executes is decoration.

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

*Built in step 5* as `packages/petalite`, an npm workspace linked into
`node_modules/` by symlink. Four subpath exports mirrored in three places that
must stay in step — `package.json`'s `exports`, the Vite/Vitest aliases, and
`tsconfig.json`'s `paths`. **Alias order is load-bearing**: `petalite/*.vue`
resolves into `src/components/`, one directory deeper than `petalite/theme`, so
the `.vue` rule must come first or every shared component 404s.

The i18n split landed as **mechanism here, catalogue there**: `createAppI18n({
storageKey, messages })` owns locale choice, the fallback chain and the
`<html lang>` side effect, while `en.ts`/`pl.ts` and the key `"zinnia:locale"`
stay with the app. Each app keeps its own stored locale for the same reason it
keeps its own keyring entry. The `localStorage` reads are now wrapped — a
blocked store must not stop an app from starting.

**Petalite also owns the file tree.** The survey found `SecurityView.vue` is
largely a re-render of what `FilesPanel.vue` already draws — same rows,
chevrons, padlock, depth indent, filter box. That becomes one `FileTree`
component in Petalite, rendered by the files panel and by Padova's tab with
different row actions. It removes real duplication, and a third app gets a file
tree for nothing.

*Built in step 6.* The line drawn was **what a row IS** (depth, open/closed,
which of three icons) versus **what a row is FOR** (its density, its testid
prefix, whether it is disabled, what sits at its right edge). The first is the
component; the second is props and a `trailing` slot — a file size in the panel,
a SEALED badge in the Security tab. Net −23 lines in the app, and the chevron
block and the `'lock' : 'file'` ternary now each exist exactly once.

`FileTree` holds **no store**: rows and the two predicates (`isExpanded`,
`isSealed`) arrive as props. Petalite must not depend on one app's workspace,
and a tree that fetched its own rows could disagree with the one beside it. The
`TreeRow` interface is structural, so the store's `Row` satisfies it with no
import in either direction — `vue-tsc` confirms.

Verified by **mutation**, because a shared component that silently rendered
nothing would still pass a green suite: breaking the padlock fails 1 test,
dropping the `activate` emit fails 17, flattening the depth indent fails 1. The
SEALED badge stays green under the padlock mutation, which is correct — it comes
from the caller's slot, and it is asserted both ways.

Both `data-testid` schemes (`files-row-*`, `security-row-*`) are kept via
`testidPrefix`; dozens of assertions across two suites depend on them.

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

**Done in step 2**, though not in the shape first planned. `createWorkspace({
probe })` assumed a factory; the store is a module-level singleton, so the
injection landed as `setSealProbe(probe | null)` beside it — same seam, no
premature restructuring. `main.ts` installs it before `mount`. Absent, `probeAll`
returns early and `isSealed` is always false, which is exactly today's behaviour
off-desktop since `probeSealed` already answers `false` outside Tauri
(`lock.ts:116`).

The absent case is pinned by `tests/unit/sealProbe.test.ts` — no probe means no
invoke, no padlock and **no throw** — and that suite was mutation-checked:
bypassing the injection makes it fail. Two existing suites (`filesPanel`,
`securityView`) had to start installing a probe, which is the correct signal:
they mock at the Tauri boundary and were genuinely asserting the padlock.

Whether the store becomes a **factory** is deferred to step 5, where Petalite
takes ownership. It is a module-level singleton today (refs at `:49-78` are
module-scope), and step 2 did not change that: the probe seam did not require it,
and converting both at once would have made one commit two refactors. A thin
`useWorkspace()` over one instance keeps Lazurite's panel and Security tab
sharing one tree — which `SecurityView.vue:5-8` documents as deliberate.

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

   **This fired in step 5, exactly as predicted.** `ModalPanel.vue` and
   `SelectMenu.vue` moved to Petalite, the scanner walked only `src/`, and their
   two cases *silently stopped existing* — 458 → 456 with a green suite. Caught
   by diffing test NAMES before and after, not counts. The scanner now walks a
   `ROOTS` list and asserts **per root** that it still finds templates, so a
   root going empty fails instead of being covered by another root's total.
   **Diff the test names at every step from here on**; a shrinking suite is the
   failure mode this whole plan is most exposed to.
4. **The dev port lives in five places**, including the `devCsp` string
   (`ws://localhost:1431`). `smoke.test.ts` guards three; all its reads are
   CWD-relative, so each app needs its own vitest root.
5. **`tabs.test.ts:20-22` hard-codes the tab id list** — a literal enumeration
   of the union across apps.
6. **`style.css`'s `@source` is relative to `src/`** and breaks when the
   stylesheet moves. ~~Tailwind silently renders rakotis components unstyled~~ —
   **overstated, corrected in step 5 by experiment.** Tailwind v4's *automatic
   source detection* already scans the whole project tree, skipping only
   gitignored paths, and neither `packages/rakotis` nor `packages/petalite` is
   gitignored. Breaking the path deliberately and rebuilding still emitted
   `z-[60]` (the one class used by rakotis and nowhere in `src/`). So `@source`
   is insurance, not the mechanism. It still matters for a path Tailwind would
   NOT reach on its own — anything gitignored, or outside the project root — so
   keep the directives correct, but the silent-unstyled failure is not the
   hazard it was written up as.
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
14. **`cargo test` from inside an app directory skips every other crate's
    doctests.** Found in step 4: the doctest pinning "no command returns the
    passphrase" never ran under `cd src-tauri && cargo test`. Per-app scripts
    (step 8) must call `cargo test --workspace` from the root, or each app's
    gate will quietly stop testing the shared crates.
15. **The in-memory passphrase fallback is one slot per PROCESS**, shared by
    every `Locker` regardless of service name. Harmless while one process is one
    app — and separate app processes do not share it — but a future in-process
    multi-app host would leak a remembered passphrase between apps on a machine
    with no secret service. Documented in `padova/src/secrets.rs`.
16. **Side-effect imports (`import "./x"`, no bindings) are invisible to a
    binding-shaped search, and only the BUILD catches them.** `main.ts` had
    `import "./useSystemColors"` purely for its side effect; the step-5 rewrite
    missed it, and `vue-tsc` and all 460 tests still passed — `npm run build`
    was the only gate that failed. Grep `'^import "'` separately when moving
    modules, and never treat a green test run as proof the app still builds.
17. **substrate-only apps still link OpenSSL.** `is_sealed_file` calls
    `gervazy::is_sealed` for a 6-byte legacy prefix compare, and gervasius pulls
    `fernet` → `openssl-sys`. Sketch and Primula would carry native OpenSSL for
    one memcmp. Inlining that prefix check into substrate would drop gervasius
    from the detection path entirely — worth doing before step 10.

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

### Done-conditions

A step is done when its commit is green **and** its own check passes. The
generic gate (`npm test`, `vue-tsc`, `cargo check`) catches almost nothing here
— every one of these refactors can be green and still wrong.

| # | Its own check |
|---|---|
| 1 | Both current scripts still start; `lib.sh` sourced, not copied. |
| 2 | Sealed badges still appear. Then remove the probe: badges vanish, nothing throws. |
| 3 | `cargo build` does not OOM (trap 1), and `gen/schemas/` is still ignored (trap 2). |
| 4 | `recall()` is `pub(crate)`; grep confirms no command returns a passphrase. |
| 5 | rakotis components still **styled** — trap 6 fails silently, so look at them. |
| 6 | Panel and Security tab render the same tree with different row actions. |
| 7 | `lockErrors.test.ts` still binds `LOCK_ERRORS` to both catalogues. |
| 8 | App starts on its own port; `icons.test.ts` floor recalibrated, not deleted. |
| 9 | Sheets gone from Lazurite; `.json` still opens as code there (`openWith.ts:33`). |
| 10 | PNG export still renders **text** (trap: silent blank); `open-as-text` works. |
| 11 | Round-trip a comma, quote, newline, formula, merged range through CSV. |
| 12 | `generate_handler!` in Sketch and Primula has no `unlock_file`. |

**Two failure modes to watch**, both silent: a test that passes because it now
asserts nothing (traps 3, 11, 12), and a stylesheet that renders unstyled with no
error (trap 6). Neither shows up in a green run.

**Rollback point:** steps 1-7 are reversible in place and leave one app. The
directory move (8) is the first irreversible commit.

## PDF, deferred

### The current state (todo, not abandoned)

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

**This happens after the split**, not during it. The split's 12 commits leave a
clean tree; PDF then lands inside one app rather than against a moving target.

### Replacing WeasyPrint with a native renderer

**printpdf is not a drop-in for WeasyPrint, and the gap is not drawing — it is
paged media.** printpdf 0.12 does have an HTML path (`PdfDocument::from_html`,
azul's `solver3`), and it does wrap lines, break pages and lay out tables. But
its supported-CSS list is a **closed allowlist**, and cross-referencing it
against what the documents actually use, every paged-media feature is absent:

| Needed | printpdf | Used at |
|---|---|---|
| `target-counter` | **no** — no counters at all | `document.css:481,484`, `documentHtml.ts:62` |
| `counter()` / `counter-reset` | **no** | `document.css:382-388` section numbering |
| `@page` size/margin, `@page :first` | **no** | `document.css:428-447`, `documentHtml.ts:54-57` |
| margin boxes (`@top-center`) | **no** — only `<header>`/`<footer>` | `document.css:431-447` |
| `string-set` / `string()` | **no** | `document.css:476` running title |
| `break-before/after/inside` | **no** | `document.css:465-473` |
| `orphans` / `widows` | **no** | `document.css:473` |
| `leader(".")` | **no** | `document.css:484` |
| `@font-face`, `data:` URIs | **no** | every image; KaTeX's 20 faces |

`target-counter` is the hard one and it is inherently a **fixed-point problem**:
lay out to learn which page each heading lands on, fill in the TOC, which
reflows the TOC, which can shift every later page. WeasyPrint does multi-pass
layout. Replicating it means writing that fixpoint yourself.

**Decision: printpdf with a reduced contract**, ~2-3 weeks.

**Why the reduction is acceptable: WeasyPrint stays in Zenobia.** It lives in
`toto.aralia` (`portal/zenobia/zenobia/toto/aralia/` — dispatch, views, metrics,
tests, its own `requirements.pdf.txt`), which is the same aralia this repo's
`render.py` borrowed `refuse_fetch` from. So full-fidelity rendering is not
being *lost*, it is being *kept where Python already lives*: free in a Django
portal, costly in a desktop bundle. Zinnia takes the reduced native path and
Zenobia keeps the complete one — a split of responsibility, not a compromise.
Nothing in Zenobia is to be parked or changed on account of this.

What is knowingly given up in zinnia, and must be stated in the UI rather than
discovered:

* No TOC page numbers, no running headers, no section counters.
* Approximate page breaks — **this breaks the pagination contract**
  (`document.css:415-426`), so the editor's on-screen page markers stop matching
  the PDF. That contract is load-bearing; if it cannot hold, the markers should
  say so rather than lie.
* Formulas degrade to `.cy-formula-source` text. KaTeX's output is dozens of
  absolutely-positioned spans — replaying it needs an inline formatting context,
  i.e. most of a CSS engine. The `katex.ts` inlining strategy does not carry
  over at all, since printpdf has neither `@font-face` nor `data:` URIs.
* AVIF and ICO images need decoders the `image` crate does not bring.

**Fonts must be bundled, not discovered.** printpdf takes font *bytes*
(`ParsedFont::from_bytes`), and `document.css:99-106` names DejaVu families
precisely so a missing family cannot substitute silently. Ship the faces; do not
depend on fontconfig. KaTeX's woff2 would need decompressing to TTF first.

**One thing gets better.** `render.py:36-46`'s `refuse_fetch` — the policy that
took a proven exploit to get right, after `base_url=None` turned out to govern
only *relative* URLs — becomes free. A Rust renderer has no fetcher to disable.

**The documented upgrade path is Typst** (`typst-as-lib`, Apache-2.0, fonts
baked in, no runtime deps), ~3-4 weeks, where TOC page numbers, widow control,
spanning tables and real math typesetting all come free — math from the
`data-latex` source rather than replayed KaTeX HTML. Its cost was that
`document.css` would stop driving the PDF, and **that objection has been
accepted**: divergence is allowed where quality wins.

But with WeasyPrint kept in Zenobia, Typst is now the *third* option rather than
the second — anyone needing a full-fidelity PDF has one, through the portal. So
Typst is worth revisiting only if zinnia must produce publication-quality PDFs
**offline and standalone**. Until that need is real, the reduced native path
plus Zenobia is the complete answer.

### PDF build order: decks first

Decks need **none** of the hard features — fixed 1280×720 box, one page per
slide, no TOC, no counters, no reflow. `slide.css:5` was written for it
(*"──► the PDF export   one @page per slide"*) and `:621-632` already carries
the rules. That is ~1 week on printpdf, and it proves the Rust backend behind
the existing three commands with zero Python before the document case commits to
an engine. `src/pdf/deckHtml.ts` does not exist yet; `usePdf.ts:5` anticipates it.

### TODO: a title-page template (limited-scope PDF)

**Not to be built yet.** Recorded here so the shape is not relitigated later.

A form — **company logo, title, author, date**, user-editable — rendered to
simple HTML and then to PDF. This is the *right* limited scope, because it needs
**none of the hard features**: one page, so no break control, no orphans/widows;
no contents, so no `target-counter`; no section numbering, so no counters; fixed
fields, so no reflow. It is the deck case's shape — a fixed box you fill — which
is precisely where printpdf is actually strong.

**Most of it already exists.** `document.css:394-398` is a complete cover
stylesheet that nothing currently emits:

```css
.cy-cover { text-align: center; padding-top: 22%; }
.cy-cover .cy-title { font-size: 2.6em; line-height: 1.15; margin: 0 0 0.3em; }
.cy-cover .cy-subtitle { font-size: 1.25em; color: var(--cy-muted); margin: 0 0 2.2em; }
.cy-cover .cy-byline { font-size: 1em; color: var(--cy-muted); }
.cy-cover .cy-byline span { display: block; margin: 0.15em 0; }
```

`.cy-subtitle` and `.cy-byline` are **styled but never rendered** —
`documentHtml.ts:81` emits only `<h1 class="cy-title">`. The stylesheet is ahead
of the generator, and `.cy-byline span { display: block }` is already exactly the
stacked author/date layout. So this is filling in a gap, not designing one.

**No format change is needed.** `CyDocument.meta` is a
`Record<string, string>` that is already parsed, preserved and round-tripped
(`formats/document.ts`). Author, date and logo live there as `meta` keys — no
schema bump, no migration, no new codec path. Unknown keys already survive a
round trip, so an older build opening a newer file loses nothing.

**The logo is the one real decision.** It must be a base64 `data:` URI like
every other image (`files/images.ts:14-23` — png, jpeg, gif, webp, bmp, ico,
avif), because the renderer fetches nothing. Two consequences to settle when
this is built: **avif and ico need decoders** the `image` crate does not bring,
so the picker should restrict to png/jpeg for the logo; and a large logo inlines
into every saved document, so it wants a size cap.

**The "simple HTML" output is also the handoff to Zenobia.** Because the
template renders to plain self-contained HTML, the same string that zinnia's
native renderer draws can be handed to `toto.aralia` for a full-fidelity PDF
when one is wanted. That makes HTML the interchange format between the two, and
is a further reason to keep the generated markup plain and self-contained
(inline styles, `data:` images, no external references) rather than tuned to
whichever renderer is nearer.

Open questions deliberately left for build time: whether the template is a new
editor kind or a mode of the writer; whether the fields are a modal or a
side-form; whether "simple HTML" means it is also exportable as `.html` (it
should be — the same string is what the PDF renders, and what Zenobia would).

## Verification

* `npm test` per app and at the root (`npm run test --workspaces`).
* `npx vue-tsc --noEmit` per app; `cargo check --workspace`; `cargo test`.
* All three `run_dev.sh` start simultaneously, on three port pairs.
* PDF (when it lands): a deck export opens with **one page per slide** at
  1280×720. Run `cargo test` **without** `ZINNIA_PDF_PYTHON` and confirm the
  render test is reported as skipped, not passed — it self-skips
  (`pdf.rs:354`), which is a silent pass if nobody looks.
* Seal a file in one app; confirm the others **badge and refuse** it, and that
  their `generate_handler!` has no `unlock_file`.
* Sketch: open a drawing, export PNG, and confirm the raster still carries text
  (the WebKit font trap above fails *silently* — a blank spot, not an error).
  Open a refused `.svg` — one with a script or a DOCTYPE — and confirm the
  `open-as-text` fallback still lands in the text editor from Petalite.
* CSV: export a sheet containing a formula, a merged range, a comma, a quote
  and a newline; open the result in another spreadsheet.
* `./build.sh` per app produces a bundle with the right identifier.
