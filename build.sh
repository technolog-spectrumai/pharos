#!/usr/bin/env bash
#
# Build Pharos: Enigma (with Dromon, as apps/enigma/dromon.yaml says) or Beacon.
#
#   ./build.sh enigma              Enigma27 for this machine: .deb and .rpm (Linux)
#   ./build.sh beacon               Beacon, the server, for this machine: binary + .deb
#   ./build.sh beacon pi            Beacon for a Raspberry Pi (aarch64, cross-built)
#   ./build.sh all                 Enigma, then Beacon for this machine
#
#   ./build.sh enigma --dry-run    print the commands it resolves to, run none
#   ./build.sh enigma --validate   check the file against the checkout, build nothing
#   ./build.sh --list              the apps and their variants
#   ./build.sh --check             is this machine ready? (./install.sh --check)
#
# Packages land in dist/enigma/ and dist/beacon/<arch>/, each with a SHA256SUMS
# and a build.json.
#
# A machine that lacks something (Node 22, Rust, system libraries, npm
# packages) is set up first by ./install.sh, in the same run.
# Each run's output is also written to build-logs/build-<date>_<time>_<what>.log.
#
# What Enigma's build makes — debug or release, platforms, package formats,
# Android, signing, tests, where it lands — is set in apps/enigma/dromon.yaml
# and nowhere else: there are no build flags. The schema: dromon/README.md.
#
# This is the preflight; dromon/dromon.mjs does the building. The split is
# forced: reading YAML takes an npm package, so something has to check the
# toolchain and install dependencies before node can be handed the file.
set -euo pipefail

case "${1:-}" in
  --check) exec "$(dirname "${BASH_SOURCE[0]}")/install.sh" --check ;;
  -h|--help) sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# `./build.sh *` means all. Quoted, the * arrives as itself; unquoted, the
# shell has already replaced it with the names in the current directory, so
# that list is recognised: every argument (before any --flag) is one of those
# names, and together they are all of them.
glob_is_everything() {
  local -a names=() given=()
  local a
  for a in "$@"; do case "$a" in --*) ;; *) given+=("$a") ;; esac; done
  [ ${#given[@]} -ge 2 ] || return 1
  shopt -s nullglob
  names=(*)
  shopt -u nullglob
  [ ${#names[@]} -eq ${#given[@]} ] || return 1
  [ "${names[*]}" = "${given[*]}" ]
}
if [ "${1:-}" = "*" ]; then
  shift
  set -- all "$@"
elif glob_is_everything "$@"; then
  flags=()
  for a in "$@"; do case "$a" in --*) flags+=("$a") ;; esac; done
  set -- all ${flags[@]+"${flags[@]}"}
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Beacon is a server, not a Dromon app: its own script.
if [ "${1:-}" = "beacon" ]; then
  shift
  exec "$REPO_ROOT/beacon/build.sh" "$@"
fi
# `all`: Enigma (every variant, through Dromon), then Beacon for this machine.
if [ "${1:-}" = "all" ]; then
  shift
  "$REPO_ROOT/build.sh" enigma all "$@"
  exec "$REPO_ROOT/beacon/build.sh" host "$@"
fi
# Every run writes its own log: build-logs/build-<date>_<time>_<what>.log, all
# that is shown here, setup included. The path is said at the start and the end.
case " $* " in
  *" --list "*) ;;
  *)
    LOG_DIR="$REPO_ROOT/build-logs"
    mkdir -p "$LOG_DIR"
    LOG="$LOG_DIR/build-$(date +%Y-%m-%d_%H%M%S)_$(printf '%s' "${*:-all}" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-40).log"
    # The terminal keeps its colours; the file gets plain text.
    exec > >(tee >(sed -u 's/\x1b\[[0-9;]*m//g' > "$LOG")) 2>&1
    printf 'Log: %s\n' "$LOG"
    printf '%s  ./build.sh %s  (%s, node %s)\n' "$(date -Is)" "$*" "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)@$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null)" "$(node --version 2>/dev/null || echo none)"
    log_end() {
      local code=$?
      printf '\n%s  exit %s — log: %s\n' "$(date -Is)" "$code" "$LOG"
    }
    trap log_end EXIT
    ;;
esac

# step/warn/die, the toolchain checks, the snap trap and the dependency install.
. "$REPO_ROOT/scripts/lib.sh"

# One run sets the machine up: when something is missing or broken (Node too
# old or absent, Rust, the system libraries, the npm packages), install.sh
# fixes it first (it asks for sudo only for system packages), then the build
# goes on in the same run, with nvm's Node if it was just installed.
case " $* " in
  *" --list "*|*" --dry-run "*|*" --validate "*) ;;
  *)
    if ! "$REPO_ROOT/install.sh" --check >/dev/null 2>&1; then
      step "Setting up this machine first (./install.sh)"
      FROM_BUILD=1 "$REPO_ROOT/install.sh"
    fi
    # shellcheck disable=SC1091
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    ;;
esac

need_node
ensure_deps
case " $* " in
  *" --list "*) ;;
  *)
    need_cargo
    case " $* " in
      *" --dry-run "*|*" --validate "*) ;;
      *)
        check_system_libs
        # The test suites start GTK; from a snap shell that needs the same
        # repair the dev runners make.
        scrub_snap_env
        ;;
    esac
    ;;
esac

export REPO_ROOT
# Not exec: the EXIT trap has to run to close the log with the result.
node "$REPO_ROOT/dromon/dromon.mjs" "$@"
