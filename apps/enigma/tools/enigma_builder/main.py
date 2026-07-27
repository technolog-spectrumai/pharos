#!/usr/bin/env python3
"""Enigma Builder — pick features, generate the build config, build the app.

From a checkout:

    python -m venv venv && venv/bin/pip install -r requirements.txt
    venv/bin/python main.py

As a standalone binary (see package.sh), from anywhere:

    ./enigma-builder                       # asks for the checkout on first run
    ./enigma-builder --repo ~/src/enigma   # or point it explicitly
    ./enigma-builder --check               # report what it resolved, then exit

The tool writes exactly two files: apps/enigma/src-tauri/configs/
build_config.custom.yaml (gitignored) and — only when you change the app
identity — apps/enigma/src-tauri/tauri.conf.json. It never commits anything.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import paths


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="enigma-builder",
        description="Configure and build Enigma.",
    )
    parser.add_argument(
        "--repo",
        metavar="PATH",
        help="the Enigma checkout to configure and build, overriding both the "
        f"remembered choice and ${paths.ROOT_ENV_VAR}",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="print the resolved repository and exit without opening a window",
    )
    return parser.parse_args(argv)


def resolve_override(value: str | None) -> Path | None:
    """Validate a --repo argument, exiting with a usable message if it is wrong."""
    if value is None:
        return None
    root = Path(value).expanduser()
    if not paths.is_repo(root):
        print(
            f"{root} is not an Enigma checkout — expected {paths.MARKER} inside it.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return root


def run_check(override: Path | None) -> int:
    """Report which checkout would be used, and whether it is complete."""
    from PyQt6.QtCore import QCoreApplication, QSettings

    app = QCoreApplication(sys.argv)
    app.setApplicationName(paths.APP_NAME)
    app.setOrganizationName(paths.ORG_NAME)

    from window import SETTINGS_REPO_KEY

    source = "auto-detected"
    if override is not None:
        paths.set_repo_root(override)
        source = "--repo"
    else:
        saved = str(QSettings().value(SETTINGS_REPO_KEY, "") or "")
        if saved and paths.is_repo(Path(saved)):
            paths.set_repo_root(Path(saved))
            source = "remembered"
        elif paths.ROOT_ENV_VAR in __import__("os").environ:
            source = f"${paths.ROOT_ENV_VAR}"

    if not paths.have_repo():
        print("repository: none found")
        print(f"  looked next to the program, in the working directory, "
              f"and at ${paths.ROOT_ENV_VAR}")
        return 1

    print(f"repository: {paths.REPO_ROOT}  ({source})")
    missing = paths.missing_repo_files()
    if missing:
        print(f"incomplete — {len(missing)} required file(s) missing:")
        for path in missing:
            print(f"  {path}")
        return 1
    print("all required files present")
    print(f"output folder default: {paths.default_output_dir()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    override = resolve_override(args.repo)

    if args.check:
        return run_check(override)

    from PyQt6.QtWidgets import QApplication

    from window import MainWindow

    app = QApplication(sys.argv)
    # Both are required before QSettings() can resolve a config file.
    app.setApplicationName(paths.APP_NAME)
    app.setOrganizationName(paths.ORG_NAME)
    app.setStyle("Fusion")

    window = MainWindow(repo_override=override)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
