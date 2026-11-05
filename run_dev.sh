#!/usr/bin/env bash
# Run Nautes in development.
#   ./run_dev.sh                 profile "default"
#   ./run_dev.sh alice           another profile (own data dir and identity)
# Two profiles side by side: run ./run_dev.sh alice and ./run_dev.sh bob in two terminals.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[[ -d node_modules ]] || npm ci
export APP_PROFILE="${1:-${APP_PROFILE:-default}}" CHAT_USER="${1:-${CHAT_USER:-default}}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target/dev-$APP_PROFILE}"
cd nautes && exec npx tauri dev
