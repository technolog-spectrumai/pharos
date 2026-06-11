#!/usr/bin/env bash
# Builds the Enigma Tauri app for Android (APK + AAB).
# Must be run from inside apps/enigma/ (the directory with package.json).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENIGMA_DIR="$(realpath "${SCRIPT_DIR}/../apps/enigma")"
REPO_ROOT="$(realpath "${SCRIPT_DIR}/../..")"

# ── Env auto-detection ────────────────────────────────────────────────────────

# Source ~/.bashrc so env vars set by install_android_studio.sh are available
# when the script is invoked directly (not from an interactive shell).
# shellcheck disable=SC1090
[[ -f "${HOME}/.bashrc" ]] && source "${HOME}/.bashrc" || true

# JAVA_HOME: fall back to the openjdk-17 path if not set
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in \
    /usr/lib/jvm/java-17-openjdk-amd64 \
    /usr/lib/jvm/java-17-openjdk \
    /usr/lib/jvm/temurin-17-amd64; do
    if [[ -d "${candidate}" ]]; then
      export JAVA_HOME="${candidate}"
      break
    fi
  done
fi

# ANDROID_HOME: default install location used by install_android_studio.sh
if [[ -z "${ANDROID_HOME:-}" ]]; then
  export ANDROID_HOME="${HOME}/Android/Sdk"
fi

# NDK_HOME: pick the first installed NDK if not set
if [[ -z "${NDK_HOME:-}" ]]; then
  NDK_DIR="${ANDROID_HOME}/ndk"
  if [[ -d "${NDK_DIR}" ]]; then
    NDK_VER=$(ls "${NDK_DIR}" | sort -V | tail -1)
    [[ -n "${NDK_VER}" ]] && export NDK_HOME="${NDK_DIR}/${NDK_VER}"
  fi
fi

export PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"

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
TARGET="${2:-aarch64}"    # aarch64 (physical ARM64 device) | x86_64 (emulator)

if [[ "${BUILD_TYPE}" != "debug" && "${BUILD_TYPE}" != "release" ]]; then
  echo "Usage: $0 [debug|release] [aarch64|x86_64|armv7|all]"
  echo "  aarch64  — modern physical Android device (default)"
  echo "  x86_64   — Android emulator"
  echo "  armv7    — older 32-bit physical device"
  echo "  all      — all four ABIs (slow, ~4× disk space)"
  exit 1
fi

# Map friendly name to Tauri's --target flag value
case "${TARGET}" in
  aarch64) TAURI_TARGET="--target aarch64" ;;
  x86_64)  TAURI_TARGET="--target x86_64" ;;
  armv7)   TAURI_TARGET="--target armv7" ;;
  all)     TAURI_TARGET="" ;;
  *)
    echo "Unknown target '${TARGET}'. Use: aarch64 | x86_64 | armv7 | all"
    exit 1
  ;;
esac

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

echo "  Target ABI   : ${TARGET}"

if [[ "${BUILD_TYPE}" == "release" ]]; then
  echo "==> Building release APK + AAB"
  # shellcheck disable=SC2086
  npx tauri android build --apk --aab ${TAURI_TARGET}
else
  echo "==> Building debug APK"
  # shellcheck disable=SC2086
  npx tauri android build --debug --apk ${TAURI_TARGET}
fi

# ── Output ────────────────────────────────────────────────────────────────────

GEN_DIR="${ENIGMA_DIR}/src-tauri/gen/android"
echo ""
echo "==> Build complete. Artifacts:"
find "${GEN_DIR}" \( -name "*.apk" -o -name "*.aab" \) 2>/dev/null | while read -r f; do
  echo "  ${f}"
done
