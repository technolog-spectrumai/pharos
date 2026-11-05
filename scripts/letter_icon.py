"""Draw an app's letter mark: one letter on a rounded tile, as plain geometry
(no font), supersampled so the small sizes stay crisp.

    python3 scripts/letter_icon.py APP_DIR LETTER TILE INK [LOGO_DIR]

writes APP_DIR/app-icon.png and app-icon-source.png (1024, the master `tauri
icon` consumes) and, with LOGO_DIR, src/assets/LOGO_DIR/app_icon.png (512) and
bar_icon.png (128). Then regenerate the platform sizes (technology.md, "Changing
the app icon"):  cd APP_DIR && npx tauri icon app-icon.png
                 cp -r src-tauri/icons/android/. src-tauri/gen/android/app/src/main/res/
"""
import os, sys
from PIL import Image, ImageDraw

SS = 4096  # drawing size; downsampled for antialiasing

LETTERS = {
    # Each a list of polygons in unit coordinates (0..1 of the tile).
    "E": [
        [(0.30, 0.24), (0.43, 0.24), (0.43, 0.76), (0.30, 0.76)],  # stem
        [(0.30, 0.24), (0.71, 0.24), (0.71, 0.36), (0.30, 0.36)],  # top
        [(0.30, 0.44), (0.65, 0.44), (0.65, 0.56), (0.30, 0.56)],  # middle
        [(0.30, 0.64), (0.71, 0.64), (0.71, 0.76), (0.30, 0.76)],  # bottom
    ],
    "V": [
        [(0.23, 0.24), (0.375, 0.24), (0.50, 0.605), (0.625, 0.24), (0.77, 0.24), (0.575, 0.76), (0.425, 0.76)],
    ],
}


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


def draw(letter, tile, ink):
    im = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = int(SS * 0.04)
    d.rounded_rectangle([m, m, SS - m, SS - m], radius=int(SS * 0.22), fill=hexrgb(tile))
    for poly in LETTERS[letter]:
        d.polygon([(x * SS, y * SS) for x, y in poly], fill=hexrgb(ink))
    return im


def main():
    app, letter, tile, ink, *rest = sys.argv[1:]
    im = draw(letter.upper(), tile, ink)
    for name in ("app-icon.png", "app-icon-source.png"):
        im.resize((1024, 1024), Image.LANCZOS).save(os.path.join(app, name))
    if rest:
        d = os.path.join(app, "src", "assets", rest[0])
        os.makedirs(d, exist_ok=True)
        im.resize((512, 512), Image.LANCZOS).save(os.path.join(d, "app_icon.png"))
        im.resize((128, 128), Image.LANCZOS).save(os.path.join(d, "bar_icon.png"))


main()
