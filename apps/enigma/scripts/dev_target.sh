#!/usr/bin/env bash
# Per-profile Cargo build directory, so two dev instances never queue behind one
# another's build.
#
# WHY: alice and bob both run `cargo run` against the same crate. Cargo takes an
# EXCLUSIVE lock on its build directory, so sharing one means the second instance
# sits at "Blocking waiting for file lock on build directory" until the first has
# finished compiling AND linking — which, for this crate (iroh + arti + tauri,
# with unpacked DWARF), is minutes every time a Rust file changes.
#
# THE COST IS REAL: each build directory is ~17 GB. Two profiles is ~34 GB. That
# is the trade being made deliberately — testing two instances in parallel is
# worth more than the disk. `dev_target_guard` below refuses to start a cold
# build that would fill the disk, because the failure mode otherwise is a
# `ld: No space left on device` at the very end of a long link, which reads like
# a code bug and is not one (build.md).
#
# LAYOUT:
#   profile "default"  -> src-tauri/target          (unchanged; the plain path)
#   profile "alice"    -> src-tauri/target-alice
#   profile "bob"      -> src-tauri/target-bob
#
# Every `target*` sibling is already covered by .gitignore's `**/target/` only
# for the exact name, so `dev_target_ignore` keeps the siblings ignored too.

# Echo the build directory for a profile. Absolute, because Cargo resolves
# CARGO_TARGET_DIR relative to the invocation directory and the launchers `cd`.
dev_target_dir() {
  local profile="$1" src_tauri="$2"
  if [ -z "$profile" ] || [ "$profile" = "default" ]; then
    printf '%s/target' "$src_tauri"
  else
    printf '%s/target-%s' "$src_tauri" "$profile"
  fi
}

# Free gibibytes on the filesystem holding $1.
dev_target_free_gb() {
  df -BG --output=avail "$1" 2>/dev/null | tail -1 | tr -dc '0-9'
}

# Refuse to start a build that cannot finish.
#
# A COLD build directory needs room for the whole tree; a warm one only needs
# room to relink. The two thresholds differ by an order of magnitude, so they are
# checked separately rather than with one pessimistic number.
dev_target_guard() {
  local dir="$1"
  local parent
  parent="$(dirname "$dir")"
  local free
  free="$(dev_target_free_gb "$parent")"
  [ -n "$free" ] || return 0 # df unavailable: do not block the developer

  local need=6 kind="relink"
  if [ ! -d "$dir/debug" ]; then
    need=25
    kind="a COLD build"
  fi

  if [ "$free" -lt "$need" ]; then
    echo "[dev-target] Only ${free} GB free on $parent, and $kind of this crate needs about ${need} GB." >&2
    echo "[dev-target] Refusing to start: a full disk surfaces as 'ld: No space left on device'" >&2
    echo "[dev-target]   at the end of the link, which looks like a code bug and is not one." >&2
    echo "[dev-target] Free some space, or reuse one build dir:  CARGO_TARGET_DIR=$parent/target" >&2
    return 1
  fi

  if [ "$kind" = "a COLD build" ]; then
    echo "[dev-target] $dir is empty — this profile's first build is a full one (~17 GB, several minutes)."
    echo "[dev-target] Later builds are incremental, and the two instances no longer block each other."
  fi
  return 0
}

# Export CARGO_TARGET_DIR for a profile, guarding disk first.
dev_target_export() {
  local profile="$1" src_tauri="$2"
  local dir
  dir="$(dev_target_dir "$profile" "$src_tauri")"
  dev_target_guard "$dir" || return 1
  export CARGO_TARGET_DIR="$dir"
}
