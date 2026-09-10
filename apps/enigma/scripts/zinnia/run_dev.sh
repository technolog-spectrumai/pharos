#!/usr/bin/env bash
#
# Run one Zinnia app in development.
#
#   scripts/zinnia/run_dev.sh <app> [--web] [--reset] [--reset-only]
#
# <app> is sketch, lazurite, primula or py_editor. Enigma has its own run_dev.sh at the
# repo root, which this must never touch.
#
# Each app holds a distinct dev-port pair (enigma 1420/1421, lazurite
# 1430/1431, primula 1432/1433, sketch 1434/1435, py_editor 1436/1437) and a
# distinct bundle identifier, so they all run at once without colliding.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZINNIA_APPS=(sketch lazurite primula py_editor)

usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

[ $# -ge 1 ] || { usage; exit 2; }
APP="$1"; shift

case "$APP" in
  -h|--help) usage; exit 0 ;;
  enigma) echo "enigma has its own dev runner: ./run_dev.sh" >&2; exit 2 ;;
esac

printf '%s\n' "${ZINNIA_APPS[@]}" | grep -qx "$APP" \
  || { echo "no zinnia app '$APP' (have: ${ZINNIA_APPS[*]})" >&2; exit 2; }

exec "$ROOT/apps/$APP/run_dev.sh" "$@"
