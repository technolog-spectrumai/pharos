#!/usr/bin/env bash
#
# Enigma's full test run — the long one, for running by hand.
#
#   ./tests.sh enigma              every step (from the repo root)
#   ./tests.sh enigma rust build   only these groups (js | rust | py | build)
#   ./tests.sh enigma --list       show the steps, run nothing
#
# Every step runs even if an earlier one fails; the table at the end says which.
# Each step's output is also saved under test-results/tests/.
set -euo pipefail

# Steps run from the repo root.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$ROOT"
. "$ROOT/scripts/lib.sh"
. "$ROOT/scripts/tests_lib.sh"

export REPO_ROOT
# One package selected, never --workspace: cargo unifies features across every
# package an invocation selects, and Morion's gervazy/OpenSSL must not leak in.
CRATE='-p enigma'

# The app, rakotis, and the shared packages as THIS app resolves them.
tests_step js    "vitest: enigma, rakotis"                    'npm run test -w apps/enigma -w apps/enigma/packages/rakotis'
tests_step js    "typecheck (rakotis)"                        'npm run typecheck -w apps/enigma/packages/rakotis'
# The app, and its build configs (vite/vitest.config.ts), which `npm run build`
# does not typecheck: they are a project of their own.
tests_step js    "typecheck (app and build configs)"          'npm run typecheck -w apps/enigma'

tests_step rust  "enigma app crate"                           "cargo test $CRATE"
tests_step rust  "builds without warnings"                    "RUSTFLAGS='-D warnings' cargo check --tests $CRATE"
# Calls, the DHT, contacts and the calendar left Enigma (Vesper has them): their
# crates must not come back with a merge. (Here-strings, not `echo | grep -q`:
# under pipefail a grep that stops at its first match fails the pipeline.)
tests_step rust  "links none of the removed features' crates" "t=\$(cargo tree -e normal $CRATE); for c in mainline rustfft iroh-mainline-address-lookup; do if grep -q \" \$c v\" <<<\"\$t\"; then echo \"\$c is linked into Enigma\"; exit 1; fi; done"
tests_step rust  "protasius (encrypted store)"                'cargo test -p protasius'
# The gate the crate layout exists to hold: Morion turns on gervasius's
# `gervazy` half, which pulls fernet and then OpenSSL. Enigma must never.
tests_step rust  "no OpenSSL in the enigma tree"              "test \"\$(cargo tree -e normal $CRATE | grep -c openssl-sys)\" = 0"
# Enigma's Gradle signing block, pin file and ignores against Rutile's checker.
tests_step py    "Android signing contract (pytest)"          'python3 -m pytest -q apps/enigma/scripts/android_signing/tests -p no:cacheprovider'
tests_step build "frontend bundle (vue-tsc + vite)"           'npm run build -w apps/enigma'
# No bundle carries a call, a map or a DHT command: they moved to Vesper and
# Morion, and this is what would notice one coming back with a merge.
tests_step build "the bundle has no removed feature"          "if grep -rlE --include='*.js' 'vox_create|dht_status|invite_send|maplibre|map_get_tile|map_region_import' apps/enigma/dist/assets; then echo 'removed feature code found in the bundle'; exit 1; fi"
tests_step build "dromon.yaml resolves"                       './build.sh enigma --validate'
# The Playwright end-to-end specs (~17 s) are not a smoke test: they run in
# ./user_tests.sh only.

tests_answered "$@" && exit 0

need_node
need_cargo
check_system_libs
# The Rust suites start GTK; from a snap shell that needs the same repair the
# dev runners make.
scrub_snap_env
ensure_deps
tests_main "$@"
