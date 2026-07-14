#!/usr/bin/env bash
# One-click rotor WASM build: compiles cryptorotor/rotor_wasm with wasm-pack for
# both consumer targets — the same recipe as the `rotor:wasm` CI job.
#
#   ./build_wasm.sh              # web + bundler targets
#   ./build_wasm.sh web          # only the web target
#   ./build_wasm.sh bundler      # only the bundler target
#
# Output:
#   cryptorotor/rotor_wasm/build_web/  (web     — Django-style static consumers)
#   cryptorotor/rotor_wasm/build/      (bundler — `rotor_wasm` file: npm dep)
#
# In CI these directories are published as the `rotor:wasm` job artifact, which
# the toto repo consumes instead of building its own rotors copy (todo.md #1).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/cryptorotor/rotor_wasm"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "ERROR: wasm-pack not found. Install it with:" >&2
  echo "  curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh" >&2
  exit 1
fi
rustup target list --installed | grep -q '^wasm32-unknown-unknown$' \
  || rustup target add wasm32-unknown-unknown

TARGET="${1:-both}"
case "$TARGET" in
  web|both)     echo "==> wasm-pack build --target web" ;;
  bundler) ;;
  *) echo "usage: $0 [web|bundler|both]" >&2; exit 1 ;;
esac

if [[ "$TARGET" == "web" || "$TARGET" == "both" ]]; then
  wasm-pack build --target web --out-dir build_web
fi
if [[ "$TARGET" == "bundler" || "$TARGET" == "both" ]]; then
  echo "==> wasm-pack build --target bundler"
  wasm-pack build --target bundler --out-dir build
fi

echo "==> Done. Packages:"
ls -d "$PWD"/build_web "$PWD"/build 2>/dev/null || true
