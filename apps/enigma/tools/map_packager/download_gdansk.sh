#!/usr/bin/env bash
# Download a Gdańsk-and-surroundings map region package for Enigma (Protomaps
# schema — renders with the app's bundled style). Covers the Tricity
# (Gdańsk / Sopot / Gdynia), the Vistula delta and the near Kashubian lakes.
# Produces <out>/Gdansk_region.pmtiles + .manifest.json; import the .pmtiles in
# Enigma → Map → Regions.
#
#   ./tools/map_packager/download_gdansk.sh [OUT_DIR]
#
# OUT_DIR defaults to ~/enigma-maps.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HOME/enigma-maps}"

# Shared venv for the CLI deps (no PyQt6). Deps are (re)installed whenever any
# are missing — so a venv from before a requirements bump self-heals.
VENV="$HERE/.venv"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
if ! "$VENV/bin/python" -c "import pmtiles, requests, blake3, tqdm" 2>/dev/null; then
  echo "Installing map-download dependencies (one-off)…"
  "$VENV/bin/pip" install -q -r "$HERE/requirements-download.txt"
fi

# Gdańsk + the region around it (Tricity metro + delta + near lakes).
exec "$VENV/bin/python" "$HERE/download_map.py" \
  --name "Gdansk_region" \
  --bbox 17.90,54.00,19.10,54.70 \
  --min-zoom 0 --max-zoom 14 \
  --out "$OUT"
