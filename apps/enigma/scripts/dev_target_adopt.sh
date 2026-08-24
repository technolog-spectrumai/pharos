#!/usr/bin/env bash
# Hand the existing shared build directory to one profile, instead of leaving it
# orphaned when the per-profile dirs take over (scripts/dev_target.sh).
#
#   scripts/dev_target_adopt.sh alice
#
# WHY BOTHER: `target/` is ~17 GB of warm build. Switching to per-profile dirs
# without this leaves it unused while BOTH profiles cold-build, which needs
# ~51 GB. Adopting it means one profile is warm immediately and only the other
# pays, which needs ~34 GB. On a disk with 44 GB free, that is the difference
# between working and `ld: No space left on device`.
#
# It is a MOVE, not a copy: instant, and no extra disk. Hardlinking instead was
# considered and rejected — two Cargo instances sharing inodes across build dirs
# is a corruption risk nobody should be debugging at 17 GB.
set -e

PROFILE="${1:-}"
if [ -z "$PROFILE" ] || [ "$PROFILE" = "default" ]; then
  echo "usage: $0 <profile>   (a named profile, e.g. alice)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_TAURI="$SCRIPT_DIR/apps/enigma/src-tauri"
FROM="$SRC_TAURI/target"
TO="$SRC_TAURI/target-$PROFILE"

# Moving a build tree from under a running Cargo is how you get a half-linked
# binary and an afternoon of confusion.
if pgrep -f 'tauri dev|cargo (run|build|check)' >/dev/null 2>&1; then
  echo "[adopt] A dev instance or Cargo build is running." >&2
  echo "[adopt] Stop both instances first (Ctrl-C in run2.sh), then re-run this." >&2
  exit 1
fi

if [ -d "$TO" ]; then
  echo "[adopt] $TO already exists — nothing to do."
  exit 0
fi
if [ ! -d "$FROM" ]; then
  echo "[adopt] No shared $FROM to adopt — profiles will build their own."
  exit 0
fi

mv "$FROM" "$TO"
echo "[adopt] $FROM -> $TO"
echo "[adopt] '$PROFILE' is warm; every other profile cold-builds once (~17 GB, several minutes)."
