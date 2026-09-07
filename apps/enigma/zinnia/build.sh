#!/usr/bin/env bash
#
# Build the Zinnia desktop app.
#
#   ./build.sh                 release bundle (deb + rpm)
#   ./build.sh --debug         debug bundle — builds far faster, runs slower
#   ./build.sh --no-test       skip the test suite
#   ./build.sh --frontend      frontend only, no Rust (quick check of the bundle)
#
# The order is deliberate and each step is a gate: dependencies, then types,
# then tests, then the frontend bundle, then Rust. A failure stops the build
# rather than producing an artefact nobody should install — the Rust step alone
# is minutes, so finding a type error there instead of here wastes real time.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

DEBUG=0
RUN_TESTS=1
FRONTEND_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --debug)    DEBUG=1 ;;
    --no-test)  RUN_TESTS=0 ;;
    --frontend) FRONTEND_ONLY=1 ;;
    -h|--help)  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# step/warn/die, the toolchain checks and the dependency install.
. "$HERE/scripts/lib.sh"

# ── preflight ───────────────────────────────────────────────────────────────
step "Checking the toolchain"
need_node
echo "    node $(node --version)  npm $(npm --version)"
if [ "$FRONTEND_ONLY" -eq 0 ]; then
  need_cargo
  echo "    $(cargo --version)"
  check_system_libs
fi

# ── dependencies ────────────────────────────────────────────────────────────
step "Installing dependencies"
install_deps

# ── tests ───────────────────────────────────────────────────────────────────
if [ "$RUN_TESTS" -eq 1 ]; then
  step "Running tests"
  npm test
else
  echo "    (tests skipped)"
fi

# ── frontend ────────────────────────────────────────────────────────────────
# `npm run build` is vue-tsc --noEmit && vite build: the typecheck is part of it
# on purpose, so a type error cannot reach the Rust stage.
step "Building the frontend"
npm run build
[ -f dist/index.html ] || die "dist/index.html is missing — the frontend build produced nothing"
echo "    dist: $(du -sh dist | cut -f1)"

if [ "$FRONTEND_ONLY" -eq 1 ]; then
  step "Done (frontend only)"
  exit 0
fi

# ── desktop bundle ──────────────────────────────────────────────────────────
step "Building the desktop app$([ "$DEBUG" -eq 1 ] && echo ' (debug)')"
# Stale bundles from a previous run would be reported as this build's output.
PROFILE_DIR="release"; [ "$DEBUG" -eq 1 ] && PROFILE_DIR="debug"
rm -rf "src-tauri/target/$PROFILE_DIR/bundle"

if [ "$DEBUG" -eq 1 ]; then
  npx tauri build --debug
else
  npx tauri build
fi

# ── report ──────────────────────────────────────────────────────────────────
step "Artefacts"
FOUND=0
while IFS= read -r artefact; do
  printf '    %-9s %s\n' "$(du -h "$artefact" | cut -f1)" "$artefact"
  FOUND=1
done < <(find "src-tauri/target/$PROFILE_DIR/bundle" -type f \
  \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) 2>/dev/null | sort)

[ "$FOUND" -eq 1 ] || die "the build reported success but produced no bundle"

printf '\n\033[1;32mBuilt Zinnia %s\033[0m\n' \
  "$(node -p "require('./src-tauri/tauri.conf.json').version")"
