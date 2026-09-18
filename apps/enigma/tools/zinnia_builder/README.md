# Zinnia Builder

A window — and a set of subcommands — for building **lazurite**, the Zinnia
file editor. (Sketch and Primula used to be built here too; their editors now
live in Lazurite.)

```
scripts/zinnia/builder.sh                       the window
scripts/zinnia/builder.sh targets               what this machine can package
scripts/zinnia/builder.sh build lazurite        headless, one app
scripts/zinnia/builder.sh build --all --debug   every app, fast
scripts/zinnia/builder.sh dev lazurite          hot reload
```

## What it is, and is not

It **drives the app's own `build.sh`** rather than reimplementing the build.
That script is what a developer runs by hand and what CI runs; a builder that
called `npx tauri build` itself would be a second route to a bundle, and two
routes eventually disagree. Everything the GUI can do, a subcommand can do, and
both assemble their argv through `appbuilder.commands` so a flag cannot be
added to one and forgotten in the other.

It is **deliberately smaller than `tools/enigma_builder`**. That one carries
feature editions, a signing pipeline, an icon set editor and a price table,
because Enigma26 ships in editions and is signed. These three apps have none of
that, and inventing an edition system so the two tools looked alike would be
inventing work. What the two share is `tools/appbuilder`.

## Multiplatform, honestly

Tauri compiles for the machine it runs on. There is no cross-compile for
desktop targets, so:

* the window **greys out** the formats this host cannot produce, with the
  reason in the tooltip;
* the CLI **refuses** them before starting, rather than failing minutes into a
  cargo build;
* `targets` prints the whole table and what each one needs.

Even within Linux the caveat holds: an `.rpm` built on Ubuntu links this
system's glibc and webkit2gtk and will very likely not run on Fedora. The
window says so before it starts. For a package that genuinely works, build
inside a container or VM of that distribution.

## Layout

```
tools/appbuilder/      shared, imported by BOTH builders
  appspec.py           what an app is — read from the repo, never hardcoded
  commands.py          argv assembly, one place for the GUI and the CLI
  platforms.py         which package formats this host can really produce
  build_worker.py      runs a build off the GUI thread, cancellable
  runenv.py            a clean environment for launching the result
  bundles.py           enigma's Linux format table (unchanged)
  theme.py widgets.py  Qt bits

tools/zinnia_builder/
  main.py              the CLI, and the window's entry point
  window.py            the window
```

`appspec` reads the product name, identifier, version and dev port out of each
app's `tauri.conf.json`. Nothing here carries a second copy that can drift —
which matters most for Lazurite, whose identifier is still
`com.spectrumaipl.zinnia` and must stay that way or every installed copy
orphans its stored data.
