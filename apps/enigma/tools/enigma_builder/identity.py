"""Reading and rewriting the app identity in ``tauri.conf.json``.

``build.rs`` asserts that ``app.{name,identifier,version}`` in the build config
equals ``productName`` / ``identifier`` / ``version`` here, and tauri.conf.json
stays authoritative for the native bundle. So changing the app's identity means
writing both files — this module owns the JSON half.

The file is machine-format JSON (2-space indent, no comments), so a
``json.loads`` → ``json.dumps(indent=2)`` round-trip is byte-identical; that is
pinned by ``tests/test_identity.py``. Writes happen at build time only, so
experimenting in the form never dirties the working tree.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Any

import paths

# tauri.conf.json key -> build config app.* field.
CONF_KEYS = (("productName", "name"), ("identifier", "identifier"), ("version", "version"))


@dataclass(frozen=True)
class Identity:
    name: str
    identifier: str
    version: str

    @classmethod
    def from_conf(cls, conf: dict[str, Any]) -> "Identity":
        return cls(
            name=str(conf.get("productName", "")),
            identifier=str(conf.get("identifier", "")),
            version=str(conf.get("version", "")),
        )

    def as_conf_fields(self) -> dict[str, str]:
        return {
            "productName": self.name,
            "identifier": self.identifier,
            "version": self.version,
        }

    def as_app_section(self) -> dict[str, str]:
        return {
            "name": self.name,
            "identifier": self.identifier,
            "version": self.version,
        }


def read_conf() -> dict[str, Any]:
    """Parse tauri.conf.json; {} if it is missing or not valid JSON."""
    try:
        return json.loads(paths.TAURI_CONF.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def render_conf(conf: dict[str, Any]) -> str:
    return json.dumps(conf, indent=2, ensure_ascii=False) + "\n"


def write_identity(identity: Identity) -> bool:
    """Apply ``identity`` to tauri.conf.json. False if nothing changed."""
    conf = read_conf()
    if not conf:
        raise OSError(f"cannot read {paths.TAURI_CONF}")
    fields = identity.as_conf_fields()
    if all(conf.get(key) == value for key, value in fields.items()):
        return False
    conf.update(fields)
    paths.TAURI_CONF.write_text(render_conf(conf), encoding="utf-8")
    return True


def disk_identity() -> Identity:
    return Identity.from_conf(read_conf())


def head_identity() -> Identity | None:
    """The committed identity, for the dirty banner and the restore button.

    Read-only (``git show``); None when git is unavailable or the file is not
    tracked, in which case the caller falls back to its launch-time snapshot.
    """
    rel = paths.TAURI_CONF.relative_to(paths.REPO_ROOT).as_posix()
    try:
        result = subprocess.run(
            ["git", "-C", str(paths.REPO_ROOT), "show", f"HEAD:{rel}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        return Identity.from_conf(json.loads(result.stdout))
    except json.JSONDecodeError:
        return None


def conf_pending_diff(current: Identity, pending: Identity) -> list[str]:
    """Human-readable ``key: old → new`` lines for the fields that differ."""
    lines = []
    old = current.as_conf_fields()
    new = pending.as_conf_fields()
    for key, _field in CONF_KEYS:
        if old[key] != new[key]:
            lines.append(f"{key}: {old[key] or '(empty)'} → {new[key] or '(empty)'}")
    return lines
