#!/usr/bin/env python3
"""Enigma Builder — pick features, generate the build config, build the app.

    python -m venv venv && venv/bin/pip install -r requirements.txt
    venv/bin/python main.py

The tool writes exactly two files: apps/enigma/src-tauri/configs/
build_config.custom.yaml (gitignored) and — only when you change the app
identity — apps/enigma/src-tauri/tauri.conf.json. It never commits anything.
"""

from __future__ import annotations

import sys

from PyQt6.QtWidgets import QApplication

from paths import APP_NAME, ORG_NAME
from window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    # Both are required before QSettings() can resolve a config file.
    app.setApplicationName(APP_NAME)
    app.setOrganizationName(ORG_NAME)
    app.setStyle("Fusion")

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
