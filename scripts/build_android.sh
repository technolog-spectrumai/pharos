#!/usr/bin/env bash
# Builds the Enigma Tauri app for Android (APK + AAB).
# Must be run from inside enigma/enigma/ (the directory with package.json).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENIGMA_DIR="$(realpath "${SCRIPT_DIR}/../enigma")"
REPO_ROOT="$(realpath "${SCRIPT_DIR}/../..")"

# ── Env checks ────────────────────────────────────────────────────────────────

require_env() {
  if [[ -z "${!1:-}" ]]; then
    echo "ERROR: ${1} is not set. Source ~/.bashrc or run install_android_studio.sh first."
    exit 1
  fi
}

require_env ANDROID_HOME
require_env NDK_HOME
require_env JAVA_HOME

echo "==> Environment"
echo "  ANDROID_HOME : ${ANDROID_HOME}"
echo "  NDK_HOME     : ${NDK_HOME}"
echo "  JAVA_HOME    : ${JAVA_HOME}"
echo "  Node         : $(node --version)"
echo "  Rust         : $(rustc --version)"

# ── Parse args ────────────────────────────────────────────────────────────────

BUILD_TYPE="${1:-debug}"   # debug | release
if [[ "${BUILD_TYPE}" != "debug" && "${BUILD_TYPE}" != "release" ]]; then
  echo "Usage: $0 [debug|release]"
  exit 1
fi

echo ""
echo "==> Building Enigma for Android (${BUILD_TYPE})"

# ── Build rotor_wasm (WASM dependency used by the Vue frontend) ───────────────

ROTOR_WASM_DIR="${REPO_ROOT}/toto/rotors/rotor_wasm"
if [[ -d "${ROTOR_WASM_DIR}" ]]; then
  echo "==> Building rotor_wasm"
  pushd "${ROTOR_WASM_DIR}" > /dev/null
  if command -v wasm-pack &>/dev/null; then
    wasm-pack build --target bundler --out-dir build
  else
    echo "  wasm-pack not found — skipping rotor_wasm build (use pre-built build/ dir)"
  fi
  popd > /dev/null
fi

# ── npm install ────────────────────────────────────────────────────────────────

echo "==> Installing npm dependencies"
cd "${ENIGMA_DIR}"
npm install

# ── Initialize Android target (idempotent) ────────────────────────────────────

if [[ ! -d "${ENIGMA_DIR}/src-tauri/gen/android" ]]; then
  echo "==> Initializing Tauri Android target"
  npx tauri android init
else
  echo "==> Android gen directory already exists — skipping init"
fi

# ── Build ─────────────────────────────────────────────────────────────────────

if [[ "${BUILD_TYPE}" == "release" ]]; then
  echo "==> Building release APK + AAB"
  npx tauri android build --apk --aab
else
  echo "==> Building debug APK"
  npx tauri android build --debug --apk
fi

# ── Output ────────────────────────────────────────────────────────────────────

GEN_DIR="${ENIGMA_DIR}/src-tauri/gen/android"
echo ""
echo "==> Build complete. Artifacts:"
find "${GEN_DIR}" \( -name "*.apk" -o -name "*.aab" \) 2>/dev/null | while read -r f; do
  echo "  ${f}"
done
