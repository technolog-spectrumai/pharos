#!/usr/bin/env bash
#
# The shared base's test run — everything that can be tested without an app:
# the shared crates and packages, and the build engine.
#
#   ./tests.sh base              every step (from the repo root)
#   ./tests.sh base rust         only one group (js | rust | py)
#   ./tests.sh base --list       show the steps, run nothing
#
# Every step runs even if an earlier one fails; the table at the end says which.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/scripts/lib.sh"
. "$REPO_ROOT/scripts/tests_lib.sh"

tests_step js   "petalite + wisteria (vitest)"    'npm run test -w packages/petalite -w packages/wisteria'
tests_step js   "configs → commands (planner)"    'node --test tools/build/build_plan.test.mjs'
tests_step js   "every config validates"          './build.sh enigma configs/enigma-pro.yaml --validate && ./build.sh enigma configs/enigma-std.yaml --validate && ./build.sh morion configs/morion.yaml --validate && ./build.sh irena configs/irena.yaml --validate'
tests_step rust "substrate"                       'cargo test -p substrate'
# The feature that reaches gervasius's gervazy half, and so OpenSSL: Morion
# turns it on, Enigma must not. Both shapes have to keep working.
tests_step rust "substrate, legacy-detect"        'cargo test -p substrate --features legacy-detect'
tests_step rust "gervasius (at-rest crypto)"      'cargo test -p gervasius'
tests_step rust "gervasius, gervazy"              'cargo test -p gervasius --features gervazy'
tests_step rust "rotor_core (MLS)"                'cargo test -p rotor-core'

tests_answered "$@" && exit 0

need_node
need_cargo
ensure_deps
tests_main "$@"
