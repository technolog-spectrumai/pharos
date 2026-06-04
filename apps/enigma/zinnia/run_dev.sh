#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/enigma"

APP_PROFILE="${APP_PROFILE:-default}"
CHAT_USER="${CHAT_USER:-default}"

cd "$APP_DIR"

APP_PROFILE="$APP_PROFILE" CHAT_USER="$CHAT_USER" npm run tauri dev
