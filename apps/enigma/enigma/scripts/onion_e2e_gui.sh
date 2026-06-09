#!/usr/bin/env bash
# OPTIONAL, MANUAL: two real Enigma desktop windows talking to each other over the
# onion. Not part of CI — needs a display (or xvfb) and a full Tauri build (links
# arti). The headless transport proof is enigma/enigma/scripts/onion_e2e.sh; this is
# the visual 2-instance demo.
#
# Prereqs: the studio onion stack is already up (run onion_e2e.sh with KEEP_UP=1, or
# `deploy.py deployment/portal_onion_studio_tls.yaml up -d --service --admin-password test1234`),
# and you have the .onion address (`deploy.py … onion --service`).
#
# Usage:   ONION=<hash>.onion bash enigma/enigma/scripts/onion_e2e_gui.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP="$ROOT/enigma/enigma"
: "${ONION:?set ONION=<hash>.onion}"

cd "$APP"
echo "[gui] building the Tauri app (this links arti — slow first time)…"
npm run tauri build -- --no-bundle 2>/dev/null || npx tauri build --no-bundle
BIN="$(find src-tauri/target/release -maxdepth 1 -type f -name enigma -perm -u+x | head -1)"
[ -n "$BIN" ] || { echo "build produced no binary"; exit 1; }

run_one() {  # profile
  local p="$1"
  echo "[gui] launching instance '$p' — set Server: https://$ONION, toggle 'Onion (Tor)' ON, log in as admin/test1234, open channel 'e2e'."
  APP_PROFILE="$p" CHAT_USER="$p" ${XVFB:+xvfb-run -a} "$BIN" &
}

run_one alice
sleep 2
run_one bob
echo "[gui] two windows launched. In Alice send a chat message + an image to channel 'e2e'; Bob should receive both over the onion."
wait
