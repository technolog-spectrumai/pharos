#!/usr/bin/env bash
#
# Run Zinnia in development.
#
#   ./run_dev.sh               desktop window (Tauri) with hot reload
#   ./run_dev.sh --web         browser only at http://localhost:1430, no Rust
#   ./run_dev.sh --reset       wipe this app's stored data first, then run
#   ./run_dev.sh --reset-only  wipe and exit
#
# Tauri starts the frontend itself through `beforeDevCommand`, which points at
# scripts/tauri-dev-server.mjs — that reuses an already-running Vite instead of
# failing on the strict port, so `--web` in one terminal and this in another
# share one server.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

WEB=0
RESET=0
RESET_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --web)        WEB=1 ;;
    --reset)      RESET=1 ;;
    --reset-only) RESET=1; RESET_ONLY=1 ;;
    -h|--help)    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# step/warn/die, the toolchain checks, snap detection and the app-data path.
. "$HERE/scripts/lib.sh"

need_node
detect_snap

# ── stored data ─────────────────────────────────────────────────────────────
APP_DATA="$(app_data_dir ./src-tauri/tauri.conf.json)"

if [ "$RESET" -eq 1 ]; then
  step "Resetting stored data"
  [ "$IN_SNAP" -eq 1 ] && warn "this path is inside the snap sandbox, not the real app data dir"
  if [ -d "$APP_DATA" ]; then
    rm -rf "$APP_DATA"
    echo "    removed $APP_DATA"
  else
    echo "    nothing stored yet ($APP_DATA)"
  fi
  # The signed-in server, token and theme live in the webview's localStorage,
  # which is inside that directory — so this is also "sign me out".
  [ "$RESET_ONLY" -eq 1 ] && exit 0
fi

# ── dependencies ────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  step "Installing dependencies"
  npm install --no-audit --no-fund
fi

# ── web only ────────────────────────────────────────────────────────────────
if [ "$WEB" -eq 1 ]; then
  # Read from the config rather than repeated here: the port already lives in
  # four files and a test fails if they drift — this message should not become
  # a fifth place to get it wrong.
  PORT="$(grep -oE 'port: *[0-9]+' vite.config.ts | grep -oE '[0-9]+' | head -1)"
  step "Starting Vite (browser only)"
  echo "    http://localhost:${PORT:-1430}"
  exec npm run dev
fi

# ── desktop ─────────────────────────────────────────────────────────────────
need_cargo "or use --web"

step "Starting Zinnia (desktop)"
exec npx tauri dev
