#!/usr/bin/env bash
# Adds Android cross-compilation targets to Rust and installs cargo-ndk
set -euo pipefail

ANDROID_TARGETS=(
  "aarch64-linux-android"    # ARM64 — modern phones (required)
  "armv7-linux-androideabi"  # ARMv7 — older 32-bit phones
  "x86_64-linux-android"    # x86_64 — emulator
  "i686-linux-android"       # x86 — 32-bit emulator
)

echo "==> Adding Android Rust targets"
for TARGET in "${ANDROID_TARGETS[@]}"; do
  echo "  rustup target add ${TARGET}"
  rustup target add "${TARGET}"
done

echo "==> Installing cargo-ndk"
cargo install cargo-ndk

echo "==> Verifying NDK_HOME"
if [[ -z "${NDK_HOME:-}" ]]; then
  echo "WARNING: NDK_HOME is not set. Set it in your shell profile:"
  echo '  export NDK_HOME="${HOME}/Android/Sdk/ndk/27.2.12479018"'
else
  echo "  NDK_HOME=${NDK_HOME}"
fi

echo ""
echo "Rust Android targets ready."
rustup target list --installed | grep android
