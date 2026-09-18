#!/usr/bin/env bash
#
# Run one Zinnia app in development.
#
#   scripts/zinnia/run_dev.sh <app> [--web] [--reset] [--reset-only]
#
# <app> is morion (Sketch and Primula were merged into it). Enigma has its own run_dev.sh at the
# repo root, which this must never touch.
#
# Each app holds a distinct dev-port pair (enigma 1420/1421, morion
# 1430/1431) and a distinct bundle identifier, so they run at once without
# colliding.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZINNIA_APPS=(morion)

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
