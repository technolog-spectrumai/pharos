# App icons — how a set is made (icons.md)

The Builder does not let a build engineer point at an arbitrary image. It offers
a **choice between curated icon sets**, each one a directory under
`tools/enigma_builder/assets/icons/`. Adding a set is how you add a choice.

The reason for the constraint: an app icon is not a per-build whim. It is the
mark a user identifies on their launcher, it has to survive being cropped to a
circle on Android and shrunk to 32px on a desktop, and a build that ships a
hastily-cropped screenshot is a build nobody can undo after release. A set is
reviewed once and reused; an arbitrary file is reviewed never.

## What a set looks like

```
tools/enigma_builder/assets/icons/<set-id>/
├── icon.png      # the master image (icon.svg is also accepted)
└── set.json      # what the chooser shows
```

The directory name is the set **id**: lowercase, stable, and what a saved
product config records. Rename it and existing configs stop resolving. Names
beginning with `.` or `_` are skipped, so `_wip/` is a convenient scratch space.

### `set.json`

```json
{
  "name": "Enigma Blue",
  "description": "The default mark: an amber rotor on a deep blue field. Reads as an app icon at 32px and survives the Android adaptive-icon crop.",
  "author": "Enigma26",
  "version": 1
}
```

| Field | Required | What it is |
|---|---|---|
| `name` | yes | Display name in the chooser. Two sets may share one; the id breaks the tie. |
| `description` | no | One or two sentences, shown under the preview. Say what the mark *is* and how it behaves when cropped — that is what the person choosing needs. |
| `author` | no | Who made it, for provenance. |
| `version` | no | `set.json` schema version. Only `1` exists; a higher number is refused rather than guessed at. |

### The master image

`icon.png` is what `tauri icon` consumes to generate every size the app ships.

- **Square.** A non-square master is an error, not a warning — Tauri would
  distort it into every output size.
- **At least 512×512**, and **1024×1024 recommended**. Below 512 is refused;
  between 512 and 1024 builds with a warning, because the largest generated
  sizes are then upscaled from a smaller original.
- **PNG with alpha**, or **SVG**. An SVG is accepted because Tauri accepts it,
  but note it is *not* measured — the square and size rules cannot be checked,
  so the responsibility moves to you.
- **Keep the mark inside the middle ~66%.** Android's adaptive icon crops the
  master to a circle, squircle or rounded square depending on the launcher, and
  anything in the corners is simply gone. Design for the circle, then check the
  square still looks deliberate.
- **Test it small.** Most of an icon's life is 32–48px in a taskbar. Fine
  detail and thin strokes disappear there; a shape and two colours survive.

The same validation the Builder applies to a set is the validation it applied to
a hand-picked file before — `icons.validate_source`, one implementation, so a
set that would fail a build is rejected in the chooser rather than at build time.

## The sets that ship

`tools/enigma_builder/assets/icons/` is the known location, and it holds the
marks that have been used or considered so far: `cross`, `okti`,
`okti-glasses`, `skull`, `sun-key`, `sun-key2`. Each keeps its untouched
original beside the generated master:

```
<set-id>/
├── icon.png     # normalised master: square, 1024×1024, what tauri icon consumes
├── source.png   # the original as authored — never overwritten
└── set.json
```

Most originals were neither square nor 1024: they were **padded** to square on
transparency (never stretched — the artwork is centred, not distorted) and
scaled to 1024. `source.png` is kept precisely so a better master can be
re-derived later without starting from an upscale. Where an original was
already square and large enough it was used as authored.

Two of them are byte-identical: `okti-glasses/source.png` and
`skull/source.png` are the same file under two names. Both are offered because
both names were asked for; delete one directory if that duplication is not
wanted.

## Adding one

Adding a set is **a manual step on purpose** — the Builder does not create,
edit or delete sets. It reads the directory and offers what it finds. That
keeps the reviewed-once property: a set appears because someone put it there
deliberately, not because a dialog made it easy.

1. `mkdir tools/enigma_builder/assets/icons/my-brand`
2. Put `icon.png` (1024×1024, square, alpha) and `set.json` in it.
3. Check it without launching anything:

   ```bash
   cd tools/enigma_builder
   venv/bin/python -c "import iconsets; [print(s.id, s.ok, s.problems) for s in iconsets.available_sets()]"
   QT_QPA_PLATFORM=offscreen venv/bin/python -m pytest tests/test_iconsets.py -q
   ```

   `tests/test_iconsets.py` asserts that *every* set in `assets/icons/` is
   valid, so a bad master fails there rather than in a release build.
4. Launch the Builder → **Identity**. The set appears in the chooser, with its
   description and a preview. A malformed set appears too, marked with the
   reason it cannot be used — sets are never hidden silently, because a set that
   vanishes looks like a Builder bug rather than a missing file.
5. If you package the Builder, run `bash tools/enigma_builder/package.sh` again:
   the assets are bundled *into* the executable, so a set added after packaging
   is not in the binary you copied elsewhere. For a one-off addition without
   repackaging, drop an `assets/icons/` directory beside the binary, or point
   `ENIGMA_BUILDER_ICON_SETS` at a directory of sets.

## What a product config records

The set **id**, not a path:

```yaml
# ── product-config extras (Builder-owned; stripped from the build config) ──
branding:
  icon: mono
```

That is the reason the id has to stay stable. A path would name a directory that
exists on exactly one machine — the engineer who saved the config — and would
resolve to nothing, or worse to something else, anywhere else. An id either
matches a set this Builder ships or it does not.

When it does not, the Identity tab falls back to the repo's committed icons
**and says which set it could not find**. It does not pick a neighbouring set
and it does not build silently: shipping the wrong mark is the failure this
whole mechanism exists to prevent.

Product configs written before the chooser existed stored a file path. Those
still load: the path is matched back to a set by its directory name or by its
master image, and only an unmatchable path falls back.

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
