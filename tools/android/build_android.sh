#!/usr/bin/env bash
# Builds a Tauri workspace app for Android (APK + AAB).
#
# Normally reached through ./build.sh, from a variant's `android:` in apps/<app>/dromon.yaml. By hand,
# from the app repo's root:
#
#   bash tools/android/build_android.sh <app> [debug|release] [abi-spec] [--features=a,b]
#
#   <app>      enigma | morion  (any dir under apps/ with a src-tauri/)
#   build type debug (default) | release
#   abi-spec   comma-separated ABIs, or "all".  Default: aarch64
#              valid ABIs: aarch64 (modern phones) · x86_64 (emulator) ·
#                          armv7 (old 32-bit phones) · i686 (32-bit emulator)
#
# Examples:
#   build_android.sh enigma release aarch64,x86_64
#   build_android.sh enigma debug
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Parse args ────────────────────────────────────────────────────────────────

APP="${1:-}"
if [[ -z "${APP}" ]]; then
  echo "Usage: $0 <app> [debug|release] [abi-spec]" >&2
  echo "  e.g. $0 enigma release aarch64,x86_64" >&2
  exit 1
fi

# The repo root, two levels above this script.
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
APP_DIR="$(realpath "${REPO_ROOT}/apps/${APP}" 2>/dev/null || true)"
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

# Flags after the three positionals. Unknown arguments are REJECTED: a mistyped
# --allow-unsignd silently ignored as an unused $4 would be the worst possible
# failure mode for exactly this feature.
ALLOW_UNSIGNED=0
FEATURE_ARGS=()
shift $(( $# < 3 ? $# : 3 ))
for arg in "$@"; do
  case "${arg}" in
    --allow-unsigned-release)
      ALLOW_UNSIGNED=1
      ;;
    --features=*)
      # The app's build-feature allowlist, from its build config. Cargo gets
      # exactly this list; the frontend gets it from <APP>_FEATURES, which
      # Dromon has already put in the environment.
      FEATURE_ARGS=(--features "${arg#--features=}")
      ;;
    --signed)
      # The default for release; accepted so intent can be explicit.
      ;;
    *)
      echo "ERROR: unknown argument '${arg}'" >&2
      echo "  known: --allow-unsigned-release, --signed, --features=LIST" >&2
      exit 1
      ;;
  esac
done

if [[ "${ALLOW_UNSIGNED}" == "1" && "${BUILD_TYPE}" != "release" ]]; then
  echo "ERROR: --allow-unsigned-release only applies to a release build" >&2
  echo "  (debug builds are always signed with the SDK debug key)" >&2
  exit 1
fi

# Map friendly ABI names → Tauri --target flags. "all" → no flag (Tauri builds
# every installed ABI). Otherwise build a repeated "--target X --target Y" list.
TAURI_TARGET=()
# The Rust targets those are, for the native-library hook below.
RUST_TARGETS=()
rust_target() {
  case "$1" in
    aarch64) echo aarch64-linux-android ;;
    x86_64)  echo x86_64-linux-android ;;
    armv7)   echo armv7-linux-androideabi ;;
    i686)    echo i686-linux-android ;;
  esac
}
if [[ "${ABI_SPEC}" != "all" ]]; then
  IFS=',' read -ra _abis <<< "${ABI_SPEC}"
  for abi in "${_abis[@]}"; do
    case "${abi}" in
      aarch64|x86_64|armv7|i686)
        TAURI_TARGET+=(--target "${abi}")
        RUST_TARGETS+=("$(rust_target "${abi}")")
        ;;
      *) echo "ERROR: unknown ABI '${abi}' (use aarch64|x86_64|armv7|i686|all)" >&2; exit 1 ;;
    esac
  done
else
  for abi in aarch64 armv7 i686 x86_64; do RUST_TARGETS+=("$(rust_target "${abi}")"); done
fi

# ── Env auto-detection ────────────────────────────────────────────────────────

