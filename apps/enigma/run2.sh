#!/usr/bin/env bash
# Run two Enigma dev instances side by side (default profiles: alice + bob) so you
# can exercise a P2P chat between two identities on one machine.
#
#   ./run2.sh [profile-a] [profile-b]        # defaults: alice bob
#   ./run2.sh --reset                        # wipe BOTH profiles first, then run
#   ./run2.sh --purge alice bob              # …deleting instead of archiving
#
# --reset makes the next start a FIRST RUN for both instances, so each asks you
# to set a new passphrase — which is also the quickest way back to a clean
# two-party pairing test. It archives each profile directory aside and clears
# the webview caches (see scripts/reset_profile.sh); --purge deletes instead and
# asks for confirmation (-y skips the prompt). Env equivalent:
# ENIGMA_RESET=1|purge.
#
# Each instance gets its own APP_PROFILE / CHAT_USER, so they keep separate data
# dirs and identity namespaces (no cross-instance identity reuse). Both instances
# share a single Vite dev server on :1420 — the first instance starts it, the
# second reuses it (see rutile/scripts/tauri-dev-server.mjs), so there is no
# port collision. The two Rust/webview app processes are independent.
#
# Note: because the Vite server is a child of the first instance, closing the
# first instance also stops Vite. This script therefore ties the two together:
# Ctrl-C — or either instance exiting — tears both down.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/apps/enigma"

# Everything below is Rutile's; without the submodule there is nothing to run.
[ -f "$SCRIPT_DIR/rutile/scripts/lib.sh" ] || {
  echo "rutile/ is empty — this repo is built on the Rutile submodule." >&2
  echo "  git submodule update --init" >&2
  exit 1
}

# step/warn/die, the toolchain checks, the snap trap and the dependency install.
. "$SCRIPT_DIR/rutile/scripts/lib.sh"

# Dev default: the Pro edition (cloud-capable — the Cloud tab exists; its master
# switch still defaults OFF). Both launch() subshells inherit the export.
# Override: ENIGMA_EDITION=basic ./run2.sh   (first run after a switch = full
# Rust rebuild, see build.md).
export ENIGMA_EDITION="${ENIGMA_EDITION:-professional}"

# Per-edition identity (own bundle id ⇒ own data dir). Both launch()
# subshells inherit CONF_ARGS. See scripts/edition_conf.sh.
. "$SCRIPT_DIR/scripts/edition_conf.sh"
edition_conf_args CONF_ARGS

# Flags may appear anywhere; the positional leftovers stay profile-a / profile-b
# so the documented `./run2.sh carol dave` form is unchanged.
RESET="${ENIGMA_RESET:-0}"
RESET_ARGS=()
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --reset) [ "$RESET" = "purge" ] || RESET=1 ;;
    --purge) RESET=purge ;;
    -y | --yes) RESET_ARGS+=(-y) ;;
    -h | --help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "[run2] unknown option: $1" >&2
      exit 2
      ;;
    *) POSITIONAL+=("$1") ;;
  esac
  shift
done

PROFILE_A="${POSITIONAL[0]:-alice}"
PROFILE_B="${POSITIONAL[1]:-bob}"
VITE_PORT=1420

# Same preflight as run_dev.sh, and for the same reasons: say what is missing
# rather than let `npm run` fail without naming it, and undo a snap shell's GTK
# environment before either app (or the reset) reads it.
need_node
need_cargo
scrub_snap_env
ensure_deps

# Reset BEFORE launching either instance — and in one call, so the two profiles
# share a timestamp and the global webview caches are cleared exactly once.
if [ "$RESET" != "0" ]; then
  if [ "$RESET" = "purge" ]; then RESET_ARGS+=(--purge); fi
  "$SCRIPT_DIR/scripts/reset_profile.sh" "${RESET_ARGS[@]}" "$PROFILE_A" "$PROFILE_B"
fi

# Kill every process in this script's process group on exit, so no orphan vite /
# cargo / app process survives a Ctrl-C.
cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "[run2] shutting down both instances…"
  kill -- -$$ 2>/dev/null || true
}
trap cleanup INT TERM EXIT

. "$SCRIPT_DIR/scripts/dev_target.sh"

launch() {
  local profile="$1"
  echo "[run2] starting instance: profile=$profile"
  # Subshell mirrors run_dev.sh (cd into the app, then `npm run tauri dev`).
  # Output is line-prefixed with the profile so the two logs stay distinguishable.
  (
    cd "$APP_DIR"
    # Own build dir per profile — without this the second instance parks on
    # "Blocking waiting for file lock on build directory" for the whole of the
    # first one's compile+link (scripts/dev_target.sh).
    dev_target_export "$profile" "$APP_DIR/src-tauri" || exit 1
    APP_PROFILE="$profile" CHAT_USER="$profile" npm run tauri -- dev "${CONF_ARGS[@]}"
  ) 2>&1 | sed -u "s/^/[$profile] /" &
}

# Poll a TCP port using bash's /dev/tcp until it accepts a connection.
wait_for_port() {
  local port="$1" tries=240 # ~120s
  for ((i = 0; i < tries; i++)); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      exec 3>&- 3<&-
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# Start the first instance; it owns the shared Vite server. Wait until Vite is
# accepting connections before starting the second, otherwise both could race to
# bind :1420 (strictPort) and one would fail to start.
launch "$PROFILE_A"
echo "[run2] waiting for the Vite dev server on :$VITE_PORT…"
if ! wait_for_port "$VITE_PORT"; then
  echo "[run2] ERROR: Vite never came up on :$VITE_PORT" >&2
  exit 1
fi
echo "[run2] Vite is up — starting second instance"
launch "$PROFILE_B"

# Block until either instance exits; the EXIT trap then tears the other down.
wait -n
