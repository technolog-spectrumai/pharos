#!/usr/bin/env bash
#
# Enigma's full test run — the long one, for running by hand.
#
#   ./tests.sh              every step
#   ./tests.sh rust e2e     only these groups (js | rust | py | build | e2e)
#   ./tests.sh --list       show the steps, run nothing
#
# Every step runs even if an earlier one fails; the table at the end says which.
# Each step's output is also saved under test-results/tests/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Everything below is Rutile's; without the submodule there is nothing to run.
[ -f "$ROOT/rutile/scripts/lib.sh" ] || {
  echo "rutile/ is empty — this repo is built on the Rutile submodule." >&2
  echo "  git submodule update --init" >&2
  exit 1
}

REPO_ROOT="$ROOT"
. "$ROOT/rutile/scripts/lib.sh"
. "$ROOT/rutile/scripts/tests_lib.sh"

# Built with the edition the dev runners use, so this run and `./run_dev.sh`
# share one compiled tree instead of rebuilding it each time they alternate.
# Override like the runners: ENIGMA_EDITION=basic ./tests.sh rust
export ENIGMA_EDITION="${ENIGMA_EDITION:-professional}"

# The app, rakotis, and the Rutile packages as THIS app resolves them.
tests_step js    "vitest: enigma, rakotis + shared packages"  'npm run test --workspaces --if-present'
tests_step js    "typecheck (rakotis)"                        'npm run typecheck --workspaces --if-present'
tests_step rust  "enigma app crate"                           'cargo test --manifest-path apps/enigma/src-tauri/Cargo.toml'
tests_step rust  "protasius (encrypted store)"                'cargo test --manifest-path protasius/Cargo.toml'
# The gate the crate layout exists to hold: Morion turns on gervasius's
# `gervazy` half, which pulls fernet and then OpenSSL. Enigma must never.
tests_step rust  "no OpenSSL in the enigma tree"              'test "$(cargo tree -p enigma -e normal --manifest-path apps/enigma/src-tauri/Cargo.toml | grep -c openssl-sys)" = 0'
# Enigma's Gradle signing block, pin file and ignores against Rutile's checker.
tests_step py    "Android signing contract (pytest)"          'python3 -m pytest -q scripts/android_signing/tests -p no:cacheprovider'
tests_step build "frontend bundle (vue-tsc + vite)"           'npm run build -w apps/enigma'
tests_step build "build.yaml resolves"                        './build.sh --dry-run'
# Needs Playwright's browsers: npx playwright install chromium
tests_step e2e   "Playwright smoke"                           'npm run test:e2e -w apps/enigma'

tests_answered "$@" && exit 0

need_node
need_cargo
check_system_libs
# The Rust suites start GTK; from a snap shell that needs the same repair the
# dev runners make.
scrub_snap_env
ensure_deps
tests_main "$@"
