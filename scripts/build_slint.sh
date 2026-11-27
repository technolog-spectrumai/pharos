#!/usr/bin/env bash
# The Slint apps (b2): release binary and an Ubuntu .deb (cargo-deb) in dist/<app>/.
#   scripts/build_slint.sh enigma27 | lighthouse | combo [--dry-run]
# Called by ./build.sh enigma27 | lighthouse | combo. Not a Dromon app (no npm).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  enigma27) pkg=enigma27 ;;
  lighthouse) pkg=pharos-lighthouse ;;
  combo) pkg=enigma27-combo ;;
  *) echo "usage: $0 enigma27|lighthouse|combo [--dry-run]" >&2; exit 2 ;;
esac
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1
out="$REPO_ROOT/dist/$pkg"
run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }
cd "$REPO_ROOT"
run cargo build --release -p "$pkg"
if command -v cargo-deb >/dev/null; then
  run mkdir -p "$out"
  run cargo deb --no-build -p "$pkg" -o "$out/"
  [ "$DRY" = 1 ] || (cd "$out" && sha256sum ./*.deb > SHA256SUMS)
else
  echo "cargo-deb not installed (cargo install cargo-deb): binary only, target/release/$pkg" >&2
fi
