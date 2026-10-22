#!/usr/bin/env bash
# Run Enigma26 in development — one instance, or two side by side.
#
#   ./run_dev.sh enigma                              one instance, profile "default", Professional
#   ./run_dev.sh enigma configs/enigma-std.yaml      …built with another preset's features
#   ./run_dev.sh enigma --dual                       two instances (profiles alice + bob) to pair
#   ./run_dev.sh enigma --dual carol dave            …with other profile names
#   ./run_dev.sh enigma --reset                      wipe the profile(s) first, then run
#   ./run_dev.sh enigma --purge                      …deleting outright instead of archiving
#   APP_PROFILE=alice ./run_dev.sh enigma            one instance on a different profile
#
# (from the repo root; apps/enigma/run_dev.sh takes the same arguments without
# the app name.) The build's features come from a config in configs/ —
# enigma-pro.yaml unless one is named — so a dev run is the same build
# `./build.sh enigma` would package.
#
# --dual gives each instance its own APP_PROFILE / CHAT_USER (separate data
# dirs and identities) and its own Cargo build dir, so neither waits on the
# other's link. Both share ONE Vite dev server: the first instance starts it,
# the second reuses it (scripts/tauri-dev-server.mjs). Because that
# server is a child of the first instance, the two are tied together: Ctrl-C —
# or either instance exiting — tears both down.
#
# --reset makes the next start a FIRST RUN, so the app asks for a new
# passphrase. It archives the profile directory aside and clears the webview
# caches (scripts/reset_profile.sh); --purge deletes instead and asks for
# confirmation (-y skips the prompt). Env equivalent: ENIGMA_RESET=1|purge.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'; }

# ── arguments ───────────────────────────────────────────────────────────────
# Flags may appear anywhere. A positional argument ending in .yaml is the
# config — the same convention ./build.sh has; any other is a profile name,
# which only --dual takes.
CONFIG=""
DUAL=0
RESET="${ENIGMA_RESET:-0}"
RESET_ARGS=()
NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dual) DUAL=1 ;;
    --reset) [ "$RESET" = "purge" ] || RESET=1 ;;
    --purge) RESET=purge ;;
    -y | --yes) RESET_ARGS+=(-y) ;;
    --config)
      shift
      [ $# -gt 0 ] || { echo "[run_dev] --config needs a file" >&2; exit 2; }
      CONFIG="$1" ;;
    --config=*) CONFIG="${1#--config=}" ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "[run_dev] unknown option: $1 (try --help)" >&2; exit 2 ;;
    *.yaml | *.yml) CONFIG="$1" ;;
    *) NAMES+=("$1") ;;
  esac
  shift
done

if [ "$DUAL" -eq 1 ]; then
  [ "${#NAMES[@]}" -le 2 ] || { echo "[run_dev] --dual takes at most two profile names" >&2; exit 2; }
  PROFILES=("${NAMES[0]:-alice}" "${NAMES[1]:-bob}")
  [ "${PROFILES[0]}" != "${PROFILES[1]}" ] || { echo "[run_dev] --dual needs two different profiles" >&2; exit 2; }
else
  [ "${#NAMES[@]}" -eq 0 ] || {
    echo "[run_dev] unexpected argument: ${NAMES[0]} — set APP_PROFILE for another profile, or use --dual" >&2
    exit 2
  }
  PROFILES=("${APP_PROFILE:-default}")
fi

# ── preflight ───────────────────────────────────────────────────────────────
# step/warn/die, the toolchain checks, the snap trap and the dependency install
# — the repo's, shared with every app.
REPO_ROOT="$ROOT"
. "$ROOT/scripts/lib.sh"

# Checked here rather than left to fail inside `npm run`: a missing toolchain or
# an npm that cannot start otherwise surfaces as a stack trace that names no
# cause. The scrub must come before the reset — it also decides which data
# directory "this profile" means.
need_node
need_cargo
scrub_snap_env

