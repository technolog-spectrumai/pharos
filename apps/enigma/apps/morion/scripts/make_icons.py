#!/usr/bin/env python3
"""Regenerate every Morion icon from one file: apps/morion/app-icon.png.

    python3 apps/morion/scripts/make_icons.py

What it writes, all under apps/morion/src-tauri/icons/:

* the desktop set the Linux packages install (32, 64, 128, 256 and 512 px
  PNGs, plus icon.ico and icon.icns), from `npx tauri icon`;
* the Android launcher tree (android/mipmap-*), with one change: the adaptive
  icon's FOREGROUND is regenerated from a padded copy of the artwork. Android
  shows only the inner 72 of an adaptive icon's 108 dp and masks that to a
  circle, squircle or rounded square, so a mark that runs to the edges — as
  this one does — would lose its tip and brim. Padded to 50 % of the canvas it
  sits inside the 66 dp safe circle on every launcher. The legacy
  ic_launcher/ic_launcher_round images Tauri already insets, so they stay;
* the iOS set, because the generator writes it and Enigma keeps its own.

`tauri android init` copies icons/android into the Android project once, when
it creates it (scripts/build_android.sh does that on the first Android build).
If that project already exists, this script mirrors the tree into it too, so
the launcher never keeps an old icon.

The artwork must be a square PNG of at least 512 px; 1024 px is better, since
the largest generated sizes are upscaled from anything smaller. Needs Node (for
the repo's own Tauri CLI) and Pillow (python3-pil on Ubuntu, python3-pillow on
Fedora).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
SOURCE = APP / "app-icon.png"
ICONS = APP / "src-tauri" / "icons"
ANDROID_RES = APP / "src-tauri" / "gen" / "android" / "app" / "src" / "main" / "res"

MIN_SIDE = 512
RECOMMENDED_SIDE = 1024
#: The share of the adaptive canvas the mark may fill. At 50 % the helmet's
#: farthest points (the brim tips) sit about 32 dp from the centre, inside the
#: 66 dp safe circle of 108 dp. A differently shaped mark may allow more.
ADAPTIVE_SHARE = 0.50


def fail(message: str) -> None:
    print(f"make_icons: {message}", file=sys.stderr)
    sys.exit(1)


def tauri_icon(source: Path, out: Path | None) -> None:
    command = ["npx", "tauri", "icon", str(source)]
    if out is not None:
        command += ["-o", str(out)]
    subprocess.run(command, cwd=APP, check=True)


def main() -> None:
    try:
        from PIL import Image
    except ImportError:
        fail("needs Pillow: python3-pil (Ubuntu), python3-pillow (Fedora) or pip install pillow")

    if not SOURCE.is_file():
        fail(f"no artwork at {SOURCE}")
    artwork = Image.open(SOURCE)
    if artwork.format != "PNG":
        fail(f"{SOURCE.name} must be a PNG")
    width, height = artwork.size
    if width != height:
        fail(f"{SOURCE.name} must be square; it is {width}x{height}")
    if width < MIN_SIDE:
        fail(f"{SOURCE.name} is {width}px; at least {MIN_SIDE}px is needed")
    if width < RECOMMENDED_SIDE:
        print(f"make_icons: {SOURCE.name} is {width}px; {RECOMMENDED_SIDE}px is recommended, "
              "so the largest sizes are upscaled")

    # Everything, straight from the artwork.
    tauri_icon(SOURCE, None)

    # The adaptive foreground, from a padded copy.
    with tempfile.TemporaryDirectory() as scratch:
        scratch_dir = Path(scratch)
        side = width
        mark = round(side * ADAPTIVE_SHARE)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        offset = (side - mark) // 2
        canvas.paste(artwork.convert("RGBA").resize((mark, mark), Image.LANCZOS), (offset, offset))
        padded = scratch_dir / "adaptive.png"
        canvas.save(padded)
        out = scratch_dir / "out"
        tauri_icon(padded, out)
        replaced = 0
        for foreground in sorted((out / "android").glob("mipmap-*/ic_launcher_foreground.png")):
            shutil.copy2(foreground, ICONS / "android" / foreground.parent.name / foreground.name)
            replaced += 1
        if replaced == 0:
            fail("the Tauri CLI wrote no Android foregrounds; nothing was padded")

    # The Android project, when there is one.
    mirrored = 0
    if ANDROID_RES.is_dir():
        for path in sorted((ICONS / "android").rglob("*")):
            if path.is_file():
                target = ANDROID_RES / path.relative_to(ICONS / "android")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
                mirrored += 1

    print(f"make_icons: icons written to {ICONS.relative_to(APP)}; "
          f"{replaced} adaptive foregrounds padded; "
          + (f"{mirrored} files mirrored into the Android project" if mirrored
             else "no Android project yet (the first Android build copies them in)"))


if __name__ == "__main__":
    main()
