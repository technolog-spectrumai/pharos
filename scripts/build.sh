#!/usr/bin/env bash
#
# Build this repo's apps as its build.yaml says.
#
#   ./build.sh                 every app in build.yaml
#   ./build.sh enigma          one app (or several, by name)
#   ./build.sh --dry-run       print the commands the config resolves to, run none
#   ./build.sh --config FILE   read another config instead of build.yaml
#
# What is built — edition, debug or release, package formats, Android, tests —
# is set in build.yaml and nowhere else: there are no build flags.
#
# Run through the app repo's own ./build.sh, a wrapper that checks this
# submodule is there and execs this file. This is the preflight; build.mjs does
# the building. The split is forced: reading YAML takes an npm package, so
# something has to check the toolchain and install dependencies before node can
# be handed the config.
set -euo pipefail

case "${1:-}" in
  -h|--help) sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# step/warn/die, the toolchain checks, the snap trap and the dependency install.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need_node
need_cargo
check_system_libs
# The test suites start GTK; from a snap shell that needs the same repair the
# dev runners make.
scrub_snap_env
ensure_deps

export REPO_ROOT
exec node "$RUTILE_DIR/scripts/build.mjs" "$@"
