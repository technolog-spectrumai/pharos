#!/usr/bin/env bash
# Patches Cargo.toml to remove Linux-only dependencies before Android build.
# Android uses WebView from the OS — webkit2gtk is not needed and won't compile.
# Run from the repo root or enigma/enigma directory.
set -euo pipefail

CARGO_TOML="$(dirname "$0")/../enigma/src-tauri/Cargo.toml"
CARGO_TOML="$(realpath "${CARGO_TOML}")"

if [[ ! -f "${CARGO_TOML}" ]]; then
  echo "ERROR: Could not find ${CARGO_TOML}"
  exit 1
fi

echo "==> Checking ${CARGO_TOML}"

# Tauri 2 handles the linux-only webkit2gtk block correctly when the target is
# cfg(target_os = "linux"), so no patching is needed for that — cargo will skip
# it automatically when cross-compiling to Android.

# Verify cpal is present (audio recording) — Android needs the oboe feature.
if grep -q 'cpal' "${CARGO_TOML}"; then
  echo "  cpal found — for Android audio, consider adding oboe backend:"
  echo '    cpal = { version = "0.15", features = ["oboe-shared-stdcxx"] }'
  echo "  Edit ${CARGO_TOML} manually if voice recording is required on Android."
fi

echo ""
echo "No automatic patches required. Cargo target guards handle platform deps."
echo "Cargo.toml location: ${CARGO_TOML}"
