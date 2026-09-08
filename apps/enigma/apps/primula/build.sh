#!/usr/bin/env bash
#
# Build the Primula desktop app.
#
#   ./build.sh                 release bundle (deb + rpm)
#   ./build.sh --debug         debug bundle — builds far faster, runs slower
#   ./build.sh --no-test       skip the test suite
#   ./build.sh --frontend      frontend only, no Rust (quick check of the bundle)
#   ./build.sh --bundles deb,rpm   which package formats to produce
#
# `--bundles` passes straight through to `tauri build --bundles`. Left off, the
# targets in src-tauri/tauri.conf.json apply, which is what a plain build has
# always done. Tauri compiles for the machine it runs on — asking a Linux host
# for a .dmg fails, it does not cross-compile.
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
BUNDLES=""
NEED_BUNDLES=0
for arg in "$@"; do
  case "$arg" in
    --debug)    DEBUG=1 ;;
    --no-test)  RUN_TESTS=0 ;;
    --frontend) FRONTEND_ONLY=1 ;;
    --bundles) NEED_BUNDLES=1 ;;
    --bundles=*) BUNDLES="${arg#*=}" ;;
    -h|--help)  sed -n '2,9p' "$HERE/build.sh" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      if [ "$NEED_BUNDLES" -eq 1 ]; then BUNDLES="$arg"; NEED_BUNDLES=0
      else echo "unknown option: $arg (try --help)" >&2; exit 2; fi ;;
  esac
done

# step/warn/die, the toolchain checks and the dependency install.
# The shared preflight lives at the REPO root, not in this app: node/cargo
# checks, the system libraries and the snap trap are identical for every app,
# and three copies would mean fixing the next toolchain problem three times.
. "$HERE/../../scripts/zinnia/lib.sh"

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
  # `--workspace`, and from the ROOT, is what reaches the crates: a `cargo test`
  # run inside src-tauri/ compiles only the app and silently skips padova's
  # doctest — the one that pins "no command returns the passphrase".
  if [ "$FRONTEND_ONLY" -eq 0 ]; then
    npm run test:rust
  fi
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

# WHERE the bundle lands is not `src-tauri/target/` any more. These apps are
# members of the repo-root cargo workspace, and a workspace shares ONE target
# directory at its root — so the artefact appears in `<repo>/target/`, not
# beside the crate. Asked rather than assumed: CARGO_TARGET_DIR wins if it is
# set (run_dev.sh sets a per-profile one), then the workspace root, then the
# old per-crate path for a checkout where this app is standalone.
if [ -n "${CARGO_TARGET_DIR:-}" ]; then
  TARGET_ROOT="$CARGO_TARGET_DIR"
elif [ -f "$HERE/../../Cargo.toml" ] && grep -q '^\[workspace\]' "$HERE/../../Cargo.toml"; then
  TARGET_ROOT="$HERE/../../target"
else
  TARGET_ROOT="$HERE/src-tauri/target"
fi
BUNDLE_DIR="$TARGET_ROOT/$PROFILE_DIR/bundle"
rm -rf "$BUNDLE_DIR"

BUNDLE_ARGS=()
[ -n "$BUNDLES" ] && BUNDLE_ARGS=(--bundles "$BUNDLES")

if [ "$DEBUG" -eq 1 ]; then
  npx tauri build --debug "${BUNDLE_ARGS[@]}"
else
  npx tauri build "${BUNDLE_ARGS[@]}"
fi

# ── report ──────────────────────────────────────────────────────────────────
step "Artefacts"
FOUND=0
while IFS= read -r artefact; do
  printf '    %-9s %s\n' "$(du -h "$artefact" | cut -f1)" "$artefact"
  FOUND=1
done < <(find "$BUNDLE_DIR" -type f \
  \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) 2>/dev/null | sort)

[ "$FOUND" -eq 1 ] || die "the build reported success but produced no bundle"

# The product name comes from the config, not from a copy in this script —
# all three of these were cloned and all three said "Zinnia".
printf '\n\033[1;32mBuilt %s %s\033[0m\n' \
  "$(node -p "require('./src-tauri/tauri.conf.json').productName")" \
  "$(node -p "require('./src-tauri/tauri.conf.json').version")"
