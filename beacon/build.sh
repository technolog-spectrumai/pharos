#!/usr/bin/env bash
#
# Build Beacon, the optional server: a release binary and a .deb.
#
#   ./build.sh beacon               for this machine (x86_64 or aarch64)
#   ./build.sh beacon pi            for a Raspberry Pi (64-bit Raspberry Pi OS, aarch64)
#   ./build.sh beacon all           both
#   ./build.sh beacon pi --dry-run  print the commands, run none
#
# Output: dist/beacon/<arch>/ with the binary, the .deb, SHA256SUMS and
# build.json. A Pi build cross-compiles: it needs `gcc-aarch64-linux-gnu` and
# `rustup target add aarch64-unknown-linux-gnu` (.cargo/config.toml names the
# linker). cargo-deb is installed on first use. Install guide:
# beacon/docs/raspberry-pi.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
. "$REPO_ROOT/scripts/lib.sh"

dry=0
targets=()
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    pi|aarch64) targets+=(aarch64-unknown-linux-gnu) ;;
    host|"") targets+=(host) ;;
    all) targets+=(host aarch64-unknown-linux-gnu) ;;
    -h|--help) sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown target '$a' (host | pi | all)" ;;
  esac
done
[ ${#targets[@]} -gt 0 ] || targets=(host)

run() {
  printf '    $ %s\n' "$*"
  [ "$dry" = 1 ] || "$@"
}

host_triple="$(rustc -vV | sed -n 's/^host: //p')"
[ "$dry" = 1 ] || command -v cargo-deb >/dev/null || run cargo install cargo-deb --locked

for t in "${targets[@]}"; do
  if [ "$t" = host ]; then triple="$host_triple"; else triple="$t"; fi
  arch="${triple%%-*}"
  out="dist/beacon/$arch"
  step "Beacon for $arch ($triple)"
  if [ "$triple" != "$host_triple" ] && [ "$dry" = 0 ]; then
    command -v aarch64-linux-gnu-gcc >/dev/null \
      || die "cross-building for $arch needs gcc-aarch64-linux-gnu (sudo apt install gcc-aarch64-linux-gnu)"
    rustup target list --installed 2>/dev/null | grep -qx "$triple" \
      || run rustup target add "$triple"
  fi
  run cargo build --locked --release -p beacon --target "$triple"
  run cargo deb -p beacon --target "$triple" --no-build
  [ "$dry" = 1 ] && continue
  rm -rf "$out" && mkdir -p "$out"
  cp "target/$triple/release/beacon" "$out/"
  cp "target/$triple/debian/"beacon_*.deb "$out/"
  (cd "$out" && sha256sum beacon ./*.deb > SHA256SUMS)
  version="$(sed -n 's/^version = "\(.*\)"/\1/p' beacon/Cargo.toml | head -1)"
  cat > "$out/build.json" <<JSON
{
  "app": "beacon",
  "version": "$version",
  "target": "$triple",
  "commit": "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "built": "$(date -Is)"
}
JSON
  printf '    -> %s\n' "$out"
  ls -1 "$out" | sed 's/^/       /'
done
