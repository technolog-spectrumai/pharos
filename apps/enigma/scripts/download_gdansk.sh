#!/usr/bin/env bash
# Download a Gdańsk-and-surroundings map region package for Enigma (Protomaps
# schema — renders with the app's bundled style). Covers the Tricity
# (Gdańsk / Sopot / Gdynia), the Vistula delta and the near Kashubian lakes.
# Produces <out>/Gdansk_region.pmtiles + .manifest.json; import the .pmtiles in
# Enigma → Map → Regions.
#
#   ./scripts/download_gdansk.sh [OUT_DIR]
#
# OUT_DIR defaults to ~/enigma-maps.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
OUT="${1:-$HOME/enigma-maps}"

VENV="$REPO/tools/map_packager/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "Setting up the packager virtualenv (one-off)…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$REPO/tools/map_packager/requirements.txt"
fi

# Gdańsk + the region around it (Tricity metro + delta + near lakes).
exec "$VENV/bin/python" "$HERE/download_map.py" \
  --name "Gdansk_region" \
  --bbox 17.90,54.00,19.10,54.70 \
  --min-zoom 0 --max-zoom 14 \
  --out "$OUT"
