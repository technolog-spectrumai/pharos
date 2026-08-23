#!/usr/bin/env bash
# Package the Builder as a single self-contained executable.
#
#   bash tools/enigma_builder/package.sh
#
# Produces dist/enigma-builder — one file, no Python and no venv needed on the
# machine that runs it. Copy it anywhere; on first launch it asks which Enigma26
# checkout to drive and remembers the answer.
#
# The binary is built for the platform it is built on: run this on Linux for a
# Linux binary, on Windows for a .exe. PyInstaller does not cross-compile.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}"

PY="${HERE}/venv/bin/python"
if [[ ! -x "${PY}" ]]; then
  echo "==> No venv found, creating one"
  python3 -m venv venv
  PY="${HERE}/venv/bin/python"
fi

echo "==> Installing build dependencies"
"${PY}" -m pip install --quiet --upgrade pip
"${PY}" -m pip install --quiet -r requirements-dev.txt

echo "==> Building single-file executable"
# PyInstaller's --add-data separator is ':' everywhere except Windows.
DATA_SEP=":"
case "${OSTYPE:-}" in
  msys*|cygwin*|win32*) DATA_SEP=";" ;;
esac

# --paths . because the tool is a flat module dir rather than a package.
# --add-data ships assets/ (the curated icon sets) INSIDE the binary; onefile
# unpacks it to sys._MEIPASS, which is where iconsets.py looks first. Without
# this the standalone Builder offers no icons at all.
# The excludes keep PyQt6's WebEngine and the test tooling out of the bundle;
# without them the binary roughly doubles in size.
"${PY}" -m PyInstaller \
  --noconfirm --clean --onefile \
  --name enigma-builder \
  --paths . \
  --add-data "assets${DATA_SEP}assets" \
  --exclude-module tkinter \
  --exclude-module pytest \
  --exclude-module PyQt6.QtWebEngineCore \
  --exclude-module PyQt6.QtWebEngineWidgets \
  --exclude-module PyQt6.QtQuick \
  --exclude-module PyQt6.Qt3DCore \
  main.py

BIN="${HERE}/dist/enigma-builder"
if [[ ! -x "${BIN}" ]]; then
  echo "ERROR: expected ${BIN} to exist" >&2
  exit 1
fi

echo ""
echo "==> Built $(du -h "${BIN}" | cut -f1)  ${BIN}"
echo "    Run it from anywhere; set the repo path on the Build tab,"
echo "    or point it with:  ENIGMA_REPO=/path/to/enigma ${BIN}"
echo "    Icon sets are baked in; override with ENIGMA_BUILDER_ICON_SETS=/dir"
