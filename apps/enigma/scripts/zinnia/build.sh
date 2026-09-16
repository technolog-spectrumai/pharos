#!/usr/bin/env bash
#
# Build one Zinnia app.
#
#   scripts/zinnia/build.sh <app> [--debug] [--no-test] [--frontend]
#   scripts/zinnia/build.sh all   [...]      every zinnia app in turn
#
# <app> is sketch, lazurite or primula. Enigma is NOT built by this script —
# it has its own build_desktop.sh, which this must never touch.
#
# This is a dispatcher, not a second build. Each app already carries a build.sh
# that knows its own gates (deps, types, tests, frontend, then Rust); this
# resolves the app, checks it is one of ours, and hands over. One place to add
# an app, and no fourth copy of the build order to keep in step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZINNIA_APPS=(sketch lazurite primula)

usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

[ $# -ge 1 ] || { usage; exit 2; }
APP="$1"; shift

case "$APP" in
  -h|--help) usage; exit 0 ;;
  all)
    for a in "${ZINNIA_APPS[@]}"; do
      printf '\n\033[1m── %s ──\033[0m\n' "$a"
      "$ROOT/scripts/zinnia/build.sh" "$a" "$@"
    done
    exit 0 ;;
  enigma)
    echo "enigma has its own build: ./build_desktop.sh" >&2; exit 2 ;;
esac

# Refuse an unknown name rather than cd-ing into nothing and failing obscurely.
printf '%s\n' "${ZINNIA_APPS[@]}" | grep -qx "$APP" \
  || { echo "no zinnia app '$APP' (have: ${ZINNIA_APPS[*]})" >&2; exit 2; }

exec "$ROOT/apps/$APP/build.sh" "$@"
