"""Curated icon sets: the only app icons a build engineer may choose from.

The Builder used to take any file on disk. That made the icon the one part of a
product config nobody could review — a screenshot, a wrong-sized JPEG or a
half-finished draft would sail into a signed release, and the product file
recorded a path that meant nothing on another machine.

So the choice is now closed: an icon set is a directory under ``assets/icons/``
that ships *with the Builder*, and the GUI offers exactly those. Adding one is a
deliberate act — write the directory, commit it, rebuild the binary — which is
the point. ``icons.md`` at the repo root documents the format for set authors.

A set is::

    assets/icons/<id>/
        icon.png     the master square source `tauri icon` consumes
        set.json     {"name", "description", "author", "version"}

The directory name is the id, and it is what a product config stores in
``branding.icon`` — an id survives being opened on another machine, an absolute
path does not.

Discovery never raises. A set with no metadata, no master image or an image
Tauri would choke on comes back as an :class:`IconSet` carrying ``problems``;
the GUI lists it as unavailable and says why, instead of vanishing it or dying
at import. Validation of the image itself is :func:`icons.validate_source` — the
same rules the build enforces, not a second copy that can drift.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import icons as icons_mod

#: Metadata file every set must carry.
METADATA_NAME = "set.json"

#: Master image, in preference order. PNG is the norm; SVG is accepted because
#: `tauri icon` accepts it, and validate_source cannot measure it.
MASTER_NAMES = ("icon.png", "icon.svg")

#: Points the Builder at a different directory of sets — for tests, and for
#: running a checkout's sets against an installed binary.
SETS_ENV_VAR = "ENIGMA_BUILDER_ICON_SETS"

#: Highest ``set.json`` version this Builder understands.
SCHEMA_VERSION = 1


@dataclass(frozen=True)
class IconSet:
    """One directory under ``assets/icons/``, valid or not."""

    id: str
    path: Path
    name: str
    description: str
    author: str
    version: int
    master: Path | None
    problems: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        """True when this set can actually be built with."""
        return not self.problems and self.master is not None

    @property
    def credit(self) -> str:
        """``by <author>`` when there is one — for the chooser's caption."""
        return f"by {self.author}" if self.author else ""

    def __str__(self) -> str:  # pragma: no cover — diagnostics only
        return f"{self.name} ({self.id})"


# ----- where the sets live --------------------------------------------------


def _program_dir() -> Path:
    """Directory holding the running program's own files, frozen or not.

    PyInstaller's one-file build unpacks ``--add-data`` into ``sys._MEIPASS``,
    which is NOT where ``paths._bundle_dir()`` points (that is the directory the
    executable sits in, deliberately, because it resolves the *repo*). Assets
    ride inside the binary, so they need the extraction directory instead.
    """
    if getattr(sys, "frozen", False):
        unpacked = getattr(sys, "_MEIPASS", "")
        if unpacked:
            return Path(unpacked)
    return Path(__file__).resolve().parent


def search_roots() -> list[Path]:
    """Every directory that could hold icon sets, most deliberate first.

    The env override REPLACES the search rather than heading it: someone who
    names a sets directory that turns out to be empty or absent wants to be
    told so, not quietly handed the built-in sets under the same names.
    """
    override = os.environ.get(SETS_ENV_VAR, "").strip()
    if override:
        return [Path(override).expanduser()]

    roots: list[Path] = [_program_dir() / "assets" / "icons"]
    if getattr(sys, "frozen", False):
        # A sets directory dropped beside the binary, for an engineer who wants
        # one more set without rebuilding the executable.
        roots.append(Path(sys.executable).resolve().parent / "assets" / "icons")
    return roots


def sets_dir() -> Path:
    """The directory sets are read from.

    Returns the first candidate that exists; when none does, the first one
    anyway, so callers have a real path to name in "no icon sets found in …".
    """
    candidates = search_roots()
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return candidates[0]


# ----- reading one set ------------------------------------------------------


