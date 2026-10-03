#!/usr/bin/env python3
"""Morion Builder — build Morion, from a window or a script.

    python3 tools/morion_builder/main.py                    the window
    python3 tools/morion_builder/main.py --check            report what it resolved
    python3 tools/morion_builder/main.py targets            what this machine can package
    python3 tools/morion_builder/main.py build              a desktop bundle
    python3 tools/morion_builder/main.py build --bundles=deb,rpm --debug
    python3 tools/morion_builder/main.py dev                run with hot reload
    python3 tools/morion_builder/main.py android            an APK

It replaces the Zinnia Builder, which by the end built nothing but Morion under
another app family's name. One app, so there is no app to pick: every command
builds Morion.

Both surfaces assemble their commands through `appbuilder.commands`, so the
button and the flag run byte-identical builds — enigma's builder learned that
the hard way and says so.

**The shell scripts remain the primary path**, and this drives them rather than
replacing them: `apps/morion/build.sh` is what a developer runs by hand and
what CI runs, and a builder that shelled out to `npx tauri build` itself would
be a second route to a bundle that could quietly disagree with the first.

Nothing here is enigma's. `tools/enigma_builder` has feature editions, signing
and a price table that Morion has no equivalent of. What the two share is
`tools/appbuilder`.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
# This tool's own modules first, the shared ones after — both builders have a
# `window`, and the search order is what keeps them apart.
sys.path.insert(0, str(_HERE))
sys.path.append(str(_HERE.parent / "appbuilder"))

import appspec  # noqa: E402
import commands  # noqa: E402
import platforms  # noqa: E402
import runenv  # noqa: E402

#: The one app this builder builds: its directory under `apps/`.
SLUG = "morion"
#: What the app is called. Not tauri.conf.json's productName, which is still
#: "Zinnia" from before the rename and is what the packages are named — kept,
#: like the identifier, so installed copies stay the same program.
DISPLAY_NAME = "Morion"


def resolve_root(explicit: str | None) -> Path:
    """The checkout to drive: --repo, then $MORION_REPO, then walk up."""
    if explicit:
        root = Path(explicit).expanduser().resolve()
        if not (root / "apps" / SLUG).is_dir():
            sys.exit(f"not a checkout: {root} has no apps/{SLUG}/")
        return root
    env = os.environ.get("MORION_REPO")
    if env:
        return Path(env).expanduser().resolve()
    found = appspec.find_repo_root()
    if found is None:
        sys.exit("could not find the repo — pass --repo PATH or set MORION_REPO")
    return found


def load_app(root: Path) -> appspec.AppSpec:
    try:
        return appspec.load(root, SLUG)
    except FileNotFoundError as exc:
        sys.exit(str(exc))


def run_command(command: list[str], cwd: Path) -> int:
    """Headless run: stream straight through, no capture.

    The GUI needs line-by-line signals and a cancellable process group; a CLI
    already has a terminal and Ctrl-C, so it does not need the worker at all.
    """
    print("$ " + " ".join(command), flush=True)
    return subprocess.call(command, cwd=str(cwd), env=runenv.clean_env())


def cmd_check(root: Path) -> int:
    print(f"repository: {root}")
    try:
        app = appspec.load(root, SLUG)
    except FileNotFoundError as exc:
        print(f"  {exc}")
        return 1
    ok = app.build_sh.is_file()
    print(f"  {DISPLAY_NAME} (apps/{app.slug})  packaged as {app.product_name}  {app.identifier}  "
          f"v{app.version}  dev port {app.dev_port}  {'build.sh present' if ok else 'BUILD SCRIPT MISSING'}")
    print(f"  bundles land in {app.bundle_dir}")
    return 0 if ok else 1


def cmd_targets() -> int:
    print(f"building on {platforms.host_label()}\n")
    for target in platforms.TARGETS:
        mark = "yes" if target.buildable_here() else "no"
        needs = "" if target.buildable_here() else (
            "  needs " + " or ".join(
                {"linux": "Linux", "darwin": "macOS", "win32": "Windows"}.get(h, h)
                for h in target.hosts))
        print(f"  {mark:4} {target.key:9} {target.label}{needs}")
    return 0


def cmd_build(root: Path, args: argparse.Namespace) -> int:
    targets = tuple(t.strip() for t in args.bundles.split(",") if t.strip())
    # Refuse HERE, not four minutes into a cargo build: tauri compiles for the
    # machine it runs on, and asking Linux for a .dmg cannot succeed.
    for key in targets:
        why = platforms.refuse(key)
        if why:
            sys.exit(why)
    app = load_app(root)
    command = commands.desktop(
        app, debug=args.debug, run_tests=not args.no_test,
        frontend_only=args.frontend, bundles=targets)
    code = run_command(command, app.app_dir)
    if code == 0:
        for artefact in commands.artifacts(app, debug=args.debug)[:4]:
            print(f"  {artefact.stat().st_size / 1_048_576:8.1f} MB  {artefact}")
    return code


def cmd_dev(root: Path, args: argparse.Namespace) -> int:
    app = load_app(root)
    return run_command(commands.dev(app, web_only=args.web), app.app_dir)


def cmd_android(root: Path, args: argparse.Namespace) -> int:
    app = load_app(root)
    return run_command(commands.android(app, build_type=args.type, abi_spec=args.abi), root)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="morion-builder", description=__doc__.split("\n")[0])
    p.add_argument("--repo", metavar="PATH", help="the checkout to build from")
    p.add_argument("--check", action="store_true", help="report what was resolved, then exit")
    sub = p.add_subparsers(dest="command")

    build = sub.add_parser("build", help="build a desktop bundle")
    build.add_argument("--debug", action="store_true")
    build.add_argument("--no-test", action="store_true")
    build.add_argument("--frontend", action="store_true", help="frontend only, no Rust")
    build.add_argument(
        "--bundles", metavar="LIST", default="",
        help="package formats, comma-separated (deb,rpm,appimage,dmg,msi,nsis). "
             "Default: whatever tauri.conf.json says.")

    dev = sub.add_parser("dev", help="run with hot reload")
    dev.add_argument("--web", action="store_true", help="browser only, no Tauri window")

    sub.add_parser("targets", help="what this machine can package, and what it cannot")

    android = sub.add_parser("android", help="build an APK")
    android.add_argument("--type", choices=("debug", "release"), default="release")
    # The names scripts/build_android.sh accepts; it is the authority and
    # refuses anything else.
    android.add_argument("--abi", default="aarch64",
                         help="aarch64 (default, phones), x86_64 (emulator), armv7, i686, "
                              "a comma list, or all")
    return p


def main(argv: list[str]) -> int:
    args = parser().parse_args(argv[1:])
    if args.command == "targets":
        return cmd_targets()
    root = resolve_root(args.repo)

    if args.check:
        return cmd_check(root)
    if args.command == "build":
        return cmd_build(root, args)
    if args.command == "dev":
        return cmd_dev(root, args)
    if args.command == "android":
        return cmd_android(root, args)

    # No subcommand: the window. Imported lazily so the CLI works on a machine
    # with no Qt — a build server has no display and should not need PyQt6 to
    # run `morion-builder build`.
    try:
        import window
    except ImportError as exc:
        sys.exit(f"the window needs PyQt6 ({exc}). "
                 f"Install it, or use a subcommand: build / dev / android / targets.")
    return window.run(load_app(root), argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
