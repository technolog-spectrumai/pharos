#!/usr/bin/env bash
# Run one Enigma dev instance.
#
#   ./run_dev.sh                    # profile "default"
#   ./run_dev.sh --reset            # wipe this profile's data first, then run
#   ./run_dev.sh --purge            # …deleting it outright instead of archiving
#   APP_PROFILE=alice ./run_dev.sh  # a different profile
#
# --reset makes the next start a FIRST RUN, so the app asks you to set a new
# passphrase. It archives the profile directory aside and clears the webview
# caches (see scripts/reset_profile.sh); --purge deletes instead and asks for
# confirmation (-y skips the prompt). Env equivalent: ENIGMA_RESET=1|purge.
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

RESET="${ENIGMA_RESET:-0}"
RESET_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --reset) [ "$RESET" = "purge" ] || RESET=1 ;;
    --purge) RESET=purge ;;
    -y | --yes) RESET_ARGS+=(-y) ;;
    -h | --help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[run_dev] unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# Reset BEFORE launching: the app holds the store open while it runs, so pulling
# the directory out from under a live instance would prove nothing.
if [ "$RESET" != "0" ]; then
  if [ "$RESET" = "purge" ]; then RESET_ARGS+=(--purge); fi
  "$SCRIPT_DIR/scripts/reset_profile.sh" "${RESET_ARGS[@]}" "$APP_PROFILE"
fi

cd "$APP_DIR"

APP_PROFILE="$APP_PROFILE" CHAT_USER="$CHAT_USER" npm run tauri dev
