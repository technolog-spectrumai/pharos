"""Reading and rewriting the app identity in ``tauri.conf.json``.

``build.rs`` asserts that ``app.{name,identifier,version}`` in the build config
equals ``productName`` / ``identifier`` / ``version`` here, and tauri.conf.json
stays authoritative for the native bundle. The product identity is fixed:
``Enigma26`` / ``com.spectrumaipl.enigma26``. The Builder does not offer custom
names or identifiers, because Android installs by Gradle's ``applicationId`` and
a cosmetic Tauri identifier change would be a trap.

The file is machine-format JSON (2-space indent, no comments), so a
``json.loads`` → ``json.dumps(indent=2)`` round-trip is byte-identical; that is
pinned by ``tests/test_identity.py``. Writes happen at build time only, so
experimenting in the form never dirties the working tree.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from typing import Any

import paths

# tauri.conf.json key -> build config app.* field.
CONF_KEYS = (("productName", "name"), ("identifier", "identifier"), ("version", "version"))
FIXED_APP_NAME = "Enigma26"
FIXED_APP_IDENTIFIER = "com.spectrumaipl.enigma26"
ANDROID_APPLICATION_ID_RE = re.compile(r'^\s*applicationId\s*=\s*"([^"]+)"', re.MULTILINE)


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


def read_conf_text() -> str:
    """The file verbatim, for an exact restore after the build."""
    try:
        return paths.TAURI_CONF.read_text(encoding="utf-8")
    except OSError:
        return ""


def write_conf_text(text: str) -> None:
    paths.TAURI_CONF.write_text(text, encoding="utf-8")


def read_conf() -> dict[str, Any]:
    """Parse tauri.conf.json; {} if it is missing or not valid JSON."""
    try:
        return json.loads(paths.TAURI_CONF.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def render_conf(conf: dict[str, Any]) -> str:
    return json.dumps(conf, indent=2, ensure_ascii=False) + "\n"


def apply_identity(conf: dict[str, Any], identity: "Identity") -> dict[str, Any]:
    """Return ``conf`` with the three identity fields set."""
    conf.update(locked_identity(identity).as_conf_fields())
    return conf


def write_identity(identity: Identity) -> bool:
    """Apply ``identity`` to tauri.conf.json. False if nothing changed."""
    conf = read_conf()
    if not conf:
        raise OSError(f"cannot read {paths.TAURI_CONF}")
    fields = locked_identity(identity).as_conf_fields()
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


def android_application_id(gradle_file=None) -> str | None:
    """The package id Android will install, from generated Gradle.

    ``tauri.conf.json`` can say one identifier while an already initialized
    Android project still builds another. Android sees the Gradle
    ``applicationId``; when it is present, the Builder checks it against the
    fixed product identifier.
    """
    path = gradle_file or paths.ANDROID_GEN / "app" / "build.gradle.kts"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    match = ANDROID_APPLICATION_ID_RE.search(text)
    return match.group(1) if match else None


def locked_identity(identity: Identity) -> Identity:
    """Force non-version identity fields to the one real product identity."""
    return Identity(FIXED_APP_NAME, FIXED_APP_IDENTIFIER, identity.version)


def conf_pending_diff(current: Identity, pending: Identity) -> list[str]:
    """Human-readable ``key: old → new`` lines for the fields that differ."""
    lines = []
    old = current.as_conf_fields()
    new = pending.as_conf_fields()
    for key, _field in CONF_KEYS:
        if old[key] != new[key]:
            lines.append(f"{key}: {old[key] or '(empty)'} → {new[key] or '(empty)'}")
    return lines
