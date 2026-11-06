#!/usr/bin/env bash
# Pharos test run: every step runs, a summary table at the end.
#   ./tests.sh            everything
#   ./tests.sh js         only the JS steps (js | rust)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
want="${1:-all}"
declare -a names=() codes=()
step() { local group="$1" name="$2"; shift 2
  [[ "$want" == all || "$want" == "$group" ]] || return 0
  echo "── $name"; "$@"; local c=$?; names+=("$name"); codes+=("$c"); }
[[ -d node_modules ]] || npm ci
step js   "vitest: enigma"          npm run test -w enigma
step js   "vitest: rakotis"         npm run test -w packages/rakotis
step js   "vitest: petalite"        npm run test -w packages/petalite
step js   "vitest: calendula"       npm run test -w packages/calendula
step js   "typecheck: rakotis"      npm run typecheck -w packages/rakotis
step js   "typecheck: enigma"       npm run typecheck -w enigma
step js   "build: enigma window"    npm run build -w enigma
step js   "e2e: enigma smoke"       npm run test:e2e -w enigma
step rust "cargo test: enigma"      cargo test -p enigma
step rust "cargo test: crates"      cargo test -p gervasius -p protasius -p rotor-core -p ferrozine -p pharos-wire -p pharos-seal -p pharos-rendezvous -p pharos-id -p pharos-tor -p pharos-node -p proteus
fail=0; echo; for i in "${!names[@]}"; do
  if [[ ${codes[$i]} == 0 ]]; then echo "  ok    ${names[$i]}"; else echo "  FAIL  ${names[$i]}"; fail=1; fi
done; exit $fail
