"""Assembling build-script argv — ONE place, shared by the GUI and the CLI.

The Build tab and `enigma-builder build android` must launch byte-identical
commands for identical options; the moment each assembles its own list, the
GUI and the CLI drift (a flag added to one, forgotten in the other) and the
drift is invisible until someone diffs two build logs.
"""

from __future__ import annotations

import paths


def android(
    app_slug: str,
    build_type: str,
    abi_spec: str,
    *,
    allow_unsigned: bool = False,
) -> list[str]:
    """The scripts/build_android.sh invocation for one Android build.

    ``allow_unsigned`` is release-only by construction — the script enforces
    it too, but failing here keeps a GUI bug from ever reaching a subprocess.
    """
    if build_type not in ("debug", "release"):
        raise ValueError(f"build_type must be debug or release, not {build_type!r}")
    if allow_unsigned and build_type != "release":
        raise ValueError("--allow-unsigned-release only applies to a release build")

    command = ["bash", str(paths.BUILD_ANDROID_SH), app_slug, build_type, abi_spec]
    if allow_unsigned:
        command.append("--allow-unsigned-release")
    return command
