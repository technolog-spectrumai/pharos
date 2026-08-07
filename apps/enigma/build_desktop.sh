#!/usr/bin/env bash
# One-click desktop build: installs workspace deps, then builds the Enigma
# release bundle (frontend build runs automatically via tauri's beforeBuildCommand).
#
#   ./build_desktop.sh            # release bundles (.deb / .AppImage / .rpm)
#   ./build_desktop.sh --debug    # faster, unoptimized debug bundle
#
# Output: apps/enigma/src-tauri/target/release/bundle/ (or debug/).
# Android builds: scripts/build_android.sh (see build_android.md for SDK setup).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/apps/enigma"
cd "$SCRIPT_DIR"

# Per-edition identity: each edition bundles as its own app (own productName,
# binary and bundle identifier), so two editions can be installed side by side
# and keep separate data directories. See scripts/edition_conf.sh.
. "$SCRIPT_DIR/scripts/edition_conf.sh"
edition_conf_args CONF_ARGS

echo "==> npm install (workspace root)"
npm install

echo "==> tauri build"
cd apps/enigma
if [[ "${1:-}" == "--debug" ]]; then
  npx tauri build --debug "${CONF_ARGS[@]}"
else
  npx tauri build "${CONF_ARGS[@]}"
fi

echo "==> Done. Bundles:"
find src-tauri/target/*/bundle -type f \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) 2>/dev/null || true
