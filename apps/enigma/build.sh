#!/usr/bin/env bash
#
# Build Enigma26 from a preset.
#
#   ./build.sh                 Professional (pro.yaml)
#   ./build.sh std.yaml        Standard — or any other config of the same shape
#   ./build.sh --dry-run       print the commands the config resolves to, run none
#
# What is built — which features, debug or release, package formats, Android,
# tests — is set in the config and nowhere else. The build itself is Rutile's
# (rutile/scripts/build.sh); this only finds it and names the default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Everything below is Rutile's; without the submodule there is nothing to run.
[ -f "$ROOT/rutile/scripts/lib.sh" ] || {
  echo "rutile/ is empty — this repo is built on the Rutile submodule." >&2
  echo "  git submodule update --init" >&2
  exit 1
}

REPO_ROOT="$ROOT" BUILD_CONFIG_DEFAULT=pro.yaml exec bash "$ROOT/rutile/scripts/build.sh" "$@"
