#!/usr/bin/env bash
#
# The Morion Builder — a window for building Morion.
#
#   scripts/morion_builder.sh                        open the window
#   scripts/morion_builder.sh --check                report what it resolved, then exit
#   scripts/morion_builder.sh targets                what this machine can package
#   scripts/morion_builder.sh build --bundles=deb,rpm
#   scripts/morion_builder.sh android --type=debug --abi=x86_64
#
# Every argument is passed straight through to tools/morion_builder/main.py.
# The window is a convenience over the same commands the build scripts run; it
# is never the only way to do anything, which is why the subcommands exist.
#
# Enigma has its own builder (tools/enigma_builder) with feature editions and
# signing. This is not that, and does not touch it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN="$ROOT/tools/morion_builder/main.py"

command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required" >&2; exit 1; }

# A venv beside the tool, made by hand once. The window needs PyQt6; the
# subcommands do not, so a machine without it can still build.
VENV="$ROOT/tools/morion_builder/venv"
PY="python3"
if [ -x "$VENV/bin/python" ]; then
  PY="$VENV/bin/python"
elif ! python3 -c "import PyQt6" >/dev/null 2>&1; then
  # Only the window needs Qt — let a headless subcommand through untouched.
  case "${1:-}" in
    build|dev|android|targets|--check|--help|-h) ;;
    *)
      echo "The window needs PyQt6, which is not installed."
      echo "Either:  python3 -m venv $VENV && $VENV/bin/pip install -r $ROOT/tools/morion_builder/requirements.txt"
      echo "Or use a subcommand, which needs no Qt:  $0 build"
      exit 1 ;;
  esac
fi

exec "$PY" "$MAIN" "$@"