# Source ~/.bashrc so env vars set by install_android_studio.sh are available
# when the script is invoked directly (not from an interactive shell).
# shellcheck disable=SC1090
# Under `set -u` a stock ~/.bashrc dies on its first line ("PS1: unbound
# variable"), so it is read with -u off.
set +u
[[ -f "${HOME}/.bashrc" ]] && source "${HOME}/.bashrc" || true
set -u

# The unsigned-release opt-in travels to Gradle as a project property via
# ORG_GRADLE_PROJECT_*. Unconditionally unset AFTER sourcing ~/.bashrc: an
# export lurking there would otherwise disarm the fail-closed gate with no
# trace in any command line. Re-exported below only from the parsed flag.
unset ORG_GRADLE_PROJECT_enigmaAllowUnsignedRelease

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

GEN_DIR="${APP_DIR}/src-tauri/gen/android"
KEYSTORE_PROPS="${GEN_DIR}/keystore.properties"

# ── Release signing pre-flight ────────────────────────────────────────────────
#
# gen/android/app/build.gradle.kts is the authority and fails the build closed
# on its own. This runs the same check early, because by the time Gradle sees
# the task graph the frontend has already been rebuilt — no reason to spend
# that to learn there is no key. One implementation, not two: the check IS
# android_signing/signing.py beside this script (stdlib-only), so nothing here re-parses
# keystore.properties. `env -u` scrubs the vars a caller that carries its own
# Python leaks into its children, which would otherwise poison the system one.

SIGNING_CLI="${SCRIPT_DIR}/android_signing/signing_cli.py"

run_signing_cli() {  # run_signing_cli <action> [args…]
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: release builds need python3 for the signing checks" >&2
    echo "  (debug builds do not: ${0##*/} ${APP} debug)" >&2
    exit 1
  fi
  env -u LD_LIBRARY_PATH -u PYTHONHOME -u PYTHONPATH \
    python3 "${SIGNING_CLI}" "$@"
}

if [[ "${BUILD_TYPE}" == "release" && "${ALLOW_UNSIGNED}" != "1" ]]; then
  run_signing_cli status --gen "${GEN_DIR}" || {
    echo "" >&2
    echo "Release signing is not configured — refusing to build an unsigned release." >&2
    echo "  For an installable-nowhere internal artifact: add --allow-unsigned-release" >&2
    echo "Debug builds are unaffected: ${0##*/} ${APP} debug" >&2
    exit 1
  }
elif [[ "${BUILD_TYPE}" == "release" ]]; then
  echo "==> UNSIGNED RELEASE requested (--allow-unsigned-release)"
  echo "    The artifact will install nowhere and must never be distributed."
  export ORG_GRADLE_PROJECT_enigmaAllowUnsignedRelease=true
fi

# ── Native libraries the app's crates need (generic hook) ────────────────────
#
# A workspace crate that needs native code cross-compiled for Android ships
# crates/<crate>/android/env.sh (limonite: static Tesseract). When that crate
# is in this app's dependency graph for Android, the file is sourced here with
# the Rust targets being built as arguments, before Tauri runs cargo. It builds
# what is missing and exports target-suffixed variables only
# (PKG_CONFIG_PATH_aarch64_linux_android, ...), so desktop builds never see
# them. ANDROID_APP_CARGO_TREE holds the app's `cargo tree -e features` for the
# first target, so a hook can return early when the feature needing it is off.
# apps/<app>/android-env.sh, if present, is sourced the same way. An app that
# uses none of this only pays for one `cargo tree`.

