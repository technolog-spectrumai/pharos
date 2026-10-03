"""Assembling build argv — ONE place, shared by the GUI and the CLI.

The same rule enigma's `buildcmd.py` states, for the same reason: the moment
each surface assembles its own command list, they drift — a flag added to the
GUI and forgotten in the CLI — and the drift is invisible until someone diffs
two build logs.

Everything here DRIVES the app's own scripts rather than reimplementing them.
`apps/<app>/build.sh` is what a developer runs by hand and what CI would run;
a builder that shelled out to `npx tauri build` directly would be a second,
subtly different path to a bundle, and the two would disagree eventually.
"""

from __future__ import annotations

from pathlib import Path

from appspec import AppSpec


def desktop(app: AppSpec, *, debug: bool = False, run_tests: bool = True,
            frontend_only: bool = False,
            bundles: tuple[str, ...] | list[str] = ()) -> list[str]:
    """A desktop bundle, through the app's own build.sh.

    `bundles` names the package formats (deb, rpm, appimage, dmg, msi, nsis);
    empty means whatever tauri.conf.json already says, which is what a plain
    `./build.sh` has always produced. Nothing here checks that the host CAN
    build them — `platforms.refuse` does, and it is the caller's job to ask
    BEFORE starting a build that would take minutes to fail.
    """
    command = ["bash", str(app.build_sh)]
    if debug:
        command.append("--debug")
    if not run_tests:
        command.append("--no-test")
    if frontend_only:
        command.append("--frontend")
    if bundles:
        command.append(f"--bundles={','.join(bundles)}")
    return command


def dev(app: AppSpec, *, web_only: bool = False, reset: bool = False) -> list[str]:
    """Run the app in development."""
    command = ["bash", str(app.run_dev_sh)]
    if web_only:
        command.append("--web")
    if reset:
        command.append("--reset")
    return command


def android(app: AppSpec, *, build_type: str = "release",
            abi_spec: str = "aarch64") -> list[str]:
    """An Android build, through the repo's already-generic script.

    `scripts/build_android.sh <app> <type> <abi>` resolves `apps/<app>` itself
    and refuses a slug it cannot find, so nothing here needs to know which apps
    have an Android target — the script is the authority.
    """
    if build_type not in ("debug", "release"):
        raise ValueError(f"build_type must be debug or release, not {build_type!r}")
    script = app.root / "scripts" / "build_android.sh"
    return ["bash", str(script), app.slug, build_type, abi_spec]


def tests(app: AppSpec) -> list[str]:
    """This app's frontend suite, from the repo root through npm workspaces."""
    return ["npm", "run", "test", "-w", f"apps/{app.slug}"]


def typecheck(app: AppSpec) -> list[str]:
    return ["npm", "run", "typecheck", "-w", f"apps/{app.slug}"]


def rust_tests(app: AppSpec) -> list[str]:
    """The whole zinnia cargo workspace, not this app alone.

    `cargo test -p <app>` compiles only that crate and silently skips padova's
    `compile_fail` doctest — the one guarding "no command hands the passphrase
    back". The workspace run is the one that means something.
    """
    return ["cargo", "test", "--workspace"]


def artifacts(app: AppSpec, *, debug: bool = False) -> list[Path]:
    """Every bundle the last build produced, newest first."""
    root = app.debug_bundle_dir() if debug else app.bundle_dir
    if not root.is_dir():
        return []
    import platforms

    found = [
        p for target in platforms.TARGETS for p in root.rglob(target.glob)
    ]
    return sorted(found, key=lambda p: p.stat().st_mtime, reverse=True)
