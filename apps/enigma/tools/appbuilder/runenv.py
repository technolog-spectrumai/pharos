"""A clean environment for launching the built app.

The Builder's own environment is frequently poisoned for a GTK/WebKit child:

- Launched from VS Code's snap, it inherits ``LD_LIBRARY_PATH`` and friends
  pointing into ``/snap/core20``, and the app dies at exec with
  ``symbol lookup error: __libc_pthread_init`` — observed, not hypothetical.
- The snap also exports its own ``XDG_DATA_HOME`` (``~/snap/code/<rev>/…``), so
  the app would read and write its vault inside the editor's sandbox instead of
  the real ``~/.local/share``.
- The frozen Builder (PyInstaller) prepends its bundle dir to
  ``LD_LIBRARY_PATH`` for its own Qt; the app must not load Qt's OpenSSL over
  the system one. PyInstaller saves the original as ``LD_LIBRARY_PATH_ORIG``.

The rule: path-list variables get their ``/snap/…`` and PyInstaller entries
filtered out (dropping the variable entirely if nothing survives), a sandboxed
``XDG_DATA_HOME`` is removed so the app falls back to the real default, and
everything else passes through untouched.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

#: Path-list variables snaps and PyInstaller are known to poison.
PATH_LISTS = (
    "LD_LIBRARY_PATH",
    "GTK_PATH",
    "GIO_MODULE_DIR",
    "GSETTINGS_SCHEMA_DIR",
    "XDG_DATA_DIRS",
    "FONTCONFIG_PATH",
    "LOCPATH",
)

#: Single-path variables that must not point into a snap.
SINGLE_PATHS = (
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
)


def _bundle_dir() -> str:
    """The PyInstaller extraction dir when frozen, else ''."""
    if getattr(sys, "frozen", False):
        return str(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return ""


def _poisoned(entry: str, bundle: str) -> bool:
    return "/snap/" in entry or (bool(bundle) and entry.startswith(bundle))


def clean_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """A copy of ``base`` (default ``os.environ``) safe to launch the app with."""
    env = dict(os.environ if base is None else base)
    bundle = _bundle_dir()

    # PyInstaller keeps the pre-frozen value; prefer it outright.
    if "LD_LIBRARY_PATH_ORIG" in env:
        env["LD_LIBRARY_PATH"] = env["LD_LIBRARY_PATH_ORIG"]

    for name in PATH_LISTS:
        value = env.get(name)
        if not value:
            continue
        kept = [e for e in value.split(os.pathsep) if e and not _poisoned(e, bundle)]
        if kept:
            env[name] = os.pathsep.join(kept)
        else:
            env.pop(name, None)

    for name in SINGLE_PATHS:
        value = env.get(name)
        if value and _poisoned(value, bundle):
            env.pop(name, None)

    # A sandboxed data home would put the vault inside the editor's snap; unset
    # so the app resolves the real ~/.local/share itself.
    data_home = env.get("XDG_DATA_HOME", "")
    if "/snap/" in data_home:
        env.pop("XDG_DATA_HOME", None)

    return env
