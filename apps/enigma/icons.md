# App icons — the shipped mark and how to change it (icons.md)

The Builder does **not** offer an icon choice. The app icon is part of the
product's identity, like its name, its bundle id and its version: one mark,
fixed in the repository, announced on the Identity tab so a build engineer can
see what they are shipping — and changed here, in code, not per build.

The mark is `sun-key2`, at
`tools/enigma_builder/assets/icons/sun-key2/`.

## Why fixed rather than chosen

An app icon is what a user identifies on their launcher. A build that could
pick a different one is a build that can ship the wrong brand, and nothing
downstream would catch it — the artifact installs and runs perfectly with the
wrong face. Fixing it removes a decision that has exactly one right answer at
any moment, and the answer belongs in version control beside the name and the
version it goes out with.

## The set

```
tools/enigma_builder/assets/icons/sun-key2/
├── icon.png     # normalised master: square, 1024×1024, what tauri icon consumes
├── source.png   # the original as authored — never overwritten
└── set.json     # { "name", "description", "author", "version": 1 }
```

`icon.png` is what `npx tauri icon` consumes; the original is kept beside it so
a better master can be re-derived later without starting from an upscale. If
the original is neither square nor 1024, it is **padded** to square on
transparency (centred, never stretched) and scaled — the artwork is not
distorted.

### Master image requirements

- **Square**, or it is refused — Tauri would distort it into every output size.
- **At least 512×512**; **1024×1024 recommended**, below which the largest
  generated sizes are upscaled from a smaller original.
- **PNG with alpha**, or **SVG**. An SVG is accepted because Tauri accepts it,
  but it is *not* measured, so the square and size rules move to you.
- **Keep the mark inside the middle ~66%.** Android's adaptive icon crops to a
  circle, squircle or rounded square depending on the launcher; anything in the
  corners is gone. Design for the circle, then check the square still looks
  deliberate.
- **Test it small.** Most of an icon's life is 32–48px in a taskbar, where fine
  detail and thin strokes disappear.

The same validation the Builder shows is the one a build runs
(`icons.validate_source`), so a mark that would fail the build is reported on
the Identity tab rather than at build time.

## Changing the app icon

Deliberately a manual, reviewed step — the Builder never creates, edits or
deletes sets.

1. Put the new master at
   `tools/enigma_builder/assets/icons/<new-id>/icon.png`, with its
   `source.png` and a `set.json`.
2. Point the Builder at it: `FIXED_SET_ID` in
   `tools/enigma_builder/iconsets.py`.
3. Repackage if you distribute the standalone binary
   (`bash tools/enigma_builder/package.sh`) — the assets are baked *into* the
   executable, so a set added afterwards is not in a copy you already handed
   out. `ENIGMA_BUILDER_ICON_SETS=/dir` overrides the location for a one-off.

If the set named by `FIXED_SET_ID` is missing or unusable, the Identity tab
says so and the build keeps the icons already committed in the repo — it never
silently ships a different mark.

## What happens at build time

Choosing a set is not what changes the app — running a build is.

1. The Builder snapshots every tracked icon file (roughly 90 of them, under
   `apps/enigma/src-tauri/icons/` and the generated Android project).
2. It runs `npx tauri icon <the set's master>`, which regenerates that whole
   tree: the desktop `.png`/`.ico`/`.icns` set and the Android mipmaps.
3. It copies the fresh mipmaps into `src-tauri/gen/android/` — `tauri icon`
   writes `icons/android/` only, and the generated Gradle project keeps its own
   copy, so without this step an Android build ships the previous launcher.
4. After the build it **restores the snapshot**, so the working tree ends where
   it started. That restore is on by default and can be turned off on the
   Identity tab; if a run dies mid-way, the Builder prints the git command that
   undoes it.

Choosing "Keep the icons already in the repo" skips all of this — no icon step
runs and nothing is touched.

The headless build does the same thing. `enigma-builder build product.yaml`
reads `branding.icon`, resolves it through the very same resolver the chooser
uses, and runs the same snapshot → generate → mirror → restore sequence, so one
product config produces one brand whether it is built from the window or from a
CI job. A config naming a set this Builder does not ship is **refused before any
work starts** rather than quietly built with the repo's icons — a release under
the wrong brand and a zero exit code is the one outcome worth failing for. The
set that branded a run is recorded in `build-info.json` as `icon_set`.

## Replacing the repo's committed icons

If a set should become the app's *permanent* icon rather than one build's, turn
off restore-after-build on the Identity tab, build once, and commit the
regenerated `src-tauri/icons/**` and `src-tauri/gen/android/**` yourself. The
Builder never runs git.

## Where the code is

| File | Responsibility |
|---|---|
| `tools/enigma_builder/assets/icons/` | the sets themselves |
| `tools/enigma_builder/iconsets.py` | discovery, `set.json` parsing, per-set validation |
| `tools/enigma_builder/icons.py` | the image rules, the `tauri icon` command, the Android mirror, snapshot/restore |
| `tools/enigma_builder/identity_tab.py` | the chooser, the preview, the fallbacks |
| `tools/enigma_builder/build_tab.py` | the icon step and putting the repo back afterwards (GUI) |
| `tools/enigma_builder/productbuild.py` | the same icon step for `enigma-builder build` (headless) |
| `tools/enigma_builder/tests/test_iconsets.py` | discovery, broken sets, and that every shipped set is valid |
| `tools/enigma_builder/tests/test_split_modes.py` | that the headless build honours `branding.icon` |

The two sets that ship — `default` (Enigma Blue) and `mono` (Slate Mono) — were
drawn by `tools/enigma_builder/assets/make_example_sets.py`, a stdlib-only
script kept so they are reproducible. Nothing in the Builder runs it, and you do
not need it: export a PNG from whatever you actually design in.

See also [tools/enigma_builder/README.md](tools/enigma_builder/README.md) for
the Builder as a whole, and [build.md](build.md) for the build scripts the icon
step runs in front of.
