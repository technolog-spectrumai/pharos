#!/usr/bin/env bash
#
# Build this repo's apps as a build config says.
#
#   ./build.sh                 the repo's default config
#   ./build.sh FILE.yaml       another config of the same shape
#   ./build.sh APP [APP...]    only these apps from the config
#   ./build.sh --dry-run       print the commands the config resolves to, run none
#
# What is built — features, debug or release, package formats, Android, tests —
# is set in the config and nowhere else: there are no build flags.
#
# Run through the app repo's own ./build.sh, a wrapper that checks this
# submodule is there, names the repo's default config and execs this file. This
# is the preflight; build.mjs does the building. The split is forced: reading
# YAML takes an npm package, so something has to check the toolchain and install
# dependencies before node can be handed the config.
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
