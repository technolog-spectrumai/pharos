#!/usr/bin/env python3
"""
Enigma Map Packager — PyQt6 GUI producing offline map region packages for the
Enigma app (see enigma/map.md Part II).

A package is `<name>.pmtiles` (a bbox/zoom subset extracted from any PMTiles
archive over HTTP range requests) plus `<name>.manifest.json` (the BLAKE3
manifest the app verifies on import). Distribute both files to the device by
any channel you trust — USB, your own Enigma Cloud, etc.

Install:
    python -m pip install -r requirements.txt

Run:
    python main.py
"""

from __future__ import annotations

import sys

from PyQt6.QtWidgets import QApplication

from utils import APP_NAME, ORG_NAME
from window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setOrganizationName(ORG_NAME)
    app.setStyle("Fusion")

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