def _read_metadata(directory: Path) -> tuple[dict, list[str]]:
    metadata = directory / METADATA_NAME
    if not metadata.is_file():
        return {}, [f"{METADATA_NAME} is missing"]
    try:
        data = json.loads(metadata.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as exc:
        return {}, [f"{METADATA_NAME} could not be read ({exc})"]
    except json.JSONDecodeError as exc:
        return {}, [f"{METADATA_NAME} is not valid JSON (line {exc.lineno})"]
    if not isinstance(data, dict):
        return {}, [f"{METADATA_NAME} must contain a JSON object"]
    return data, []


def _find_master(directory: Path) -> Path | None:
    for name in MASTER_NAMES:
        candidate = directory / name
        if candidate.is_file():
            return candidate
    return None


def read_set(directory: Path) -> IconSet:
    """Describe one set directory. Never raises — problems come back in the set."""
    directory = Path(directory)
    set_id = directory.name
    problems: list[str] = []
    warnings: list[str] = []

    if not directory.is_dir():
        return IconSet(
            id=set_id, path=directory, name=set_id, description="", author="",
            version=0, master=None, problems=("the set directory is missing",),
        )

    data, metadata_problems = _read_metadata(directory)
    problems.extend(metadata_problems)

    name = str(data.get("name") or "").strip()
    if not name:
        if not metadata_problems:
            problems.append(f'{METADATA_NAME} has no "name"')
        name = set_id

    version = data.get("version", 1)
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        problems.append(f'{METADATA_NAME} "version" must be a positive integer')
        version = 0
    elif version > SCHEMA_VERSION:
        problems.append(
            f"{METADATA_NAME} is version {version}; this Builder understands "
            f"up to {SCHEMA_VERSION}"
        )

    master = _find_master(directory)
    if master is None:
        problems.append(
            "no master image — expected " + " or ".join(MASTER_NAMES)
        )
    else:
        # One rule set for the image, shared with the build step.
        errors, image_warnings = icons_mod.validate_source(master)
        problems.extend(errors)
        warnings.extend(image_warnings)

    return IconSet(
        id=set_id,
        path=directory,
        name=name,
        description=str(data.get("description") or "").strip(),
        author=str(data.get("author") or "").strip(),
        version=version,
        master=master,
        problems=tuple(problems),
        warnings=tuple(warnings),
    )


# ----- discovery ------------------------------------------------------------


def available_sets() -> list[IconSet]:
    """Every set directory found, broken ones included, sorted for display.

    Sorted by display name so the chooser is stable across machines; the id
    breaks ties, because two sets may legitimately share a name.
    """
    root = sets_dir()
    if not root.is_dir():
        return []
    found = [
        read_set(child)
        for child in root.iterdir()
        if child.is_dir() and not child.name.startswith((".", "_"))
    ]
    return sorted(found, key=lambda s: (s.name.casefold(), s.id))


def usable_sets() -> list[IconSet]:
    """The subset a build can actually use."""
    return [icon_set for icon_set in available_sets() if icon_set.ok]


def broken_sets() -> list[IconSet]:
    """The rest — what the GUI reports instead of silently hiding."""
    return [icon_set for icon_set in available_sets() if not icon_set.ok]


def load_set(set_id: str) -> IconSet | None:
    """One set by id, or None when there is no such directory.

    A set that exists but is broken comes back *with* its problems, so a caller
    that was handed a stale id from a product config can say what is wrong with
    it rather than "not found".
    """
    set_id = str(set_id).strip()
    # Never let a product config address something outside the sets directory.
    if not set_id or set_id in (".", "..") or "/" in set_id or "\\" in set_id:
        return None
    directory = sets_dir() / set_id
    if not directory.is_dir():
        return None
    return read_set(directory)


def problem_report() -> list[str]:
    """One line per unusable set — what the GUI shows under the chooser."""
    return [
        f"{icon_set.id}: {'; '.join(icon_set.problems)}"
        for icon_set in broken_sets()
    ]
