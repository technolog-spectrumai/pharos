"""Which Linux distribution the desktop build is packaged for.

`tauri.conf.json` ships `"targets": "all"`, which on Linux means .deb,
.AppImage and .rpm every time. Narrowing that is a config edit rather than a
command-line flag because the Builder drives the repo's own scripts, and both
`build_desktop.sh` and `deploy/build.sh` call a bare `npx tauri build` — a
config change reaches every path without touching either script. The edit is
applied at build time and the whole file restored afterwards, exactly like the
app identity.

**This selects a package format, not a build environment.** Tauri bundles
whatever the host just compiled, so an .rpm produced on Ubuntu is linked against
Ubuntu's glibc and webkit2gtk and will very likely refuse to run on Fedora.
Producing a package that genuinely works on another distribution means building
inside it — a container or VM of that distribution. :func:`host_distro` and
:func:`cross_build_warning` exist so the GUI can say so instead of implying
otherwise.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

#: (key, Tauri bundle id, menu label, artifact glob, /etc/os-release ID match)
DISTROS: tuple[tuple[str, str, str, str, tuple[str, ...]], ...] = (
    (
        "ubuntu",
        "deb",
        "Ubuntu / Debian  (.deb)",
        "*.deb",
        ("ubuntu", "debian", "linuxmint", "pop", "elementary"),
    ),
    (
        "fedora",
        "rpm",
        "Fedora / RHEL  (.rpm)",
        "*.rpm",
        ("fedora", "rhel", "centos", "rocky", "almalinux", "opensuse"),
    ),
)

KEYS: tuple[str, ...] = tuple(key for key, *_rest in DISTROS)
DEFAULT: tuple[str, ...] = KEYS  # both, matching the repo's current output


def _row(key: str) -> tuple[str, str, str, str, tuple[str, ...]] | None:
    return next((row for row in DISTROS if row[0] == key), None)


def bundle_id(key: str) -> str:
    row = _row(key)
    return row[1] if row else key


def label(key: str) -> str:
    row = _row(key)
    return row[2] if row else key


def glob(key: str) -> str:
    row = _row(key)
    return row[3] if row else "*"


def globs(selected: list[str]) -> list[str]:
    """Artifact patterns for the chosen distributions."""
    return [glob(key) for key in KEYS if key in selected]


def to_config_value(selected: list[str]) -> list[str]:
    """The `bundle.targets` value for a selection, in a stable order."""
    return [bundle_id(key) for key in KEYS if key in selected]


def from_config_value(value: Any) -> list[str]:
    """Read `bundle.targets` back into distribution keys.

    ``"all"`` — the shipped value — covers every format, so it maps to
    everything the Builder offers.
    """
    if value == "all" or value is None:
        return list(DEFAULT)
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return list(DEFAULT)
    return [key for key in KEYS if bundle_id(key) in value]


def apply_to_config(conf: dict[str, Any], selected: list[str]) -> dict[str, Any]:
    """Return ``conf`` with `bundle.targets` narrowed to ``selected``."""
    bundle = conf.setdefault("bundle", {})
    bundle["targets"] = to_config_value(selected)
    return conf


def read_from_config(conf: dict[str, Any]) -> list[str]:
    bundle = conf.get("bundle")
    if not isinstance(bundle, dict):
        return list(DEFAULT)
    return from_config_value(bundle.get("targets"))


def host_distro() -> tuple[str | None, str]:
    """(matching key, pretty name) for the machine we are building on.

    The key is None when the host is not one of the offered distributions, or
    could not be identified — in which case every package is a cross build.
    """
    fields: dict[str, str] = {}
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if value:
                fields[name] = value.strip().strip('"')
    except OSError:
        return None, "unknown Linux"

    pretty = fields.get("PRETTY_NAME") or fields.get("NAME") or "unknown Linux"
    ids = [fields.get("ID", "")] + fields.get("ID_LIKE", "").split()
    ids = [i for i in ids if i]

    for key, _bundle, _label, _glob, matches in DISTROS:
        if any(i in matches for i in ids):
            return key, pretty
    return None, pretty


def cross_build_warning(selected: list[str]) -> str:
    """The honest caveat for the current selection, or "" when there is none."""
    host_key, pretty = host_distro()
    foreign = [key for key in selected if key != host_key]
    if not foreign:
        return ""
    names = " and ".join(label(key).split("  ")[0] for key in foreign)
    return (
        f"You are building on {pretty}. The {names} package will be linked "
        f"against this system's glibc and webkit2gtk, so it is unlikely to run "
        f"on a real target. For a package that works, run the build inside a "
        f"container or VM of that distribution."
    )
