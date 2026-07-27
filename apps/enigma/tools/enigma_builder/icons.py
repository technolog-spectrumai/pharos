"""Replacing the app icon for the desktop bundles and the Android launcher.

Tauri generates every icon size from one square source image with
``npx tauri icon``, which writes ``src-tauri/icons/`` — the PNG/ICNS/ICO the
desktop bundles use, plus an ``icons/android/`` mipmap tree.

The Android project does **not** read that tree. ``tauri android init`` copies
it into ``gen/android/app/src/main/res/`` once, at init time, and the two drift
apart from then on (they already differ in this repo). So changing the launcher
icon needs a second step: mirror ``icons/android/`` into the generated project.
:func:`sync_android_icons` is that step.

Both trees are tracked in git — roughly 90 files — so the Builder snapshots
them before a build and puts them back afterwards, the same way it treats
tauri.conf.json.

No image library needed: the source is handed to Tauri untouched, and the only
thing read here is the PNG header.
"""

from __future__ import annotations

import shutil
import struct
from pathlib import Path

import paths

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

#: Smallest source Tauri can generate a full icon set from without visible
#: blur on a 512px launcher; 1024 is what Tauri's own docs recommend.
MIN_SIDE = 512
RECOMMENDED_SIDE = 1024

SUFFIXES = (".png", ".svg")


def icons_dir() -> Path:
    return paths.SRC_TAURI / "icons"


def android_icons_dir() -> Path:
    """Where `tauri icon` writes the Android mipmap tree."""
    return icons_dir() / "android"


def android_res_dir() -> Path:
    """Where the generated Gradle project actually reads its launcher from."""
    return paths.ANDROID_GEN / "app" / "src" / "main" / "res"


def preview_icon() -> Path | None:
    """A reasonably sized existing icon to show in the GUI, if there is one."""
    for name in ("128x128@2x.png", "128x128.png", "icon.png", "64x64.png"):
        candidate = icons_dir() / name
        if candidate.is_file():
            return candidate
    return None


def png_size(path: Path) -> tuple[int, int] | None:
    """(width, height) from a PNG's IHDR chunk, or None if it is not a PNG."""
    try:
        with path.open("rb") as handle:
            header = handle.read(24)
    except OSError:
        return None
    if len(header) < 24 or not header.startswith(PNG_MAGIC) or header[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", header[16:24])
    return width, height


def validate_source(path: Path) -> tuple[list[str], list[str]]:
    """Check a candidate source image. Returns (errors, warnings).

    Errors block the build; warnings are things Tauri will accept but that
    produce a worse icon than the user probably wants.
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not path.is_file():
        return [f"{path} does not exist"], []
    if path.suffix.lower() not in SUFFIXES:
        return [f"{path.suffix or 'that file'} is not supported — use a PNG or SVG"], []

    if path.suffix.lower() == ".svg":
        return errors, warnings  # scalable; nothing useful to measure

    size = png_size(path)
    if size is None:
        return [f"{path.name} is not a readable PNG"], []

    width, height = size
    if width != height:
        errors.append(f"the icon must be square — {path.name} is {width}×{height}")
    elif width < MIN_SIDE:
        errors.append(
            f"{path.name} is {width}×{height}; at least {MIN_SIDE}×{MIN_SIDE} is "
            f"needed to fill every generated size"
        )
    elif width < RECOMMENDED_SIDE:
        warnings.append(
            f"{path.name} is {width}×{height}; {RECOMMENDED_SIDE}×"
            f"{RECOMMENDED_SIDE} is recommended so the largest sizes are not upscaled"
        )
    return errors, warnings


def icon_command(source: Path) -> list[str]:
    """The Tauri invocation that regenerates every icon from ``source``.

    Runs with cwd = apps/enigma so the CLI finds tauri.conf.json and writes the
    icons directory beside it.
    """
    return ["npx", "tauri", "icon", str(source.resolve())]


def sync_android_icons() -> int:
    """Mirror ``icons/android/`` into the generated Gradle project.

    Returns the number of files copied; 0 when there is no Android project yet
    (``tauri android init`` will copy them itself at that point).
    """
    source = android_icons_dir()
    target = android_res_dir()
    if not source.is_dir() or not target.is_dir():
        return 0

    copied = 0
    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        destination = target / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
        copied += 1
    return copied


def tracked_icon_files() -> list[Path]:
    """Every file a regeneration could overwrite, for the snapshot."""
    found: list[Path] = []
    for root in (icons_dir(), android_res_dir()):
        if root.is_dir():
            found.extend(p for p in sorted(root.rglob("*")) if p.is_file())
    return found


def snapshot() -> dict[Path, bytes]:
    """Read every icon file into memory so the build can be undone.

    A few megabytes, which is cheaper and less surprising than shelling out to
    git — and it cannot discard an icon edit the user made themselves.
    """
    saved: dict[Path, bytes] = {}
    for path in tracked_icon_files():
        try:
            saved[path] = path.read_bytes()
        except OSError:
            continue
    return saved


def restore(saved: dict[Path, bytes]) -> int:
    """Put a :func:`snapshot` back. Returns the number of files rewritten."""
    restored = 0
    for path, data in saved.items():
        try:
            if path.is_file() and path.read_bytes() == data:
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            restored += 1
        except OSError:
            continue
    return restored


def recovery_hint() -> str:
    """What to run if the Builder dies between regenerating and restoring."""
    return (
        "git checkout -- apps/enigma/src-tauri/icons "
        "apps/enigma/src-tauri/gen/android/app/src/main/res"
    )
