#!/usr/bin/env bash
# Reset a dev profile's stored data so the next start is a FIRST RUN — i.e. the
# app asks you to set a new passphrase.
#
#   scripts/reset_profile.sh [--purge] [-y] <profile> [<profile>…]
#
# Used by run_dev.sh --reset and run2.sh --reset; you can also call it directly.
#
# What it touches, and why that is the whole list:
#   profiles/<profile>/     the protasius store + vault.json (the wrapped DEK the
#                           passphrase opens), profile_state.json, tor/ — removing
#                           it is what makes the app offer first-run setup again.
#   WebKitCache/ CacheStorage/ storage/ …
#                           the webview's own caches. GLOBAL, not per-profile, so
#                           they are cleared once per run. Pure cache: the app
#                           regenerates them, and stale frontend assets are the
#                           usual reason a dev build misbehaves after a rebuild.
#
# Deliberately NOT touched: `iroh_gossip.key` and the legacy `kvstore/` at the
# app-data root. Those are GLOBAL — shared by every profile — so removing them
# while resetting one profile would quietly change the other profiles' identity
# too. `--purge` still leaves them alone; use the app's own panic code if you
# want everything gone.
#
# Default is ARCHIVE, not delete: the profile directory is renamed aside to
# `<profile>.reset-<UTC stamp>`. A dev vault still holds a real identity (iroh
# key, MLS state, room history) and a mistyped profile name should not be
# unrecoverable. `--purge` deletes instead, and asks first unless `-y`.
set -euo pipefail

PURGE=0
ASSUME_YES=0
PROFILES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -*)
      echo "[reset] unknown option: $1" >&2
      exit 2
      ;;
    *) PROFILES+=("$1") ;;
  esac
  shift
done

if [ ${#PROFILES[@]} -eq 0 ]; then
  echo "[reset] usage: scripts/reset_profile.sh [--purge] [-y] <profile> [<profile>…]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CONF="$REPO_DIR/apps/enigma/src-tauri/tauri.conf.json"

# Which app's data are we resetting? The bundle identifier IS the data directory
# (Tauri derives app_data_dir from it), and each edition overrides it — so read
# the active edition's overlay first and fall back to the base config. Getting
# this wrong would reset a DIFFERENT edition's vault, which is why it is derived
# rather than hardcoded.
EDITION="$(printf '%s' "${ENIGMA_EDITION:-}" | tr '[:upper:]' '[:lower:]')"
OVERLAY="$REPO_DIR/apps/enigma/src-tauri/tauri.$EDITION.conf.json"
read_identifier() {
  sed -n 's/.*"identifier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -1
}
IDENTIFIER=""
if [ -n "$EDITION" ] && [ -f "$OVERLAY" ]; then
  IDENTIFIER="$(read_identifier "$OVERLAY")"
fi
[ -n "$IDENTIFIER" ] || IDENTIFIER="$(read_identifier "$CONF")"
if [ -z "$IDENTIFIER" ]; then
  echo "[reset] ERROR: could not read the bundle identifier from $CONF" >&2
  exit 1
fi

# Tauri's app_data_dir, per platform.
case "$(uname -s)" in
  Darwin) APP_DATA="$HOME/Library/Application Support/$IDENTIFIER" ;;
  *) APP_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/$IDENTIFIER" ;;
esac

echo "[reset] edition '${EDITION:-<unset>}' → $IDENTIFIER"
if [ ! -d "$APP_DATA" ]; then
  echo "[reset] nothing to reset — no app data at $APP_DATA"
  exit 0
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"

# The app sanitizes the profile name into a single path component before using
# it (lib.rs::safe_filename_component). Mirror the *refusal* half here: anything
# with a separator, or the traversal names, would make the target escape
# profiles/ — and this script deletes what it is pointed at.
reject_unsafe() {
  local p="$1"
  case "$p" in
    "" | "." | ".." | */* | *\\*)
      echo "[reset] ERROR: refusing unsafe profile name: '$p'" >&2
      exit 1
      ;;
  esac
}

for profile in "${PROFILES[@]}"; do
  reject_unsafe "$profile"
done

# Confirm before an irreversible delete, since a dev vault holds a real identity.
if [ "$PURGE" = 1 ] && [ "$ASSUME_YES" != 1 ]; then
  echo "[reset] about to PERMANENTLY DELETE the stored data for: ${PROFILES[*]}"
  echo "[reset]   under $APP_DATA/profiles"
  echo "[reset] this destroys each profile's identity, rooms and message history."
  printf "[reset] type 'purge' to confirm: "
  read -r answer
  if [ "$answer" != "purge" ]; then
    echo "[reset] aborted — nothing was touched."
    exit 1
  fi
fi

for profile in "${PROFILES[@]}"; do
  dir="$APP_DATA/profiles/$profile"
  if [ ! -e "$dir" ]; then
    echo "[reset] profile '$profile': nothing stored yet (will be a first run anyway)"
    continue
  fi
  if [ "$PURGE" = 1 ]; then
    rm -rf -- "$dir"
    echo "[reset] profile '$profile': DELETED $dir"
  else
    archive="$dir.reset-$STAMP"
    mv -- "$dir" "$archive"
    echo "[reset] profile '$profile': archived to $archive"
  fi
done

# Webview caches — global, pure cache, safe to drop.
for c in WebKitCache CacheStorage storage httpcache hsts-storage.sqlite; do
  target="$APP_DATA/$c"
  [ -e "$target" ] || continue
  rm -rf -- "$target"
  echo "[reset] cleared webview cache: $c"
done

echo "[reset] done — the next start will ask you to set a new passphrase."
if [ "$PURGE" != 1 ]; then
  echo "[reset] (archived copies remain under $APP_DATA/profiles — delete them when you are sure.)"
fi
