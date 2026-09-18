#!/usr/bin/env python3
"""Zinnia Builder — build morion, from a GUI or a script.

    python3 tools/zinnia_builder/main.py                 the window
    python3 tools/zinnia_builder/main.py --check         report what it resolved
    python3 tools/zinnia_builder/main.py build morion  headless, one app
    python3 tools/zinnia_builder/main.py build --all     headless, every app
    python3 tools/zinnia_builder/main.py dev morion    run with hot reload
    python3 tools/zinnia_builder/main.py android morion  an APK

Both surfaces assemble their commands through `appbuilder.commands`, so the
button and the flag run byte-identical builds. That is the whole reason the
module exists — enigma's builder learned it the hard way and says so.

**The shell scripts remain the primary path**, and this drives them rather than
replacing them: `apps/<app>/build.sh` is what a developer runs by hand and what
CI runs, and a builder that shelled out to `npx tauri build` itself would be a
second route to a bundle that could quietly disagree with the first.

Nothing here is enigma's. `tools/enigma_builder` is untouched — it has feature
editions, signing and a price table that these three apps have no equivalent of.
What the two share is `tools/appbuilder`.
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


def resolve_root(explicit: str | None) -> Path:
    """The checkout to drive: --repo, then $ZINNIA_REPO, then walk up."""
    if explicit:
        root = Path(explicit).expanduser().resolve()
        if not (root / "apps").is_dir():
            sys.exit(f"not a checkout: {root} has no apps/")
        return root
    env = os.environ.get("ZINNIA_REPO")
    if env:
        return Path(env).expanduser().resolve()
    found = appspec.find_repo_root()
    if found is None:
        sys.exit("could not find the repo — pass --repo PATH or set ZINNIA_REPO")
    return found


def run_command(command: list[str], cwd: Path) -> int:
    """Headless run: stream straight through, no capture.

    The GUI needs line-by-line signals and a cancellable process group; a CLI
    already has a terminal and Ctrl-C, so it does not need the worker at all.
    """
    print("$ " + " ".join(command), flush=True)
    return subprocess.call(command, cwd=str(cwd), env=runenv.clean_env())


def cmd_check(root: Path) -> int:
    apps = appspec.load_all(root)
    print(f"repository: {root}")
    if not apps:
        print(f"  no apps found under {root / 'apps'}")
        return 1
    for app in apps:
        ok = app.build_sh.is_file()
        print(f"  {app.slug:9} {app.product_name:10} {app.identifier:28} "
              f"v{app.version:8} port {app.dev_port}  "
              f"{'build.sh present' if ok else 'BUILD SCRIPT MISSING'}")
    return 0


def cmd_build(root: Path, args: argparse.Namespace) -> int:
    targets = tuple(t.strip() for t in args.bundles.split(",") if t.strip())
    # Refuse HERE, not four minutes into a cargo build: tauri compiles for the
    # machine it runs on, and asking Linux for a .dmg cannot succeed.
    for key in targets:
        why = platforms.refuse(key)
        if why:
            sys.exit(why)

    slugs = appspec.ZINNIA_APPS if args.all else (args.app,)
    for slug in slugs:
        app = appspec.load(root, slug)
        command = commands.desktop(
            app, debug=args.debug, run_tests=not args.no_test,
            frontend_only=args.frontend, bundles=targets)
        code = run_command(command, app.app_dir)
        if code != 0:
            return code
        for artefact in commands.artifacts(app, debug=args.debug)[:4]:
            print(f"  {artefact.stat().st_size / 1_048_576:8.1f} MB  {artefact}")
    return 0


def cmd_dev(root: Path, args: argparse.Namespace) -> int:
    app = appspec.load(root, args.app)
    return run_command(commands.dev(app, web_only=args.web), app.app_dir)


def cmd_android(root: Path, args: argparse.Namespace) -> int:
    app = appspec.load(root, args.app)
    command = commands.android(app, build_type=args.type, abi_spec=args.abi)
    return run_command(command, root)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="zinnia-builder", description=__doc__.split("\n")[0])
    parser.add_argument("--repo", metavar="PATH", help="the checkout to build from")
    parser.add_argument("--check", action="store_true", help="report what was resolved, then exit")
    sub = parser.add_subparsers(dest="command")

    build = sub.add_parser("build", help="build a desktop bundle")
    build.add_argument("app", nargs="?", choices=appspec.ZINNIA_APPS)
    build.add_argument("--all", action="store_true", help="every app, in turn")
    build.add_argument("--debug", action="store_true")
    build.add_argument("--no-test", action="store_true")
    build.add_argument("--frontend", action="store_true", help="frontend only, no Rust")
    build.add_argument(
        "--bundles", metavar="LIST", default="",
        help="package formats, comma-separated (deb,rpm,appimage,dmg,msi,nsis). "
             "Default: whatever tauri.conf.json says.")

    dev = sub.add_parser("dev", help="run with hot reload")
    dev.add_argument("app", choices=appspec.ZINNIA_APPS)
    dev.add_argument("--web", action="store_true", help="browser only, no Tauri window")

    sub.add_parser("targets", help="what this machine can package, and what it cannot")

    android = sub.add_parser("android", help="build an APK")
    android.add_argument("app", choices=appspec.ZINNIA_APPS)
    android.add_argument("--type", choices=("debug", "release"), default="release")
    android.add_argument("--abi", default="arm64")

    args = parser.parse_args(argv[1:])
    root = resolve_root(args.repo)

    if args.check:
        return cmd_check(root)
    if args.command == "targets":
        print(f"building on {platforms.host_label()}\n")
        for target in platforms.TARGETS:
            mark = "yes" if target.buildable_here() else "no"
            needs = "" if target.buildable_here() else (
                "  needs " + " or ".join(
                    {"linux": "Linux", "darwin": "macOS", "win32": "Windows"}.get(h, h)
                    for h in target.hosts))
            print(f"  {mark:4} {target.key:9} {target.label}{needs}")
        return 0
    if args.command == "build":
        if not args.app and not args.all:
            build.error("name an app, or pass --all")
        return cmd_build(root, args)
    if args.command == "dev":
        return cmd_dev(root, args)
    if args.command == "android":
        return cmd_android(root, args)

    # No subcommand: the window. Imported lazily so the CLI works on a machine
    # with no Qt — a build server has no display and should not need PyQt6 to
    # run `zinnia-builder build --all`.
    try:
        import window
    except ImportError as exc:
        sys.exit(f"the GUI needs PyQt6 ({exc}). "
                 f"Install it, or use a subcommand: build / dev / android.")
    return window.run(root, argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
