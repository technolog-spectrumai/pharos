#!/usr/bin/env bash
#
# Enigma over Tor, two instances: two separate processes, each with its own
# embedded Tor client (arti) and its own state, talk through the real Tor network.
# One hosts an onion service, the other dials it; they run Enigma's join
# handshake (Hello/Ready) and then exchange frames both ways, checked byte for
# byte (apps/enigma/src-tauri/src/mesh_live.rs).
#
#   ./test_tor2.sh           build, then run both instances (a few minutes: two
#                            Tor bootstraps and a fresh onion descriptor)
#   ./test_tor2.sh --keep    keep the instances' Tor state and logs afterwards
#
# Needs internet access to the Tor network (outbound TCP to Tor relays). Not part
# of tests.sh or smoke_test.sh: it depends on the live network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

DIR="$(mktemp -d "${TMPDIR:-/tmp}/enigma-tor2.XXXXXX")"
HOST_PID=""
cleanup() {
  [[ -n "$HOST_PID" ]] && kill "$HOST_PID" 2>/dev/null || true
  if [[ $KEEP == 1 ]]; then echo "kept: $DIR"; else rm -rf "$DIR"; fi
}
trap cleanup EXIT

step "build Enigma's test binary (once, shared by both instances)"
cd "$REPO_ROOT"
BIN="$(cargo test -p enigma --lib --no-run --message-format=json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n")){try{const m=JSON.parse(l);if(m.reason==="compiler-artifact"&&m.profile&&m.profile.test&&m.target&&m.target.name==="enigma_lib"&&m.executable)console.log(m.executable)}catch{}}})' \
  | tail -1)"
[[ -x "$BIN" ]] || fail "could not find the enigma_lib test binary (cargo test -p enigma --lib --no-run)"
echo "binary: $BIN"

run() { # role
  TOR2_ROLE="$1" TOR2_DIR="$DIR" "$BIN" --ignored --exact "mesh::live::tor2_$1" --nocapture --test-threads=1
}

step "instance 1: host (bootstraps Tor, publishes an onion service)"
run host > "$DIR/host.log" 2>&1 &
HOST_PID=$!
sed -u 's/^/  host    | /' < <(tail -f "$DIR/host.log" --pid=$HOST_PID 2>/dev/null) &

step "instance 2: dialler (bootstraps its own Tor, dials the host's onion)"
set +e
run dialler 2>&1 | sed -u 's/^/  dialler | /'
DIAL_RC=${PIPESTATUS[0]}
wait "$HOST_PID"
HOST_RC=$?
HOST_PID=""
set -e

[[ $DIAL_RC == 0 && -f "$DIR/dialler-ok" ]] || fail "the dialler did not finish (exit $DIAL_RC)"
[[ $HOST_RC == 0 && -f "$DIR/host-ok" ]] || fail "the host did not finish (exit $HOST_RC); see its log above"
grep -q "1 passed" "$DIR/host.log" || fail "the host's test did not run"

step "PASS: two Enigma instances exchanged frames over Tor, both ways"
