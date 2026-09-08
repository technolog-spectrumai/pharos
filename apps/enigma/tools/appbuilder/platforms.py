"""Which packages this host can actually produce, and which it cannot.

`bundles.py` came from enigma's builder and knows two Linux formats, because
that is what enigma ships. These three apps are meant to be multiplatform, so
this adds macOS and Windows — and, more usefully, is honest about the fact that
**Tauri does not cross-compile**.

That is the whole point of this module. A build UI that lists .dmg on a Linux
box and then fails four minutes into a cargo run has told the user nothing;
worse is one that "succeeds" and produces a Linux binary with a .dmg name. Each
target below says which hosts can build it, the GUI greys out the rest, and the
CLI refuses with a sentence explaining why rather than a linker error.

`bundles.py` is deliberately left alone: enigma's builder reads its exact
tuple shape, and widening a table two tools share is how one of them breaks.
"""

from __future__ import annotations

import platform
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Target:
    key: str
    """Tauri's bundle identifier, passed to `tauri build --bundles`."""

    label: str
    """What the menu shows."""

    hosts: tuple[str, ...]
    """`sys.platform` values that can build it. Tauri compiles for the machine
    it runs on, so this is a hard constraint, not a preference."""

    glob: str
    """How to find the artefact afterwards."""

    note: str = ""
    """Anything the user should know before choosing it."""

    def buildable_here(self) -> bool:
        return sys.platform in self.hosts


TARGETS: tuple[Target, ...] = (
    Target("deb", "Debian / Ubuntu  (.deb)", ("linux",), "*.deb"),
    Target("rpm", "Fedora / RHEL  (.rpm)", ("linux",), "*.rpm"),
    Target(
        "appimage",
        "Any Linux  (.AppImage)",
        ("linux",),
        "*.AppImage",
        "Portable, but still linked against this system's glibc and webkit2gtk.",
    ),
    Target(
        "dmg",
        "macOS  (.dmg)",
        ("darwin",),
        "*.dmg",
        "Needs a Mac. Tauri cannot cross-compile to macOS.",
    ),
    Target(
        "app",
        "macOS bundle  (.app)",
        ("darwin",),
        "*.app",
        "Needs a Mac.",
    ),
    Target(
        "msi",
        "Windows installer  (.msi)",
        ("win32",),
        "*.msi",
        "Needs Windows. Tauri cannot cross-compile to Windows.",
    ),
    Target(
        "nsis",
        "Windows setup  (.exe)",
        ("win32",),
        "*.exe",
        "Needs Windows.",
    ),
)


def by_key(key: str) -> Target | None:
    return next((t for t in TARGETS if t.key == key), None)


def buildable_here() -> tuple[Target, ...]:
    """Targets this machine can genuinely produce."""
    return tuple(t for t in TARGETS if t.buildable_here())


def defaults_here() -> tuple[str, ...]:
    """What to select when nothing is remembered: everything this host can do."""
    return tuple(t.key for t in buildable_here())


def host_label() -> str:
    """A human name for the machine, for the 'building on…' line."""
    system = {"linux": "Linux", "darwin": "macOS", "win32": "Windows"}.get(
        sys.platform, sys.platform)
    release = platform.mac_ver()[0] if sys.platform == "darwin" else platform.release()
    machine = platform.machine()
    return f"{system} {release} ({machine})".replace("  ", " ").strip()


def refuse(key: str) -> str:
    """Why this target cannot be built here, or "" if it can.

    A sentence rather than a boolean, because the caller shows it to a person.
    """
    target = by_key(key)
    if target is None:
        known = ", ".join(t.key for t in TARGETS)
        return f"unknown target {key!r} — known targets are {known}"
    if target.buildable_here():
        return ""
    wanted = {"linux": "Linux", "darwin": "macOS", "win32": "Windows"}
    needs = " or ".join(wanted.get(h, h) for h in target.hosts)
    return (
        f"{target.label} has to be built on {needs}; this is {host_label()}. "
        f"Tauri compiles for the machine it runs on — there is no cross-compile "
        f"for desktop targets, so this would fail rather than produce a package."
    )
