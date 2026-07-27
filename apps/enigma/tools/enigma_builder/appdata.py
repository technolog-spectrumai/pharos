"""The built app's local data — where it lives, and clearing it for a fresh run.

A rebuild cannot start fresh on its own. Enigma stores everything under Tauri's
`app_data_dir()`, which on Linux is ``$XDG_DATA_HOME/<identifier>`` (default
``~/.local/share/<identifier>``), keyed on the bundle identifier from
tauri.conf.json — not on anything inside the build. So a new binary finds the
previous ``profiles/<name>/vault.json``, protasius reports the vault as already
set up, and the app opens the unlock gate instead of first-run passphrase setup.

Clearing that directory is the only way to get a true first run, and it destroys
real user data — vault, rooms, chat history, transferred files, map regions. Every
path here is therefore derived, guarded, and measured before anything is removed.
"""

from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

#: Everything the app writes lives under this, per profile.
PROFILES_SUBDIR = "profiles"
VAULT_FILE = "vault.json"


def data_homes() -> list[Path]:
    """Every XDG data root the app could plausibly be using, best guess first.

    Both are checked because ``XDG_DATA_HOME`` is not reliably the app's: a
    Builder launched from a sandboxed editor (VS Code's snap, for instance) sees
    the *editor's* ``~/snap/code/<rev>/.local/share`` and would look right past
    the real data in ``~/.local/share``. Scanning both finds the app's data
    whichever session started it, and costs one extra stat.
    """
    homes: list[Path] = []
    override = os.environ.get("XDG_DATA_HOME", "").strip()
    if override:
        homes.append(Path(override).expanduser())
    default = Path.home() / ".local" / "share"
    if default not in homes:
        homes.append(default)
    return homes


def valid_identifier(identifier: str) -> str | None:
    """``identifier`` if it is safe to build a deletable path from, else None.

    A blank or path-like identifier would make the delete guard meaningless, so
    it is rejected rather than sanitised into something plausible.
    """
    identifier = identifier.strip()
    if not identifier or "/" in identifier or identifier in (".", ".."):
        return None
    return identifier


def candidate_roots(identifier: str) -> list[Path]:
    """Every app-data directory ``identifier`` might occupy."""
    identifier = valid_identifier(identifier) or ""
    if not identifier:
        return []
    return [home / identifier for home in data_homes()]


def existing_roots(identifier: str) -> list[Path]:
    return [root for root in candidate_roots(identifier) if root.is_dir()]


def data_root(identifier: str) -> Path | None:
    """The app-data directory in use, or the most likely one if none exists yet."""
    roots = candidate_roots(identifier)
    if not roots:
        return None
    for root in roots:
        if root.is_dir():
            return root
    return roots[0]


def dir_size(path: Path) -> int:
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file() and not child.is_symlink():
                total += child.stat().st_size
        except OSError:
            continue
    return total


@dataclass(frozen=True)
class Target:
    """Something the user can clear, with enough detail to decide."""

    key: str          # "" for the whole root, otherwise the profile name
    label: str
    path: Path
    size: int
    has_vault: bool

    @property
    def exists(self) -> bool:
        return self.path.is_dir()


