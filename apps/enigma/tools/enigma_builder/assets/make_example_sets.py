#!/usr/bin/env python3
"""Regenerate the two example icon sets under ``assets/icons/``.

Nothing in the Builder runs this: the PNGs it writes are committed, and a set
author normally exports a master image from a real design tool instead. It
exists so the shipped examples are reproducible — a flat colour square would
not have shown whether the safe zone, the alpha channel or the 1024px minimum
actually work, and pulling in Pillow just to draw two circles is not worth a
dependency the rest of the tool does not have.

    python3 assets/make_example_sets.py

Pure stdlib. Shapes are signed distance fields sampled once per pixel, with the
distance itself used as the coverage value — that is cheaper than
supersampling and gives a clean edge at 1024px.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

SIDE = 1024

#: Android's adaptive-icon mask keeps roughly the central 66% of the image and
#: throws the rest away. Both example glyphs stay inside this, so the launcher
#: icon is not a cropped fragment. See icons.md.
SAFE_ZONE = 0.62

HERE = Path(__file__).resolve().parent
SETS_DIR = HERE / "icons"

Colour = tuple[int, int, int]


# ----- tiny maths ----------------------------------------------------------


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return low if value < low else high if value > high else value


def mix(a: Colour, b: Colour, t: float) -> Colour:
    t = clamp(t)
    return (
        round(a[0] + (b[0] - a[0]) * t),
        round(a[1] + (b[1] - a[1]) * t),
        round(a[2] + (b[2] - a[2]) * t),
    )


def over(base: Colour, top: Colour, coverage: float) -> Colour:
    """Composite ``top`` onto ``base`` at ``coverage`` (both opaque)."""
    return mix(base, top, coverage)


def coverage(distance: float, feather: float = 1.0) -> float:
    """Turn a signed distance in pixels into an antialiased 0..1 coverage."""
    return clamp(0.5 - distance / feather)


def sdf_circle(x: float, y: float, radius: float) -> float:
    return math.hypot(x, y) - radius


def sdf_ring(x: float, y: float, radius: float, half_width: float) -> float:
    return abs(math.hypot(x, y) - radius) - half_width


def sdf_hexagon(x: float, y: float, radius: float) -> float:
    """Regular pointy-top hexagon, inradius ``radius`` (Inigo Quilez's form)."""
    kx, ky, kz = -0.8660254038, 0.5, 0.5773502692
    x, y = abs(x), abs(y)
    push = 2.0 * min(0.0, kx * x + ky * y)
    x -= push * kx
    y -= push * ky
    x -= clamp(x, -kz * radius, kz * radius)
    y -= radius
    return math.copysign(math.hypot(x, y), y)


def sdf_box(x: float, y: float, half_w: float, half_h: float,
            corner: float = 0.0) -> float:
    dx = abs(x) - half_w + corner
    dy = abs(y) - half_h + corner
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    return outside + min(max(dx, dy), 0.0) - corner


# ----- PNG -----------------------------------------------------------------


def write_rgba_png(path: Path, side: int, pixels: bytearray) -> Path:
    """8-bit RGBA PNG, one Up-filtered scanline per row.

    Up (filter 2) rather than None: these images are mostly vertical gradients
    and flat fields, where each row nearly equals the row above, so the filtered
    bytes are almost all zero and deflate collapses them.
    """
    stride = side * 4
    raw = bytearray()
    previous = bytes(stride)
    for row in range(side):
        line = pixels[row * stride:(row + 1) * stride]
        raw.append(2)
        raw.extend((line[i] - previous[i]) & 0xFF for i in range(stride))
        previous = line

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", side, side, 8, 6, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    return path


def render(side: int, shade) -> bytearray:
    """Call ``shade(nx, ny, px, py)`` per pixel; it returns (r, g, b, a)."""
    pixels = bytearray(side * side * 4)
    centre = side / 2.0
    index = 0
    for row in range(side):
        py = row + 0.5 - centre
        ny = py / centre
        for column in range(side):
            px = column + 0.5 - centre
            r, g, b, a = shade(px / centre, ny, px, py)
            pixels[index] = r
            pixels[index + 1] = g
            pixels[index + 2] = b
            pixels[index + 3] = a
            index += 4
    return pixels


# ----- set one: Enigma Blue -------------------------------------------------
#
# A rotor seen face-on: amber ring, twelve teeth, a keyhole in a dark hub, on a
# deep blue field. Full-bleed so the Android mask has something to crop into.

BLUE_TOP: Colour = (30, 46, 82)
BLUE_BOTTOM: Colour = (8, 13, 26)
AMBER: Colour = (240, 178, 66)
AMBER_DIM: Colour = (176, 124, 40)
HUB: Colour = (12, 19, 36)

# Every fraction below is of the HALF side, so the outermost feature —
# TOOTH_ORBIT + TOOTH_RADIUS = 0.59 — puts the glyph's diameter at 0.59 of the
# full canvas, just inside SAFE_ZONE.
RING_RADIUS = 0.435
RING_HALF_WIDTH = 0.078
TEETH = 12
TOOTH_ORBIT = 0.542
TOOTH_RADIUS = 0.048
HUB_RADIUS = 0.287
KEY_HEAD = 0.096


def shade_blue(nx: float, ny: float, px: float, py: float):
    half = SIDE / 2.0

    # Background: a vertical gradient lifted by a soft glow behind the rotor.
    colour = mix(BLUE_TOP, BLUE_BOTTOM, clamp((ny + 1.0) / 2.0))
    glow = clamp(1.0 - math.hypot(nx, ny) / 0.95) ** 2
    colour = mix(colour, (54, 78, 128), glow * 0.55)

    # Teeth first, so the ring overlaps them rather than the other way round.
    angle_step = 2.0 * math.pi / TEETH
    theta = math.atan2(py, px)
    nearest = round(theta / angle_step) * angle_step
    tx = px - math.cos(nearest) * TOOTH_ORBIT * half
    ty = py - math.sin(nearest) * TOOTH_ORBIT * half
    colour = over(colour, AMBER_DIM,
                  coverage(sdf_circle(tx, ty, TOOTH_RADIUS * half)))

    colour = over(colour, AMBER,
                  coverage(sdf_ring(px, py, RING_RADIUS * half,
                                    RING_HALF_WIDTH * half)))
    colour = over(colour, HUB, coverage(sdf_circle(px, py, HUB_RADIUS * half)))

    # Keyhole: a disc with a tapered slot hanging off it.
    head = sdf_circle(px, py - 0.033 * half, KEY_HEAD * half)
    stem = sdf_box(px, py - 0.157 * half, 0.048 * half, 0.102 * half,
                   0.022 * half)
    colour = over(colour, AMBER, coverage(min(head, stem)))

    return (*colour, 255)


# ----- set two: Slate Mono --------------------------------------------------
#
# Deliberately nothing like the first one at thumbnail size: pale field, dark
# glyph, straight edges, no colour at all. If the two were both dark discs the
# chooser's preview would be useless.

PAPER: Colour = (237, 238, 240)
SLATE: Colour = (35, 38, 45)

# Hexagon fractions are of the half side too, and a pointy-top hexagon reaches
# 1/cos(30) further at its vertices: (0.464 + 0.058) * 1.1547 = 0.60.
HEX_RADIUS = 0.464
HEX_HALF_WIDTH = 0.058
KEY_HEAD = 0.115


def shade_mono(nx: float, ny: float, px: float, py: float):
    half = SIDE / 2.0

    # A barely-there vignette; flat white reads as "missing image".
    colour = mix(PAPER, (214, 217, 222), clamp(math.hypot(nx, ny) - 0.55) * 1.4)

    hexagon = abs(sdf_hexagon(px, py, HEX_RADIUS * half)) - HEX_HALF_WIDTH * half
    colour = over(colour, SLATE, coverage(hexagon))

    # The same keyhole as the blue set, so the two read as one family.
    head = sdf_circle(px, py + 0.050 * half, KEY_HEAD * half)
    stem = sdf_box(px, py - 0.145 * half, 0.058 * half, 0.130 * half,
                   0.028 * half)
    colour = over(colour, SLATE, coverage(min(head, stem)))

    return (*colour, 255)


# ----- driver ---------------------------------------------------------------


SETS = (
    ("default", shade_blue),
    ("mono", shade_mono),
)


def main() -> None:
    for set_id, shader in SETS:
        target = SETS_DIR / set_id / "icon.png"
        if not (SETS_DIR / set_id / "set.json").is_file():
            raise SystemExit(
                f"{SETS_DIR / set_id / 'set.json'} is missing — write the "
                f"metadata first; this script only draws the master image"
            )
        print(f"drawing {target} ...")
        write_rgba_png(target, SIDE, render(SIDE, shader))
        print(f"  {target.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
