"""App identity constants and tiny shared helpers (UI-free)."""
from __future__ import annotations

import re

APP_NAME = "Enigma Map Packager"
ORG_NAME = "enigma-tools"
USER_AGENT = "enigma-map-packager/1.0 (offline region packager)"


def human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024**2:
        return f"{n / 1024:.1f} KB"
    if n < 1024**3:
        return f"{n / 1024**2:.1f} MB"
    return f"{n / 1024**3:.2f} GB"


def safe_filename(name: str) -> str:
    """A filesystem-safe stem for `<name>.pmtiles` (mirrors the app's export
    sanitizer: letters/digits/space/underscore/dash survive)."""
    cleaned = re.sub(r"[^\w \-]", "_", name.strip(), flags=re.UNICODE)
    return cleaned or "region"