def _human(size: int) -> str:
    for unit, step in (("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)):
        if size >= step:
            return f"{size / step:.1f} {unit}"
    return f"{size} B"


def human_size(size: int) -> str:
    return _human(size)


def profile_names(identifier: str, root: Path | None = None) -> list[str]:
    """Profiles under ``root``, or across every existing root when omitted."""
    roots = [root] if root is not None else existing_roots(identifier)
    names: set[str] = set()
    for candidate in roots:
        directory = candidate / PROFILES_SUBDIR
        if directory.is_dir():
            names.update(
                p.name
                for p in directory.iterdir()
                # Skip what a previous clear moved aside — it is not a profile
                # the app will ever load, and offering to clear it again reads
                # as though the first clear had not worked.
                if p.is_dir() and ".cleared-" not in p.name
            )
    return sorted(names)


def has_vault(identifier: str, profile: str) -> bool:
    """Whether the next launch of ``profile`` will ask to unlock rather than set up."""
    return any(
        (root / PROFILES_SUBDIR / profile / VAULT_FILE).is_file()
        for root in existing_roots(identifier)
    )


def targets(identifier: str) -> list[Target]:
    """Everything clearable: per root, the whole thing and then each profile."""
    roots = existing_roots(identifier)
    show_path = len(roots) > 1

    found: list[Target] = []
    for root in roots:
        names = profile_names(identifier, root)
        suffix = f"  [{root}]" if show_path else ""
        found.append(
            Target(
                key=str(root),
                label=f"Everything (all profiles, caches and keys){suffix}",
                path=root,
                size=dir_size(root),
                has_vault=any(
                    (root / PROFILES_SUBDIR / n / VAULT_FILE).is_file() for n in names
                ),
            )
        )
        for name in names:
            path = root / PROFILES_SUBDIR / name
            found.append(
                Target(
                    key=str(path),
                    label=f"Profile “{name}” only{suffix}",
                    path=path,
                    size=dir_size(path),
                    has_vault=(path / VAULT_FILE).is_file(),
                )
            )
    return found


def is_safe_to_remove(identifier: str, path: Path) -> bool:
    """Guard every deletion: the path must sit inside one of this app's roots.

    Cheap to check and the only thing standing between a typo'd identifier and
    an rm -rf somewhere it does not belong. Symlinks are resolved first, so a
    link inside the root pointing elsewhere is refused.
    """
    roots = candidate_roots(identifier)
    if not roots:
        return False
    try:
        resolved = path.resolve()
    except OSError:
        return False
    for root in roots:
        try:
            root_resolved = root.resolve()
        except OSError:
            continue
        if resolved == root_resolved:
            return True
        if resolved.is_relative_to(root_resolved) and resolved != resolved.parent:
            return True
    return False


def remove(identifier: str, path: Path) -> Path:
    """Move ``path`` aside so the app starts fresh. Returns the new location.

    Deliberately a rename rather than an ``rmtree``: the app looks for its data
    at an exact path, so moving it is enough to force a genuine first run, and
    it leaves the vault, chat history and files recoverable if the button was
    pressed on the wrong profile. The rename is within the same parent, so it
    is atomic and cannot fail part-way across a device boundary.

    The caller is expected to tell the user where it went; nothing here deletes
    anything permanently.
    """
    if not is_safe_to_remove(identifier, path):
        raise ValueError(f"refusing to touch {path} — outside the app data root")
    if not path.is_dir():
        raise FileNotFoundError(f"{path} does not exist")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    aside = path.with_name(f"{path.name}.cleared-{stamp}")
    counter = 1
    while aside.exists():
        counter += 1
        aside = path.with_name(f"{path.name}.cleared-{stamp}-{counter}")

    path.rename(aside)
    return aside


def purge(identifier: str, path: Path) -> None:
    """Permanently delete a directory previously moved aside by :func:`remove`."""
    if not is_safe_to_remove(identifier, path):
        raise ValueError(f"refusing to delete {path} — outside the app data root")
    if ".cleared-" not in path.name:
        raise ValueError(f"refusing to delete {path} — not a cleared-aside directory")
    shutil.rmtree(path, ignore_errors=False)


def cleared_aside(identifier: str) -> list[Path]:
    """Directories a previous clear moved aside, oldest first."""
    found: list[Path] = []
    for home in data_homes():
        if not home.is_dir():
            continue
        try:
            found.extend(
                p
                for p in home.iterdir()
                if p.is_dir() and p.name.startswith(f"{identifier}.cleared-")
            )
        except OSError:
            continue
        for root in existing_roots(identifier):
            profiles = root / PROFILES_SUBDIR
            if profiles.is_dir():
                found.extend(
                    p for p in profiles.iterdir() if p.is_dir() and ".cleared-" in p.name
                )
    return sorted(set(found))


def summary(identifier: str, profile: str = "default") -> str:
    """One line for the GUI: what the next launch of this build will do."""
    if valid_identifier(identifier) is None:
        return "Set a valid bundle identifier to locate the app's data."
    roots = existing_roots(identifier)
    if not roots:
        candidates = candidate_roots(identifier)
        return (
            f"No data yet at {candidates[0]} — the next launch starts with "
            f"passphrase setup."
        )
    where = ", ".join(str(root) for root in roots)
    if has_vault(identifier, profile):
        return (
            f"A vault already exists for profile “{profile}” in {where}, so the "
            f"next launch asks for the existing passphrase rather than setting "
            f"a new one."
        )
    return (
        f"No vault for profile “{profile}” in {where} — the next launch starts "
        f"with passphrase setup."
    )
