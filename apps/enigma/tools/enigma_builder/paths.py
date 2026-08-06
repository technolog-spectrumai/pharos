"""Repository paths the Builder reads and writes.

The tool does not have to live inside the repo. It normally does — shipped at
``<repo>/tools/enigma_builder/`` — but it also runs as a standalone binary from
anywhere, so the repo root is *resolved* rather than assumed, and can be
repointed at runtime with :func:`set_repo_root`.

Every path below is a module global that ``set_repo_root`` rebinds. Import the
module (``import paths``) and read ``paths.CANONICAL_YAML`` at call time —
``from paths import CANONICAL_YAML`` would capture a stale value.

No Qt here: persistence of the chosen root belongs to the GUI layer.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "Enigma Builder"
ORG_NAME = "Enigma"

# The edition the Builder always writes and builds. Presets are value sources
# for the form, never build targets — see README.
CUSTOM_EDITION = "custom"
PRESETS = ("light", "plus", "pro")

# `deploy/build.sh` derives the app name from its own location; every other
# script takes it as the first positional argument.
APP_SLUG = "enigma"

# Relative to the repo root: the file whose presence identifies an Enigma
# checkout. Chosen because the Builder is useless without it.
MARKER = Path("apps/enigma/src-tauri/build_config.yaml")

# Env override, mostly for CI and for `cd`-less shell use.
ROOT_ENV_VAR = "ENIGMA_REPO"


def is_repo(root: Path) -> bool:
    """True if ``root`` looks like an Enigma checkout the Builder can drive."""
    return (root / MARKER).is_file()


def _bundle_dir() -> Path:
    """Directory the running program lives in, frozen or not."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def search_for_repo() -> Path | None:
    """Best guess at the repo root, or None if nothing plausible is nearby.

    Ordered by how deliberate each signal is: an explicit env var, then the
    in-repo install location, then wherever the user launched us from.
    """
    override = os.environ.get(ROOT_ENV_VAR, "").strip()
    if override:
        candidate = Path(override).expanduser().resolve()
        if is_repo(candidate):
            return candidate

    starts = [_bundle_dir(), Path.cwd().resolve()]
    for start in starts:
        for candidate in (start, *start.parents):
            if is_repo(candidate):
                return candidate
    return None


def set_repo_root(root: Path | None) -> Path | None:
    """Point every path in this module at ``root``. Returns the resolved root.

    ``None`` leaves the globals defined but pointing at a placeholder, so the
    GUI can start up and ask for a directory instead of failing to import.
    """
    global REPO_ROOT, APP_DIR, SRC_TAURI, CANONICAL_YAML, CONFIGS_DIR
    global CUSTOM_YAML, TAURI_CONF, BUILD_RS, CARGO_TOML, TARGET_DIR
    global ANDROID_GEN, ANDROID_OUTPUTS, BUILD_DESKTOP_SH, BUILD_ANDROID_SH
    global RESET_PROFILE_SH, DEPLOY_BUILD_SH, DEPLOY_DIST

    REPO_ROOT = Path(root).resolve() if root is not None else Path("/nonexistent")

    APP_DIR = REPO_ROOT / "apps" / "enigma"
    SRC_TAURI = APP_DIR / "src-tauri"

    CANONICAL_YAML = SRC_TAURI / "build_config.yaml"
    CONFIGS_DIR = SRC_TAURI / "configs"
    CUSTOM_YAML = CONFIGS_DIR / f"build_config.{CUSTOM_EDITION}.yaml"
    TAURI_CONF = SRC_TAURI / "tauri.conf.json"
    BUILD_RS = SRC_TAURI / "build.rs"
    CARGO_TOML = SRC_TAURI / "Cargo.toml"

    TARGET_DIR = SRC_TAURI / "target"
    ANDROID_GEN = SRC_TAURI / "gen" / "android"
    ANDROID_OUTPUTS = ANDROID_GEN / "app" / "build" / "outputs"

    BUILD_DESKTOP_SH = REPO_ROOT / "build_desktop.sh"
    BUILD_ANDROID_SH = REPO_ROOT / "scripts" / "build_android.sh"
    RESET_PROFILE_SH = REPO_ROOT / "scripts" / "reset_profile.sh"
    DEPLOY_BUILD_SH = APP_DIR / "deploy" / "build.sh"
    DEPLOY_DIST = APP_DIR / "deploy" / "dist"

    return REPO_ROOT if root is not None else None


def have_repo() -> bool:
    return is_repo(REPO_ROOT)


def preset_yaml(edition: str) -> Path:
    """Path of a checked-in edition config (``light`` / ``plus`` / ``pro``)."""
    return CONFIGS_DIR / f"build_config.{edition}.yaml"


def default_output_dir() -> Path:
    """Where built artifacts are collected unless the user picks elsewhere."""
    return DEPLOY_DIST


def app_binary(build_type: str) -> Path:
    """The executable cargo produces, for launching a test run."""
    return TARGET_DIR / build_type / APP_SLUG


def missing_repo_files() -> list[Path]:
    """Repo files the Builder cannot work without, that are not on disk.

    Surfaced once at startup rather than as a crash mid-build: a wrong repo
    root shows up here as a readable list.
    """
    required = (
        CANONICAL_YAML,
        TAURI_CONF,
        BUILD_RS,
        BUILD_DESKTOP_SH,
        BUILD_ANDROID_SH,
        DEPLOY_BUILD_SH,
        *(preset_yaml(e) for e in PRESETS),
    )
    return [p for p in required if not p.is_file()]


# Resolve at import so the ordinary in-repo case needs no configuration.
set_repo_root(search_for_repo())