ANDROID_APP_CARGO_TREE="$(cd "${APP_DIR}/src-tauri" && cargo tree --target "${RUST_TARGETS[0]}" \
    -e features,normal --prefix none "${FEATURE_ARGS[@]}" 2>/dev/null)" || {
  echo "WARNING: 'cargo tree' failed; looking for workspace crates in src-tauri/Cargo.toml instead" >&2
  ANDROID_APP_CARGO_TREE=""
}
for _hook in "${REPO_ROOT}"/crates/*/android/env.sh; do
  [[ -f "${_hook}" ]] || continue
  _crate_dir="$(dirname "$(dirname "${_hook}")")"
  _crate="$(awk -F'"' '/^name *=/ { print $2; exit }' "${_crate_dir}/Cargo.toml" 2>/dev/null || true)"
  [[ -n "${_crate}" ]] || continue
  if [[ -n "${ANDROID_APP_CARGO_TREE}" ]]; then
    grep -q "^${_crate} v" <<< "${ANDROID_APP_CARGO_TREE}" || continue
  else
    grep -qw -- "${_crate}" "${APP_DIR}/src-tauri/Cargo.toml" || continue
  fi
  echo "==> Native libraries: ${_hook#"${REPO_ROOT}/"} ${RUST_TARGETS[*]}"
  # shellcheck disable=SC1090
  source "${_hook}" "${RUST_TARGETS[@]}"
done
if [[ -f "${APP_DIR}/android-env.sh" ]]; then
  echo "==> Native libraries: apps/${APP}/android-env.sh ${RUST_TARGETS[*]}"
  # shellcheck disable=SC1090,SC1091
  source "${APP_DIR}/android-env.sh" "${RUST_TARGETS[@]}"
fi
unset ANDROID_APP_CARGO_TREE _hook _crate_dir _crate

# ── Build ─────────────────────────────────────────────────────────────────────
# A debug APK without Rust debug symbols: about 58 MB instead of 180 MB, and the
# app behaves the same. ENIGMA_KEEP_DEBUG_SYMBOLS=1 keeps them (for a debugger).
if [[ "${BUILD_TYPE}" == "debug" && "${ENIGMA_KEEP_DEBUG_SYMBOLS:-0}" != "1" ]]; then
  export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_STRIP=symbols
fi
# Maven Central rate-limits some machines (HTTP 429). Gradle fetches through
# Google's mirror of it instead (tools/android/gradle/maven-mirror.gradle).
GRADLE_INIT_DIR="${GRADLE_USER_HOME:-$HOME/.gradle}/init.d"
mkdir -p "${GRADLE_INIT_DIR}"
cp "${SCRIPT_DIR}/gradle/maven-mirror.gradle" "${GRADLE_INIT_DIR}/maven-mirror.gradle"

if [[ "${BUILD_TYPE}" == "release" ]]; then
  echo "==> Building release APK + AAB"
  npx tauri android build --apk --aab "${TAURI_TARGET[@]}" "${FEATURE_ARGS[@]}"
else
  echo "==> Building debug APK"
  npx tauri android build --debug --apk "${TAURI_TARGET[@]}" "${FEATURE_ARGS[@]}"
fi

# ── Output ────────────────────────────────────────────────────────────────────

echo ""
echo "==> Build complete. Artifacts:"
find "${GEN_DIR}" \( -name "*.apk" -o -name "*.aab" \) 2>/dev/null | while read -r f; do
  echo "  ${f}"
done

# ── Signature check ───────────────────────────────────────────────────────────
#
# The build type says what was ASKED for; only the artifact says what was
# PRODUCED. One implementation (signing_cli.py verify): classification, the
# identity report (package, version, signer, SHA-256 fingerprint), and the
# never-debug-signed rule for releases all live there.

if [[ "${BUILD_TYPE}" == "release" ]]; then
  VERIFY_FLAGS=()
  if [[ "${ALLOW_UNSIGNED}" == "1" ]]; then
    VERIFY_FLAGS+=(--allow-unsigned)
  fi
  echo ""
  PIN_FILE="${APP_DIR}/deploy/android-release-key.properties"
  run_signing_cli verify --gen "${GEN_DIR}" --build-type release \
      --pin "${PIN_FILE}" "${VERIFY_FLAGS[@]}" || {
    echo "" >&2
    echo "ERROR: the release build did not produce properly signed artifacts." >&2
    exit 1
  }
else
  echo ""
  echo "==> Debug build — signed with the Android SDK debug key."
  echo "    Debug-signed APKs install on a device but are NOT releasable:"
  echo "    build with 'release' for a properly signed artifact."
fi
