#!/usr/bin/env bash
# Builds a Tauri workspace app for Android (APK + AAB).
#
#   bash scripts/build_android.sh <app> [debug|release] [abi-spec]
#
#   <app>      enigma  (any dir under apps/ with a src-tauri/)
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

GEN_DIR="${APP_DIR}/src-tauri/gen/android"
KEYSTORE_PROPS="${GEN_DIR}/keystore.properties"

# ── Release signing pre-flight ────────────────────────────────────────────────
#
# gen/android/app/build.gradle.kts is the authority and fails the build closed
# on its own. This is the same check run early, because by the time Gradle sees
# the task graph the frontend has already been rebuilt — no reason to spend
# that to learn there is no key. Keep the two in step (the Python mirror lives
# in tools/enigma_builder/signing.py).

prop_value() {  # prop_value <key> — value from keystore.properties, or ""
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" \
    "${KEYSTORE_PROPS}" 2>/dev/null | tail -1 | sed 's/[[:space:]]*$//'
}

resolve_store_file() {  # absolute path of storeFile, resolved like Gradle does
  local raw="$1"
  case "${raw}" in
    "~/"*) echo "${HOME}/${raw#\~/}" ;;
    /*)    echo "${raw}" ;;
    *)     echo "${GEN_DIR}/${raw}" ;;
  esac
}

signing_preflight() {
  if [[ ! -f "${KEYSTORE_PROPS}" ]]; then
    cat >&2 <<EOF

ERROR: release signing is not configured — refusing to build an unsigned release.

  ${KEYSTORE_PROPS} does not exist.

  Copy the template beside it and fill in the four keys:
    cp ${GEN_DIR}/keystore.properties.example ${KEYSTORE_PROPS}
    \$EDITOR ${KEYSTORE_PROPS}     # storeFile, storePassword, keyAlias, keyPassword

  Need a keystore? Generate one once, and back it up — losing it means never
  being able to update the published app:
    keytool -genkeypair -v -keystore enigma-release.jks -alias enigma \\
      -keyalg RSA -keysize 4096 -validity 10000

  keystore.properties is gitignored; never commit it or the keystore it names.
  Debug builds need none of this: $0 ${APP} debug

EOF
    exit 1
  fi

  local missing=()
  local key
  for key in storeFile storePassword keyAlias keyPassword; do
    if [[ -z "$(prop_value "${key}")" ]]; then
      missing+=("${key}")
    fi
  done
  if (( ${#missing[@]} )); then
    echo "" >&2
    echo "ERROR: ${KEYSTORE_PROPS} is missing: ${missing[*]}" >&2
    echo "       All of storeFile, storePassword, keyAlias, keyPassword are required." >&2
    echo "" >&2
    exit 1
  fi

  local raw_store alias store
  raw_store="$(prop_value storeFile)"
  alias="$(prop_value keyAlias)"
  store="$(resolve_store_file "${raw_store}")"

  if [[ "${alias}" == "androiddebugkey" || "$(basename "${store}")" == "debug.keystore" \
        || "${store}" == "${HOME}/.android/debug.keystore" ]]; then
    cat >&2 <<EOF

ERROR: ${KEYSTORE_PROPS} points at the Android DEBUG key.
       storeFile = ${raw_store}
       keyAlias  = ${alias}

  The debug key ships with the Android SDK and its password is publicly known,
  so it must NEVER sign a release: an APK signed with it can never be updated
  by a real release, and anyone can forge an update for it.

  Generate a release keystore and point storeFile at that instead.

EOF
    exit 1
  fi

  if [[ ! -f "${store}" ]]; then
    echo "" >&2
    echo "ERROR: storeFile '${raw_store}' does not exist (resolved to ${store})." >&2
    echo "" >&2
    exit 1
  fi

  echo "==> Release signing: ${store} (alias '${alias}')"
}

if [[ "${BUILD_TYPE}" == "release" ]]; then
  signing_preflight
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

echo ""
echo "==> Build complete. Artifacts:"
find "${GEN_DIR}" \( -name "*.apk" -o -name "*.aab" \) 2>/dev/null | while read -r f; do
  echo "  ${f}"
done

# ── Signature check ───────────────────────────────────────────────────────────
#
# The build type says what was *asked* for; only the artifact says what was
# produced. A release that came out unsigned is a failure, not a build with a
# caveat — say so and exit non-zero, so no caller reads the line above as
# "shippable".

find_apksigner() {
  if command -v apksigner >/dev/null 2>&1; then
    command -v apksigner
    return 0
  fi
  local tools="${ANDROID_HOME}/build-tools" version
  # Newest stable first; a pre-release ("36.1.0-rc1") only if it is all there is.
  for version in $(ls -1 "${tools}" 2>/dev/null | grep -v -- '-' | sort -Vr) \
                 $(ls -1 "${tools}" 2>/dev/null | grep -- '-' | sort -Vr); do
    if [[ -x "${tools}/${version}/apksigner" ]]; then
      echo "${tools}/${version}/apksigner"
      return 0
    fi
  done
  return 1
}

if [[ "${BUILD_TYPE}" == "release" ]]; then
  echo ""
  echo "==> Verifying release signatures"

  APKSIGNER="$(find_apksigner || true)"
  UNSIGNED=0
  CHECKED=0

  while read -r artifact; do
    [[ -z "${artifact}" ]] && continue
    CHECKED=$((CHECKED + 1))
    case "${artifact}" in
      *.apk)
        if [[ -z "${APKSIGNER}" ]]; then
          echo "  UNVERIFIED  $(basename "${artifact}") — apksigner not found" >&2
          echo "              (install Android build tools, or check by hand)" >&2
          UNSIGNED=1
        elif signer="$("${APKSIGNER}" verify --print-certs "${artifact}" 2>&1 \
                        | sed -n 's/^Signer #1 certificate DN: //p')" \
             && [[ -n "${signer}" ]]; then
          echo "  SIGNED      $(basename "${artifact}")"
          echo "              signer: ${signer}"
          if [[ "${signer}" == *"CN=Android Debug"* ]]; then
            echo "  DEBUG KEY   ${artifact} is signed with the SDK debug key!" >&2
            UNSIGNED=1
          fi
        else
          echo "  UNSIGNED    $(basename "${artifact}")" >&2
          UNSIGNED=1
        fi
        ;;
      *.aab)
        # apksigner does not read app bundles; a signed .aab is jar-signed.
        if command -v jarsigner >/dev/null 2>&1 \
           && jarsigner -verify "${artifact}" 2>/dev/null | grep -q "jar verified"; then
          echo "  SIGNED      $(basename "${artifact}")"
        else
          echo "  UNSIGNED    $(basename "${artifact}")" >&2
          UNSIGNED=1
        fi
        ;;
    esac
  done < <(find "${GEN_DIR}/app/build/outputs" \
             \( -path "*release*" -name "*.apk" \) -o -name "*.aab" 2>/dev/null)

  if (( CHECKED == 0 )); then
    echo "" >&2
    echo "ERROR: the release build produced no APK or AAB to verify." >&2
    exit 1
  fi

  if (( UNSIGNED )); then
    cat >&2 <<EOF

ERROR: at least one release artifact is NOT properly signed.

  An unsigned APK installs nowhere and a debug-signed one can never be updated
  by a real release. Check ${KEYSTORE_PROPS} and the signingConfig in
  ${GEN_DIR}/app/build.gradle.kts, then rebuild.

EOF
    exit 1
  fi

  echo ""
  echo "==> Release build is SIGNED (${CHECKED} artifact(s) verified)."
else
  echo ""
  echo "==> Debug build — signed with the Android SDK debug key."
  echo "    Debug-signed APKs install on a device but are NOT releasable:"
  echo "    build with 'release' for a properly signed artifact."
fi
