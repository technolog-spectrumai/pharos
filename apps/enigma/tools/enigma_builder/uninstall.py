"""Removing the system-installed desktop package. Linux only.

Installing a built .deb/.rpm is something the user does outside the Builder,
but getting rid of it again means remembering which package manager took it
and what the package ended up being called — Tauri derives the package name
from ``productName`` (kebab-cased), which is not necessarily what anyone
typed. This module answers both questions read-only: it queries dpkg and rpm
for a handful of plausible names and reports what is actually installed.

The removal itself runs through ``pkexec`` so the polkit agent asks for the
password instead of the Builder ever seeing it. Only the package is removed;
app data under ``~/.local/share/<identifier>`` is the reset button's job and
is deliberately not touched here — a reinstall finds the old vault again,
exactly like an upgrade would.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from dataclasses import dataclass

import bundles
import paths


@dataclass(frozen=True)
class Installed:
    kind: str  # "deb" | "rpm"
    package: str
    version: str


def supported() -> bool:
    """The whole feature is Linux-only, like the packages it removes."""
    return sys.platform.startswith("linux")


def kebab(name: str) -> str:
    """Tauri's package naming, near enough: ``My App`` / ``MyApp`` → ``my-app``."""
    name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", name.strip())
    name = re.sub(r"[^A-Za-z0-9]+", "-", name)
    return name.strip("-").lower()


def candidates(product_name: str) -> list[str]:
    """Package names worth asking the package managers about, best guess first.

    Guessing wrong is harmless — a name is only ever *queried*, never removed
    unless the query says it is installed — so this casts a slightly wider net
    than Tauri's exact transform.
    """
    names = [kebab(product_name), product_name.strip().lower(),
             product_name.strip(), paths.APP_SLUG]
    unique: list[str] = []
    for name in names:
        if name and name not in unique:
            unique.append(name)
    return unique


def _run(command: list[str]) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None


def _deb_installed(package: str) -> str | None:
    """Installed version per dpkg, or None.

    dpkg-query also answers for packages that were removed with their config
    files left behind, so the status field is checked, not just the exit code.
    """
    dpkg_query = shutil.which("dpkg-query")
    if not dpkg_query:
        return None
    result = _run(
        [dpkg_query, "-W", "-f", "${db:Status-Status}\t${Version}", package]
    )
    if result is None or result.returncode != 0:
        return None
    status, _, version = result.stdout.partition("\t")
    return version.strip() if status.strip() == "installed" else None


def _rpm_installed(package: str) -> str | None:
    rpm = shutil.which("rpm")
    if not rpm:
        return None
    result = _run([rpm, "-q", "--qf", "%{VERSION}-%{RELEASE}", package])
    if result is None or result.returncode != 0:
        return None
    return result.stdout.strip() or None


def installed_package(product_name: str) -> Installed | None:
    """What is actually installed on this machine, or None.

    Both package databases are consulted — the host family only decides which
    is asked first — because nothing stops an rpm-based host from having a
    dpkg around, and the answer comes from whichever database says yes.
    """
    checks = [("deb", _deb_installed), ("rpm", _rpm_installed)]
    host_key, _pretty = bundles.host_distro()
    if host_key == "fedora":
        checks.reverse()
    for name in candidates(product_name):
        for kind, check in checks:
            version = check(name)
            if version:
                return Installed(kind, name, version)
    return None


def remove_command(kind: str, package: str) -> list[str] | None:
    """The full removal command, or None when pkexec is not available.

    The distro's own manager is preferred over the low-level tool so that
    dependency bookkeeping stays consistent; absolute paths throughout, both
    for pkexec's restricted PATH and so the log line shows exactly what ran.
    """
    pkexec = shutil.which("pkexec")
    if not pkexec:
        return None
    if kind == "deb":
        manager = shutil.which("apt-get")
        if manager:
            return [pkexec, manager, "remove", "-y", package]
        return [pkexec, shutil.which("dpkg") or "dpkg", "-r", package]
    manager = shutil.which("dnf")
    if manager:
        return [pkexec, manager, "remove", "-y", package]
    return [pkexec, shutil.which("rpm") or "rpm", "-e", package]


def manual_hint(kind: str, package: str) -> str:
    """What to type yourself, for the error path when pkexec is missing."""
    if kind == "deb":
        return f"sudo apt-get remove {package}"
    return f"sudo dnf remove {package}"
