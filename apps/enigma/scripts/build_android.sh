#!/usr/bin/env bash
# Builds a Tauri workspace app for Android (APK + AAB).
#
#   bash scripts/build_android.sh <app> [debug|release] [abi-spec]
#
#   <app>      enigma | aurora  (any dir under apps/ with a src-tauri/)
#   build type debug (default) | release
#   abi-spec   comma-separated ABIs, or "all".  Default: aarch64
#              valid ABIs: aarch64 (modern phones) · x86_64 (emulator) ·
#                          armv7 (old 32-bit phones) · i686 (32-bit emulator)
#
# Examples:
#   build_android.sh enigma release aarch64,x86_64
#   build_android.sh aurora debug
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Parse args ────────────────────────────────────────────────────────────────

APP="${1:-}"
if [[ -z "${APP}" ]]; then
  echo "Usage: $0 <app> [debug|release] [abi-spec]" >&2
  echo "  e.g. $0 enigma release aarch64,x86_64" >&2
  exit 1
fi

APP_DIR="$(realpath "${SCRIPT_DIR}/../apps/${APP}" 2>/dev/null || true)"
if [[ -z "${APP_DIR}" || ! -d "${APP_DIR}/src-tauri" ]]; then
  echo "ERROR: no Tauri app '${APP}' under apps/ (expected ${APP_DIR}/src-tauri)" >&2
  exit 1
fi

BUILD_TYPE="${2:-debug}"   # debug | release
ABI_SPEC="${3:-aarch64}"   # comma list, or "all"

if [[ "${BUILD_TYPE}" != "debug" && "${BUILD_TYPE}" != "release" ]]; then
  echo "ERROR: build type must be 'debug' or 'release' (got '${BUILD_TYPE}')" >&2
  exit 1
fi

# Map friendly ABI names → Tauri --target flags. "all" → no flag (Tauri builds
# every installed ABI). Otherwise build a repeated "--target X --target Y" list.
TAURI_TARGET=()
if [[ "${ABI_SPEC}" != "all" ]]; then
  IFS=',' read -ra _abis <<< "${ABI_SPEC}"
  for abi in "${_abis[@]}"; do
    case "${abi}" in
      aarch64|x86_64|armv7|i686) TAURI_TARGET+=(--target "${abi}") ;;
      *) echo "ERROR: unknown ABI '${abi}' (use aarch64|x86_64|armv7|i686|all)" >&2; exit 1 ;;
    esac
  done
fi

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

# NDK_HOME: pick the highest installed NDK if not set
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
echo "  App          : ${APP}  (${APP_DIR})"
echo "  Build type   : ${BUILD_TYPE}"
echo "  ABIs         : ${ABI_SPEC}"
echo "  ANDROID_HOME : ${ANDROID_HOME}"
echo "  NDK_HOME     : ${NDK_HOME}"
echo "  JAVA_HOME    : ${JAVA_HOME}"
echo "  Node         : $(node --version)"
echo "  Rust         : $(rustc --version)"

# ── npm install ────────────────────────────────────────────────────────────────

echo "==> Installing npm dependencies"
cd "${APP_DIR}"
npm install

# ── Initialize Android target (idempotent) ────────────────────────────────────

if [[ ! -d "${APP_DIR}/src-tauri/gen/android" ]]; then
  echo "==> Initializing Tauri Android target"
  npx tauri android init
else
  echo "==> Android gen directory already exists — skipping init"
fi

# ── Build ─────────────────────────────────────────────────────────────────────

if [[ "${BUILD_TYPE}" == "release" ]]; then
  echo "==> Building release APK + AAB"
  npx tauri android build --apk --aab "${TAURI_TARGET[@]}"
else
  echo "==> Building debug APK"
  npx tauri android build --debug --apk "${TAURI_TARGET[@]}"
fi

# ── Output ────────────────────────────────────────────────────────────────────

GEN_DIR="${APP_DIR}/src-tauri/gen/android"
echo ""
echo "==> Build complete. Artifacts:"
find "${GEN_DIR}" \( -name "*.apk" -o -name "*.aab" \) 2>/dev/null | while read -r f; do
  echo "  ${f}"
done
