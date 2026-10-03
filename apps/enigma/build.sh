#!/usr/bin/env bash
#
# Build Enigma as build.yaml says.
#
#   ./build.sh                 what build.yaml describes
#   ./build.sh --dry-run       print the commands it resolves to, run none
#   ./build.sh --config FILE   read another config instead of build.yaml
#
# What is built — edition, debug or release, package formats, Android, tests —
# is set in build.yaml and nowhere else. The build itself is Rutile's
# (rutile/scripts/build.sh); this only finds it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Everything below is Rutile's; without the submodule there is nothing to run.
[ -f "$ROOT/rutile/scripts/lib.sh" ] || {
  echo "rutile/ is empty — this repo is built on the Rutile submodule." >&2
  echo "  git submodule update --init" >&2
  exit 1
}

REPO_ROOT="$ROOT" exec bash "$ROOT/rutile/scripts/build.sh" "$@"
