#!/usr/bin/env python3
"""Headless Android-signing commands — the CLI half of signing.py.

Two ways in, by design:

- ``enigma-builder signing android <action>`` — main.py resolves the repository
  (with the remembered QSettings choice available) and calls the functions here
  with the resolved gen/android directory.
- ``python3 signing_cli.py <action> --gen DIR`` — no Qt, no venv, stdlib only.
  This is what scripts/build_android.sh calls, so a release build's signing
  checks cannot depend on the GUI's environment.

Everything here prints to stdout and returns an exit code; nothing imports
PyQt6. Keeping this module Qt-free is load-bearing: it must run under the bare
system python3 that a build machine has anyway.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import signing


def status(android_gen: Path) -> int:
    """Print the signing configuration report; 0 when a release would sign."""
    result = signing.inspect(android_gen)
    print(result.report())
    return 0 if result.signed_release else 1


def _parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="signing_cli.py",
        description="Headless Android signing checks (no Qt).",
    )
    sub = parser.add_subparsers(dest="action", required=True)

    status_p = sub.add_parser("status", help="report the release-signing configuration")
    status_p.add_argument(
        "--gen",
        metavar="DIR",
        required=True,
        help="the generated Android project (…/src-tauri/gen/android)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse(argv if argv is not None else sys.argv[1:])
    if args.action == "status":
        return status(Path(args.gen).expanduser())
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
