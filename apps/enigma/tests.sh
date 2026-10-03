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

# The feature list of a preset, as the build driver validates it. Evaluated
# when a step runs (it needs the `yaml` package, which ensure_deps installs),
# so --list works on a bare checkout.
export REPO_ROOT BUILD_CONFIG_DEFAULT=pro.yaml
PRO='$(node rutile/scripts/build.mjs pro.yaml --print-features enigma)'
STD='$(node rutile/scripts/build.mjs std.yaml --print-features enigma)'
CRATE='--manifest-path apps/enigma/src-tauri/Cargo.toml --no-default-features'

# The app, rakotis, and the Rutile packages as THIS app resolves them. The
# suites always run with every feature compiled in, and exercise the gates by
# flipping the run-time build config.
tests_step js    "vitest: enigma, rakotis + shared packages"  'npm run test --workspaces --if-present'
tests_step js    "typecheck (rakotis)"                        'npm run typecheck --workspaces --if-present'

# With Professional's features — every one — which is also what the dev runner
# builds, so this run and `./run_dev.sh` share one compiled tree.
tests_step rust  "enigma app crate (Pro's features)"          "cargo test $CRATE --features \"$PRO\""
# A feature list is only an allowlist if every subset builds: the core alone,
# and Standard's. Warnings fail it — an unused item behind a missing feature is
# how a half-gated module shows up.
tests_step rust  "builds with no optional features"           "RUSTFLAGS='-D warnings' cargo check --tests $CRATE"
tests_step rust  "builds with Standard's features"            "RUSTFLAGS='-D warnings' cargo check --tests $CRATE --features \"$STD\""
# Omitted means not linked: Standard has none of the optional crates, Pro all.
# (Here-strings, not `echo | grep -q`: under pipefail a grep that stops at its
# first match fails the pipeline it was meant to pass.)
tests_step rust  "Standard links no optional crate"           "t=\$(cargo tree -e normal $CRATE --features \"$STD\"); for c in mainline rustfft; do if grep -q \" \$c v\" <<<\"\$t\"; then echo \"\$c is linked into a Standard build\"; exit 1; fi; done; t=\$(cargo tree -e normal $CRATE --features \"$PRO\"); for c in mainline rustfft; do grep -q \" \$c v\" <<<\"\$t\" || { echo \"\$c is missing from a Pro build\"; exit 1; }; done"
tests_step rust  "protasius (encrypted store)"                'cargo test --manifest-path protasius/Cargo.toml'
# The gate the crate layout exists to hold: Morion turns on gervasius's
# `gervazy` half, which pulls fernet and then OpenSSL. Enigma must never —
# checked with every feature on, the widest tree there is.
tests_step rust  "no OpenSSL in the enigma tree"              "test \"\$(cargo tree -e normal $CRATE --features \"$PRO\" | grep -c openssl-sys)\" = 0"
# Enigma's Gradle signing block, pin file and ignores against Rutile's checker.
tests_step py    "Android signing contract (pytest)"          'python3 -m pytest -q scripts/android_signing/tests -p no:cacheprovider'
tests_step build "frontend bundle, Pro (vue-tsc + vite)"      "ENIGMA_FEATURES=\"$PRO\" npm run build -w apps/enigma"
# The frontend half of "omitted means absent": a Standard bundle carries no
# call UI. And no bundle carries a map library or a map command: maps moved to
# Morion, and this is what would notice one coming back with a merge.
tests_step build "Standard bundle omits calls"                "rm -rf test-results/std-bundle && (cd apps/enigma && ENIGMA_FEATURES=\"$STD\" npx vite build --outDir ../../test-results/std-bundle --emptyOutDir >/dev/null) && if grep -rlE --include='*.js' 'vox_create' test-results/std-bundle/assets; then echo 'omitted feature code found in a Standard bundle'; exit 1; fi"
tests_step build "no bundle carries maps"                     "if grep -rlE --include='*.js' 'maplibre|map_get_tile|map_region_import' apps/enigma/dist/assets test-results/std-bundle/assets; then echo 'map code found in a bundle'; exit 1; fi"
tests_step build "both presets resolve"                       './build.sh --dry-run && ./build.sh std.yaml --dry-run'
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
