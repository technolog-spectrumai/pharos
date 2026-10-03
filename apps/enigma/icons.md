# App icons — the shipped mark and how to change it (icons.md)

The app icon is not a build option. It is part of the product's identity, like
its name, its bundle id and its version: one mark, fixed in the repository and
changed here, in code — [build.yaml](build.yaml) has no key for it.

## Why fixed rather than chosen

An app icon is what a user identifies on their launcher. A build that could
pick a different one is a build that can ship the wrong brand, and nothing
downstream would catch it — the artifact installs and runs perfectly with the
wrong face. Fixing it removes a decision that has exactly one right answer at
any moment, and the answer belongs in version control beside the name and the
version it goes out with.

## The master

```
apps/enigma/
├── app-icon.png          # normalised master: square, 1024×1024, what `tauri icon` consumes
└── app-icon-source.png   # the original as authored — never overwritten
```

`app-icon.png` is what `npx tauri icon` consumes; the original is kept beside
it so a better master can be re-derived later without starting from an upscale.
The current master was made from the 1536×1024 original by **padding** it to
square on transparency (centred, never stretched) and scaling — do the same
with a new original, so the artwork is not distorted.

Everything generated from the master is **committed**: the desktop
`.png`/`.ico`/`.icns` set under `apps/enigma/src-tauri/icons/`, and the Android
launcher mipmaps under `apps/enigma/src-tauri/gen/android/app/src/main/res/`.
A build uses those committed files as they are; it does not regenerate them.

### Master image requirements

- **Square** — Tauri would distort anything else into every output size.
- **At least 512×512**; **1024×1024 recommended**, below which the largest
  generated sizes are upscaled from a smaller original.
- **PNG with alpha**, or **SVG**.
- **Keep the mark inside the middle ~66%.** Android's adaptive icon crops to a
  circle, squircle or rounded square depending on the launcher; anything in the
  corners is gone. Design for the circle, then check the square still looks
  deliberate.
- **Test it small.** Most of an icon's life is 32–48px in a taskbar, where fine
  detail and thin strokes disappear.

## Changing the app icon

Deliberately a manual, reviewed step.

1. Replace `apps/enigma/app-icon.png` (and `app-icon-source.png`) with the new
   master.
2. Regenerate every size from it:

   ```bash
   cd apps/enigma
   npx tauri icon app-icon.png
   ```

   That rewrites `src-tauri/icons/` — the desktop set plus an `icons/android/`
   mipmap tree.
3. Mirror the Android mipmaps into the generated project. The Gradle project
   does **not** read `icons/android/`: `tauri android init` copies it once, at
   init time, so without this step an Android build ships the previous
   launcher icon.

   ```bash
   cp -r src-tauri/icons/android/. src-tauri/gen/android/app/src/main/res/
   ```
4. Review the diff (roughly 90 files) and commit it with the master.

The in-app marks (the unlock gate and the top bar) are separate files, cut from
the same master: `apps/enigma/src/assets/<logoDir>/app_icon.png` and
`bar_icon.png` — see [`logos.ts`](apps/enigma/src/assets/logos.ts). Replace
them in the same change so the app's face stays the same everywhere.

Morion keeps its own master and generator:
[`apps/morion/app-icon.png`](apps/morion/app-icon.png) and
[`apps/morion/scripts/make_icons.py`](apps/morion/scripts/make_icons.py).

See also [build.md](build.md) for the build itself.
