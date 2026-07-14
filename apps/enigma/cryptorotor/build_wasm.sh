#!/usr/bin/env bash
# One-click rotor WASM build: compiles rotor_wasm with wasm-pack for both
# consumer targets. The `rotor:wasm` CI job runs this same script, so a local
# run and a CI artifact are byte-for-byte the same recipe.
#
#   ./build_wasm.sh              # web + bundler targets
#   ./build_wasm.sh web          # only the web target
#   ./build_wasm.sh bundler      # only the bundler target
#
# Output:
#   rotor_wasm/build_web/  (web     — static <script>/import consumers, e.g.
#                           toto's telegraph static dir via its deploy.py sync)
#   rotor_wasm/build/      (bundler — `rotor_wasm` file: npm dep consumers)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/rotor_wasm"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "ERROR: wasm-pack not found. Install it with:" >&2
  echo "  curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh" >&2
  exit 1
fi
rustup target list --installed | grep -q '^wasm32-unknown-unknown$' \
  || rustup target add wasm32-unknown-unknown

TARGET="${1:-both}"
case "$TARGET" in
  web|bundler|both) ;;
  *) echo "usage: $0 [web|bundler|both]" >&2; exit 1 ;;
esac

if [[ "$TARGET" == "web" || "$TARGET" == "both" ]]; then
  echo "==> wasm-pack build --target web"
  wasm-pack build --target web --out-dir build_web
fi
if [[ "$TARGET" == "bundler" || "$TARGET" == "both" ]]; then
  echo "==> wasm-pack build --target bundler"
  wasm-pack build --target bundler --out-dir build
fi

echo "==> Done. Packages:"
ls -d "$PWD"/build_web "$PWD"/build 2>/dev/null || true
