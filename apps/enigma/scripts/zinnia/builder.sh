#!/usr/bin/env bash
#
# The Zinnia Builder — a window for building sketch, lazurite and primula.
#
#   scripts/zinnia/builder.sh              open the window
#   scripts/zinnia/builder.sh --check      report what it resolved, then exit
#   scripts/zinnia/builder.sh targets      what this machine can package
#   scripts/zinnia/builder.sh build sketch --bundles=deb,rpm
#
# Every argument is passed straight through to tools/zinnia_builder/main.py.
# The GUI is a convenience over the same commands the build scripts run; it is
# never the only way to do anything, which is why the subcommands exist.
#
# Enigma has its own builder (tools/enigma_builder, and its own launcher) with
# feature editions and signing. This is not that, and does not touch it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAIN="$ROOT/tools/zinnia_builder/main.py"

command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required" >&2; exit 1; }

# A venv beside the tool, made on first run. The GUI needs PyQt6; the
# subcommands do not, so a machine without it can still build.
VENV="$ROOT/tools/zinnia_builder/venv"
PY="python3"
if [ -x "$VENV/bin/python" ]; then
  PY="$VENV/bin/python"
elif ! python3 -c "import PyQt6" >/dev/null 2>&1; then
  # Only the window needs Qt — let a headless subcommand through untouched.
  case "${1:-}" in
    build|dev|android|targets|--check|--help|-h) ;;
    *)
      echo "The window needs PyQt6, which is not installed."
      echo "Either:  python3 -m venv $VENV && $VENV/bin/pip install -r $ROOT/tools/zinnia_builder/requirements.txt"
      echo "Or use a subcommand, which needs no Qt:  $0 build sketch"
      exit 1 ;;
  esac
fi

exec "$PY" "$MAIN" "$@"
