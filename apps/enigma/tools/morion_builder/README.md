# Morion Builder

A window — and a set of subcommands — for building **Morion**, the file
editor. It replaces the Zinnia Builder, which by the end built only Morion.

```
scripts/morion_builder.sh                         the window
scripts/morion_builder.sh --check                 what it resolved, then exit
scripts/morion_builder.sh targets                 what this machine can package
scripts/morion_builder.sh build                   a desktop bundle, as tauri.conf.json says
scripts/morion_builder.sh build --bundles=deb,rpm --debug
scripts/morion_builder.sh build --frontend        types and the Vite bundle, no Rust
scripts/morion_builder.sh dev                     hot reload
scripts/morion_builder.sh android                 a release APK for phones (aarch64)
scripts/morion_builder.sh android --type=debug --abi=x86_64   for the emulator
npm run builder:morion                            the window, from the repo root
```

The window needs PyQt6 (`python3 -m venv tools/morion_builder/venv &&
tools/morion_builder/venv/bin/pip install -r tools/morion_builder/requirements.txt`);
the subcommands need nothing but Python.

## The window

Morion's mark and identity at the top — package name, bundle identifier,
version and dev port, all read from `apps/morion/src-tauri/tauri.conf.json`.
Then:

* **Package** — the formats this machine can produce, as checkboxes; the ones
  it cannot are greyed out with the reason in the tooltip. **Debug build** and
  **Run tests first** beside them.
* **Build**, **Frontend only**, **Run dev**, **Cancel**, **Open output folder**.
* **Android** — an ABI and **Build APK** (release, or debug when the Debug box
  is ticked), through `scripts/build_android.sh`.
* The live log, and the bundles the last build left.

Cancel (and closing the window mid-build) stops the whole process group:
terminating bash alone would leave cargo or gradle building unattended. The
package choices and the ABI are remembered between runs.

## What it is, and is not

It **drives Morion's own `build.sh`** rather than reimplementing the build.
That script is what a developer runs by hand and what CI runs; a builder that
called `npx tauri build` itself would be a second route to a bundle, and two
routes eventually disagree. Everything the window can do, a subcommand can do,
and both assemble their argv through `appbuilder.commands` so a flag cannot be
added to one and forgotten in the other.

It is **deliberately smaller than `tools/enigma_builder`**. That one carries
feature editions, a signing pipeline, an icon set editor and a price table,
because Enigma26 ships in editions and is signed. Morion has none of that. What
the two share is `tools/appbuilder`.

## Multiplatform, honestly

Tauri compiles for the machine it runs on. There is no cross-compile for
desktop targets, so the window **greys out** the formats this host cannot
produce, the CLI **refuses** them before starting rather than failing minutes
into a cargo build, and `targets` prints the whole table.

Even within Linux the caveat holds: an `.rpm` built on Ubuntu links this
system's glibc and webkit2gtk and will very likely not run on Fedora. The
window says so before it starts. For a package that genuinely works, build
inside a container or VM of that distribution.

## Identity

Two names predate the rename and are kept: the package name (`productName`,
"Zinnia" — what the .deb/.rpm are called) and the bundle identifier
`com.spectrumaipl.zinnia`. The identifier especially must stay: it is what the
OS files the installed app's data under, and changing it orphans everything
every installed copy has saved. The builder shows both and edits neither.

## Layout

```
tools/appbuilder/        shared with tools/enigma_builder
  appspec.py             what an app is — read from the repo, never hardcoded
  commands.py            argv assembly, one place for the window and the CLI
  platforms.py           which package formats this host can really produce
  build_worker.py        runs a build off the GUI thread, cancellable
  runenv.py              a clean environment for launching the result
  theme.py widgets.py    Qt bits

tools/morion_builder/
  main.py                the CLI, and the window's entry point
  window.py              the window
  tests/                 python3 -m pytest tools/morion_builder/tests
```