# Reset BEFORE launching: the app holds the store open while it runs, so pulling
# the directory out from under a live instance would prove nothing. One call for
# both profiles, so they share a timestamp and the global webview caches are
# cleared exactly once.
if [ "$RESET" != "0" ]; then
  if [ "$RESET" = "purge" ]; then RESET_ARGS+=(--purge); fi
  "$SCRIPT_DIR/scripts/reset_profile.sh" "${RESET_ARGS[@]}" "${PROFILES[@]}"
fi

# A fresh clone — or a checkout whose node_modules was cleaned away — has no
# `tauri` and no `vite` to run, and no `yaml` to read the config with.
ensure_deps

# ── what to build ───────────────────────────────────────────────────────────
# The feature list of the chosen config, validated by the same code that
# validates it for a build. Cargo gets it as --features; the frontend reads it
# from ENIGMA_FEATURES (apps/enigma/buildFeatures.ts). Exported even when empty:
# "no optional features" is a list, not an absence.
FEATURES="$(cd "$ROOT" && node tools/build/build.mjs enigma "${CONFIG:-configs/enigma-pro.yaml}" --print-features)"
export ENIGMA_FEATURES="$FEATURES"
FEATURE_ARGS=()
[ -z "$FEATURES" ] || FEATURE_ARGS=(--features "$FEATURES")
echo "[run_dev] ${CONFIG:-configs/enigma-pro.yaml}: ${FEATURES:-no optional features}"

# Per-profile Cargo build directory: two instances must not queue behind each
# other's link. Costs ~17 GB per profile — see scripts/dev_target.sh.
. "$SCRIPT_DIR/scripts/dev_target.sh"

# Run one instance in the foreground of the calling (sub)shell.
run_instance() {
  local profile="$1" user="$2"
  dev_target_export "$profile" "$ROOT" || return 1
  cd "$APP_DIR"
  APP_PROFILE="$profile" CHAT_USER="$user" npm run tauri -- dev "${FEATURE_ARGS[@]}"
}

# ── one instance ────────────────────────────────────────────────────────────
if [ "$DUAL" -eq 0 ]; then
  run_instance "${PROFILES[0]}" "${CHAT_USER:-${PROFILES[0]}}"
  exit $?
fi

# ── two instances ───────────────────────────────────────────────────────────
# Every process this script started, however deep: each instance is npm → tauri
# → vite / cargo → the app, and a signal to the top of that chain does not
# reliably reach the bottom. Walked by parent rather than by process group, so
# it is right whether or not this script happens to lead one.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "[run_dev] shutting down both instances…"
  local pid
  for pid in $(jobs -p); do kill_tree "$pid"; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

launch() {
  local profile="$1"
  echo "[run_dev] starting instance: profile=$profile"
  # Output is line-prefixed with the profile so the two logs stay distinguishable.
  ( run_instance "$profile" "$profile" ) 2>&1 | sed -u "s/^/[$profile] /" &
}

# Poll a TCP port using bash's /dev/tcp until it accepts a connection.
wait_for_port() {
  local port="$1" tries=240 i # ~120s
  for ((i = 0; i < tries; i++)); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# The port is the app's own (tauri.conf.json devUrl) — not a copy kept here.
VITE_PORT="$(node -p "new URL(require('$APP_DIR/src-tauri/tauri.conf.json').build.devUrl).port")"

# Start the first instance; it owns the shared Vite server. Wait until Vite is
# accepting connections before starting the second, otherwise both could race to
# bind the port (strictPort) and one would fail to start.
launch "${PROFILES[0]}"
echo "[run_dev] waiting for the Vite dev server on :$VITE_PORT…"
if ! wait_for_port "$VITE_PORT"; then
  echo "[run_dev] ERROR: Vite never came up on :$VITE_PORT" >&2
  exit 1
fi
echo "[run_dev] Vite is up — starting second instance"
launch "${PROFILES[1]}"

# Block until either instance exits; the EXIT trap then tears the other down.
wait -n
