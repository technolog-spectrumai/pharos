#!/usr/bin/env bash
# Build this app's deployment artifacts and collect them into deploy/dist/.
# The app name is derived from this script's location (apps/<app>/deploy/),
# so the same script is dropped into each app's deploy/ dir.
#
#   bash apps/<app>/deploy/build.sh [both|desktop|android] [debug|release] [abi-spec]
#
# Targets:
#   desktop  — `tauri build` → Linux .deb / .AppImage / .rpm
#   android  — scripts/build_android.sh → APK (+ AAB on release)
#   both     — desktop + android (default)
#
# Android build type (2nd arg, default `debug`): a debug APK is signed with the
# Android debug key and installs directly; a `release` build REQUIRES a
# configured release keystore (gen/android/keystore.properties) and fails
# closed before any work when it is missing — see build.md §Signing.
#
# abi-spec (3rd arg, default `aarch64`): comma-separated Android ABIs or "all".
#   e.g.  aarch64,x86_64
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(realpath "${HERE}/..")"               # edge/apps/<app>
APP="$(basename "${APP_DIR}")"                    # <app>
EDGE_DIR="$(realpath "${APP_DIR}/../..")"         # workspace root
DIST="${HERE}/dist"

WHAT="${1:-both}"
ANDROID_BUILD="${2:-debug}"
ABI_SPEC="${3:-aarch64}"

mkdir -p "${DIST}"
echo "==> ${APP} deploy build  (target=${WHAT}, android=${ANDROID_BUILD}, abis=${ABI_SPEC})"
echo "    artifacts → ${DIST}"

build_desktop() {
  echo "==> Desktop bundle (tauri build)"
  cd "${APP_DIR}"
  npm install
  npx tauri build
  local bundle="${APP_DIR}/src-tauri/target/release/bundle"
  find "${bundle}" -type f \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) \
    -exec cp -fv {} "${DIST}/" \;
}

build_android() {
  echo "==> Android (${ANDROID_BUILD}, abis=${ABI_SPEC})"
  bash "${EDGE_DIR}/scripts/build_android.sh" "${APP}" "${ANDROID_BUILD}" "${ABI_SPEC}"
  local out="${APP_DIR}/src-tauri/gen/android/app/build/outputs"
  # Match both `release`/`Release` and `debug`/`Debug` flavor dirs. Rename each
  # collected file with the app prefix (and drop Tauri's generic `app-`) so the
  # otherwise-identical `app-universal-*` names are self-identifying in dist/.
  while IFS= read -r f; do
    local base; base="$(basename "${f}")"
    cp -fv "${f}" "${DIST}/${APP}-${base#app-}"
  done < <(find "${out}" -type f -ipath "*${ANDROID_BUILD}*" \( -name '*.apk' -o -name '*.aab' \))
}

case "${WHAT}" in
  desktop) build_desktop ;;
  android) build_android ;;
  both)    build_desktop; build_android ;;
  *) echo "usage: $0 [both|desktop|android] [debug|release] [abi-spec]" >&2; exit 1 ;;
esac

echo ""
echo "==> Collected artifacts in ${DIST}:"
ls -lh "${DIST}" | grep -vE '^total|SHA256SUMS' || true
( cd "${DIST}" && sha256sum -- * > SHA256SUMS 2>/dev/null || true )
echo "✓ ${APP} deploy build complete"
