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
    # --repo is legal both before and after a subcommand. The parent parser
    # must default to SUPPRESS: with a plain default of None, the subparser's
    # copy would overwrite a value the top-level parser already captured, and
    # `enigma-builder --repo X signing …` would silently lose X.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--repo",
        metavar="PATH",
        default=argparse.SUPPRESS,
        help="the Enigma checkout to use, overriding both the remembered "
        f"choice and ${paths.ROOT_ENV_VAR}",
    )

    parser = argparse.ArgumentParser(
        prog="enigma-builder",
        description="Configure and build Enigma.",
        parents=[common],
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="print the resolved repository and exit without opening a window",
    )

    # Subcommands are optional on purpose: a bare `enigma-builder` opens the
    # GUI exactly as it always has.
    sub = parser.add_subparsers(dest="command")

    signing_p = sub.add_parser(
        "signing", help="signing configuration and checks", parents=[common]
    )
    signing_sub = signing_p.add_subparsers(dest="platform", required=True)
    android_p = signing_sub.add_parser(
        "android", help="Android release signing", parents=[common]
    )
    android_sub = android_p.add_subparsers(dest="action", required=True)
    android_sub.add_parser(
        "status",
        help="report whether a release build would be signed, and from where",
        parents=[common],
    )
    verify_sub = android_sub.add_parser(
        "verify",
        help="verify a built artifact (or the last build) and print its identity",
        parents=[common],
    )
    verify_sub.add_argument("artifact", nargs="?", metavar="APK_OR_AAB",
                            help="one artifact; omitted = the last release build")
    verify_sub.add_argument("--allow-unsigned", action="store_true")
    create_sub = android_sub.add_parser(
        "create",
        help="mint a release keystore (outside the repo) with keytool",
        parents=[common],
    )
    create_sub.add_argument("--keystore", metavar="PATH")
    create_sub.add_argument("--alias", default="enigma")
    create_sub.add_argument("--validity", type=int, default=10000, metavar="DAYS")
    create_sub.add_argument("--dname", default="", metavar="DN")
    create_sub.add_argument("--no-save-password", action="store_true")
    create_sub.add_argument("--write-properties", action="store_true",
                            help="also write a placeholder gen/android/keystore.properties")
    create_sub.add_argument("--yes", action="store_true")
    pin_sub = android_sub.add_parser(
        "pin",
        help="record the release-key fingerprint the build must match",
        parents=[common],
    )
    pin_sub.add_argument("--from", dest="source", metavar="ARTIFACT", required=True)
    pin_sub.add_argument("--rotate", action="store_true")
    pin_sub.add_argument("--yes", action="store_true")

    config_p = sub.add_parser(
        "config",
        help="open the Config Builder: define the product, save a versioned "
        "product-config file",
        parents=[common],
    )
    config_p.add_argument("file", nargs="?", metavar="PRODUCT_YAML",
                          help="a product config to open")

    build_p = sub.add_parser(
        "build", help="build the app — `build android [...]` or `build <product.yaml>`",
        parents=[common],
    )
    build_sub = build_p.add_subparsers(dest="platform", required=True)
    product_build = build_sub.add_parser(
        "product", help="build from a saved product config", parents=[common]
    )
    product_build.add_argument("config", metavar="PRODUCT_YAML")
    product_build.add_argument(
        "--platform", dest="target_platform", default="desktop",
        choices=("desktop", "android", "both"),
    )
    pkind = product_build.add_mutually_exclusive_group()
    pkind.add_argument("--release", action="store_true")
    pkind.add_argument("--debug", action="store_true")
    product_build.add_argument("--unsigned", action="store_true")
    product_build.add_argument("--abi", default="aarch64", metavar="SPEC")
    product_build.add_argument("--gui", action="store_true",
                               help="open the Builder window instead of running headlessly")
    android_build = build_sub.add_parser(
        "android", help="build the Android app via scripts/build_android.sh",
        parents=[common],
    )
    kind = android_build.add_mutually_exclusive_group()
    kind.add_argument("--release", action="store_true", help="release build")
    kind.add_argument("--debug", action="store_true", help="debug build (default)")
    mode = android_build.add_mutually_exclusive_group()
    mode.add_argument(
        "--signed", action="store_true",
        help="require a signed release (the default for --release)",
    )
    mode.add_argument(
        "--unsigned", action="store_true",
        help="explicitly build an UNSIGNED release (installs nowhere; internal only)",
    )
    android_build.add_argument(
        "--abi", default="aarch64", metavar="SPEC",
        help="comma-separated ABIs or 'all' (default aarch64)",
    )

    args = parser.parse_args(argv)
    # SUPPRESS means the attribute may be absent entirely; normalize it.
    if not hasattr(args, "repo"):
        args.repo = None
    return args


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


def resolve_repo(override: Path | None) -> str:
    """Point `paths` at the right checkout for a headless command.

    Resolution order matches the GUI: --repo, then the remembered QSettings
    choice, then whatever import-time detection found ($ENIGMA_REPO or a
    search upward). Returns a provenance string for the report line. Needs a
    QCoreApplication only because QSettings resolves its file through the
    application identity — no window is ever created.
    """
    from PyQt6.QtCore import QCoreApplication, QSettings

    if QCoreApplication.instance() is None:
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
    return source


