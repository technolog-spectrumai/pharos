"""Repository paths the Builder reads and writes.

Everything is derived from this file's own location: the tool lives at
``<repo>/tools/enigma_builder/``, so the repo root is two levels up. Nothing
here touches the filesystem at import time.
"""

from __future__ import annotations

from pathlib import Path

APP_NAME = "Enigma Builder"
ORG_NAME = "Enigma"

# The edition the Builder always writes and builds. Presets are value sources
# for the form, never build targets — see README.
CUSTOM_EDITION = "custom"
PRESETS = ("light", "plus", "pro")

REPO_ROOT = Path(__file__).resolve().parents[2]

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
DEPLOY_BUILD_SH = APP_DIR / "deploy" / "build.sh"
DEPLOY_DIST = APP_DIR / "deploy" / "dist"

# `deploy/build.sh` derives the app name from its own location; every other
# script takes it as the first positional argument.
APP_SLUG = "enigma"


def preset_yaml(edition: str) -> Path:
    """Path of a checked-in edition config (``light`` / ``plus`` / ``pro``)."""
    return CONFIGS_DIR / f"build_config.{edition}.yaml"


def missing_repo_files() -> list[Path]:
    """Repo files the Builder cannot work without, that are not on disk.

    Surfaced once at startup rather than as a crash mid-build: a wrong repo
    root (the tool copied elsewhere) shows up here as a readable list.
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
