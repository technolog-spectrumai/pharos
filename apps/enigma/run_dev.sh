#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/apps/enigma"

# Dev default: the Pro edition (cloud-capable — the Cloud tab exists; its master
# switch still defaults OFF). Override: ENIGMA_EDITION=light ./run_dev.sh
# Note: build.rs re-runs on an edition switch, so the first run after changing
# this triggers a full Rust rebuild (build.md).
export ENIGMA_EDITION="${ENIGMA_EDITION:-pro}"

APP_PROFILE="${APP_PROFILE:-default}"
CHAT_USER="${CHAT_USER:-default}"

cd "$APP_DIR"

APP_PROFILE="$APP_PROFILE" CHAT_USER="$CHAT_USER" npm run tauri dev
