# Zinnia

An office suite for the toto platform — drawings, documents, and text — as a
Tauri 2 desktop app.

## Running it

```bash
./run_dev.sh         # desktop window, hot reload
./run_dev.sh --web   # browser only at http://localhost:1430, no Rust
./run_dev.sh --reset # wipe stored data (server, token, theme) first
npm test             # vitest
```

Or the underlying commands: `npm run dev`, `npx tauri dev`, `npm run build`.

To produce an installable desktop package:

```bash
./build.sh           # deb + rpm, release
./build.sh --debug   # much faster to build, slower to run
./build.sh --frontend  # frontend only, no Rust
```

`build.sh` gates each step on the last — dependencies, types, tests, frontend,
then Rust — so a type error surfaces in seconds rather than after the minutes
the Rust stage costs. It also checks for `webkit2gtk`/`libsoup` up front,
because without them the failure arrives deep inside a `-sys` crate naming a
`.pc` file rather than the package you need to install.

Ports are 1430 (dev) and 1431 (HMR), chosen so zinnia and enigma can run at the
same time — enigma owns 1420/1421. That number appears in four files
(`vite.config.ts`, `src-tauri/tauri.conf.json`, `scripts/tauri-dev-server.mjs`,
`src/config.ts`) and a test fails if they drift apart.

## What is here

| Editor | Files | Backed by |
|---|---|---|
| Drawing | `.svg` | a hand-rolled SVG engine, ported from enigma |
| Document | `.xml` (cyprian) | TipTap with cyprian's own schema |
| Presentation | `.pxml` (memo) | slide blocks over the same TipTap schema |
| Sheet | `.json` | a grid over the sheet format |
| Text | everything else | ACE, with modes and workers bundled offline |

`src/files/FilesPanel.vue` is the folder browser, down the left of every editor
rather than behind a tab of its own — picking a file used to mean leaving the
work. It reads one folder at a time, when you expand it, and it only ever hands
bytes over: nothing in it can save, rename or delete.

`src/views/EditorHost.vue` owns the FILE — opening, saving, the discard prompt,
and which editor a file gets. Each editor owns only its BUFFER and implements
the contract in `src/editors/types.ts` (`markSaved` / `getContent` / `isDirty`).
That split is what lets the host hold one loosely-typed ref for whichever
editor is mounted, and it is why a new editor must not invent its own save path.

## The document format

`src/formats/document.ts` is a **port** of cyprian's `document_format.py`, not a
reimplementation. The golden files in `tests/golden/document/` were produced by
that Python module; the tests assert this one parses them identically and
re-serialises byte-for-byte. When the two disagree, Python is right — it is the
server that stores and re-sanitises these bytes.

Two rules carry the format and must not be softened:

* the payload is CDATA-wrapped, including a literal `]]>` (split across two
  sections so it round-trips);
* nothing unknown is discarded — unknown root attributes and unknown child
  elements ride through untouched.

Zinnia deliberately does **not** sanitise. Cyprian sanitises on both save and
open, server-side, because a document can arrive from anywhere. A client that
applied its own allowlist would only be guessing, and would still get bytes back
it did not send.

## packages/rakotis

Shared UI primitives, vendored as a **git subtree** from
`git@gitlab.com:janhagit-group/rakotis.git` (which was itself extracted from
enigma, with history).

```bash
git subtree pull --prefix=packages/rakotis <rakotis-remote> main --squash
git subtree push --prefix=packages/rakotis <rakotis-remote> main
```

Import pieces, never the barrel:

```ts
import OyaButton from "rakotis/components/primitives/OyaButton.vue";
```

`rakotis/src/index.ts` re-exports the entire P2P/MLS/chat surface plus
`OyaQrCode`, which needs `qrcode` — a dependency that lives in enigma's app and
not in the package. Importing the barrel drags all of that into zinnia's module
graph and fails to resolve.

## limbo/

Parked code: written, tested, and not currently reachable from any build. Today
that is `limbo/cloud/` — sign-in, the vault browser and the HTTP client under
both, removed when zinnia settled on being local-first. `limbo/README.md`
explains the convention (borrowed from the platform monorepo) and each parked
area's `LIMBO.md` lists what left with it and what lifting it back takes.

Nothing in there is compiled: `tsconfig.json` includes only `src/**`, vitest
collects only `tests/**`, and cargo only builds what a `mod` in
`src-tauri/src/lib.rs` names.
