#!/usr/bin/env bash
# Download a Warsaw map region package for Enigma (Protomaps schema — renders
# with the app's bundled style). Produces <out>/Warszawa.pmtiles + .manifest.json;
# import the .pmtiles in Enigma → Map → Regions.
#
#   ./scripts/download_warsaw.sh [OUT_DIR]
#
# OUT_DIR defaults to ~/enigma-maps.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
OUT="${1:-$HOME/enigma-maps}"

# One shared venv for the packager deps (idempotent).
VENV="$REPO/tools/map_packager/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "Setting up the packager virtualenv (one-off)…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$REPO/tools/map_packager/requirements.txt"
fi

# Warsaw: the city and its immediate surroundings.
exec "$VENV/bin/python" "$HERE/download_map.py" \
  --name "Warszawa" \
  --bbox 20.75,52.03,21.31,52.40 \
  --min-zoom 0 --max-zoom 14 \
  --out "$OUT"
