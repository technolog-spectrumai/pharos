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

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

command -v node >/dev/null || die "node is not installed"
command -v npm  >/dev/null || die "npm is not installed"

# A shell inside a snap (VS Code's integrated terminal is the usual way to end
# up in one) exports the snap runtime, and that breaks BOTH things below:
#
#   * the desktop binary links against the snap's glibc and dies with
#     "symbol lookup error: ... undefined symbol: __libc_pthread_init";
#   * XDG_DATA_HOME points inside the snap sandbox, so --reset would clear a
#     path the real app never uses.
#
# Nothing here can fix it from the inside — the environment has to be clean —
# so say so plainly rather than let either look like a bug in the app.
IN_SNAP=0
if [ -n "${SNAP:-}" ] || [ -n "${SNAP_REVISION:-}" ]; then
  IN_SNAP=1
  warn "this shell is inside a snap, so the desktop window will fail with a"
  warn "glibc 'symbol lookup error' and app data resolves inside the sandbox."
  warn "Run from a normal terminal, or use --web."
fi

# ── stored data ─────────────────────────────────────────────────────────────
# Derived from the bundle identifier rather than hardcoded: Tauri builds the
# app-data path from that value, so reading it here is what keeps this from
# wiping some other app's directory if the identifier ever changes.
IDENTIFIER="$(node -p "require('./src-tauri/tauri.conf.json').identifier")"
case "$(uname -s)" in
  Darwin) APP_DATA="$HOME/Library/Application Support/$IDENTIFIER" ;;
  *)      APP_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/$IDENTIFIER" ;;
esac

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
command -v cargo >/dev/null || die "cargo is not installed — see https://rustup.rs (or use --web)"

step "Starting Zinnia (desktop)"
exec npx tauri dev