def run_check(override: Path | None) -> int:
    """Report which checkout would be used, and whether it is complete."""
    source = resolve_repo(override)

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


def run_signing(args: argparse.Namespace, override: Path | None) -> int:
    """Dispatch `signing android <action>` — headless, no window."""
    resolve_repo(override)
    if not paths.have_repo():
        print("repository: none found — pass --repo or set "
              f"${paths.ROOT_ENV_VAR}", file=sys.stderr)
        return 1

    import signing_cli

    if args.action == "status":
        return signing_cli.status(paths.ANDROID_GEN)
    if args.action == "verify":
        target = Path(args.artifact).expanduser() if args.artifact else paths.ANDROID_GEN
        return signing_cli.verify(
            target, "release", args.allow_unsigned, paths.ANDROID_PIN
        )
    if args.action == "create":
        import identity as identity_mod

        product = identity_mod.disk_identity().name or "Enigma"
        return signing_cli.create(
            Path(args.keystore).expanduser() if args.keystore else None,
            args.alias,
            args.dname or f"CN={product} Release, O={product}",
            validity_days=args.validity,
            assume_yes=args.yes,
            save_password=not args.no_save_password,
            write_properties_into=paths.ANDROID_GEN if args.write_properties else None,
            forbidden_root=paths.REPO_ROOT,
        )
    if args.action == "pin":
        return signing_cli.pin_action(
            paths.ANDROID_PIN, Path(args.source).expanduser(), args.rotate, args.yes
        )
    return 2


def run_build(args: argparse.Namespace, override: Path | None) -> int:
    """Dispatch `build android` — the same argv the GUI's Build tab launches."""
    import subprocess

    resolve_repo(override)
    if not paths.have_repo():
        print("repository: none found — pass --repo or set "
              f"${paths.ROOT_ENV_VAR}", file=sys.stderr)
        return 1

    build_type = "release" if args.release else "debug"
    if args.unsigned and build_type != "release":
        print("--unsigned only applies to --release "
              "(debug builds always use the SDK debug key)", file=sys.stderr)
        return 2
    if args.signed and build_type != "release":
        print("--signed only applies to --release "
              "(debug builds always use the SDK debug key)", file=sys.stderr)
        return 2

    import buildcmd

    command = buildcmd.android(
        paths.APP_SLUG, build_type, args.abi, allow_unsigned=args.unsigned
    )
    print("$", " ".join(command))
    # Stream straight through: this IS the build, minutes of cargo and gradle.
    return subprocess.run(command, cwd=paths.REPO_ROOT).returncode


def run_config_gui(args: argparse.Namespace, override: Path | None) -> int:
    from PyQt6.QtWidgets import QApplication

    from window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName(paths.APP_NAME)
    app.setOrganizationName(paths.ORG_NAME)
    app.setStyle("Fusion")
    resolve_repo(override)
    window = MainWindow(
        repo_override=override, mode="config",
        product_file=Path(args.file).expanduser() if args.file else None,
    )
    window.show()
    return app.exec()


def run_product_build(args: argparse.Namespace, override: Path | None) -> int:
    """`build <product.yaml>` — the Builder half, headless or GUI."""
    resolve_repo(override)
    if not paths.have_repo():
        print("repository: none found — pass --repo or set "
              f"${paths.ROOT_ENV_VAR}", file=sys.stderr)
        return 1
    product = Path(args.config).expanduser()
    if not product.is_file():
        print(f"{product} does not exist", file=sys.stderr)
        return 1

    if args.gui:
        from PyQt6.QtWidgets import QApplication

        from window import MainWindow

        app = QApplication.instance() or QApplication(sys.argv)
        app.setApplicationName(paths.APP_NAME)
        app.setOrganizationName(paths.ORG_NAME)
        app.setStyle("Fusion")
        window = MainWindow(mode="build", product_file=product)
        window.show()
        return app.exec()

    import buildcmd
    import productbuild

    build_type = "release" if args.release or not args.debug else "debug"
    return productbuild.run(
        product,
        platform=args.target_platform,
        build_type=build_type,
        abi_spec=args.abi,
        allow_unsigned=args.unsigned,
    )


def main(argv: list[str] | None = None) -> int:
    raw = list(argv if argv is not None else sys.argv[1:])
    # Sugar: `build <path.yaml>` reads as `build product <path.yaml>` — the
    # platform names stay reserved words, a config file is anything else.
    if len(raw) >= 2 and raw[0] == "build" and raw[1] not in (
        "android", "product", "-h", "--help"
    ) and not raw[1].startswith("-"):
        raw.insert(1, "product")
    args = parse_args(raw)
    override = resolve_override(args.repo)

    if args.check:
        return run_check(override)
    if args.command == "signing":
        return run_signing(args, override)
    if args.command == "build":
        if args.platform == "product":
            return run_product_build(args, override)
        return run_build(args, override)
    if args.command == "config":
        return run_config_gui(args, override)

    # Bare launch = the Config Builder. The old combined window is gone: the
    # split IS the tool now, and building goes through a saved product config
    # ("Build this config…", or `enigma-builder build <file>`).
    class _Bare:
        file = None
        repo = args.repo

    return run_config_gui(_Bare(), override)


if __name__ == "__main__":
    raise SystemExit(main())
