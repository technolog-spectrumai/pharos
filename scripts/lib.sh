# Shared preflight for zinnia's scripts.
#
# Sourced, never executed:
#
#   HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$HERE/scripts/lib.sh"        # from the repo root
#   . "$HERE/../../scripts/lib.sh"  # from apps/<name>/
#
# This exists because the split turns one pair of scripts into one pair PER APP,
# and the checks below are the half that is genuinely identical across them:
# the same toolchain, the same system libraries, the same snap trap. Copying
# them three times would mean fixing every future toolchain problem three times.
#
# What is NOT here, deliberately: anything that names a path, a port or an app.
# Those differ per app and belong in the caller, where they are visible.

# ── output ──────────────────────────────────────────────────────────────────
# Callers rely on these three being defined; keep the shapes stable.
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# ── toolchain ───────────────────────────────────────────────────────────────
# Checked up front, by name, because the failure otherwise arrives minutes in
# and reads as a compiler error rather than "you have no linker".

need_node() {
  command -v node >/dev/null || die "node is not installed"
  command -v npm  >/dev/null || die "npm is not installed"
}

# $1: a suggestion for what to do instead, appended to the error. The dev script
# can offer --web; the build script cannot.
need_cargo() {
  command -v cargo >/dev/null \
    || die "cargo is not installed — see https://rustup.rs${1:+ ($1)}"
}

# webkit2gtk and friends: the Tauri build fails deep inside a -sys crate without
# them, with an error that names a .pc file and not the package. A warning, not
# a failure — pkg-config may be absent on a machine that still builds fine.
check_system_libs() {
  command -v pkg-config >/dev/null || return 0
  for pkg in webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0; do
    pkg-config --exists "$pkg" 2>/dev/null \
      || echo "    WARNING: $pkg not found — install libwebkit2gtk-4.1-dev libsoup-3.0-dev"
  done
}

# ── snap ────────────────────────────────────────────────────────────────────
# A shell inside a snap (VS Code's integrated terminal is the usual way to end
# up in one) exports the snap runtime, and that breaks BOTH:
#
#   * the desktop binary links against the snap's glibc and dies with
#     "symbol lookup error: ... undefined symbol: __libc_pthread_init";
#   * XDG_DATA_HOME points inside the snap sandbox, so --reset would clear a
#     path the real app never uses.
#
# Nothing here can fix it from the inside — the environment has to be clean —
# so say so plainly rather than let either look like a bug in the app.
# Sets IN_SNAP to 1 or 0; returns 0 either way so `set -e` callers are safe.
detect_snap() {
  IN_SNAP=0
  if [ -n "${SNAP:-}" ] || [ -n "${SNAP_REVISION:-}" ]; then
    IN_SNAP=1
    warn "this shell is inside a snap, so the desktop window will fail with a"
    warn "glibc 'symbol lookup error' and app data resolves inside the sandbox."
    warn "Run from a normal terminal, or use --web."
  fi
}

# ── stored data ─────────────────────────────────────────────────────────────
# Derived from the bundle identifier rather than hardcoded: Tauri builds the
# app-data path from that value, so reading it here is what keeps this from
# wiping some other app's directory if the identifier ever changes.
#
# $1: path to tauri.conf.json. Echoes the app-data directory.
app_data_dir() {
  local identifier
  identifier="$(node -p "require('$1').identifier")"
  case "$(uname -s)" in
    Darwin) echo "$HOME/Library/Application Support/$identifier" ;;
    *)      echo "${XDG_DATA_HOME:-$HOME/.local/share}/$identifier" ;;
  esac
}

# ── dependencies ────────────────────────────────────────────────────────────
# `npm ci` when the lockfile is authoritative — reproducible, and it refuses
# rather than silently resolving a drifted package.json.
install_deps() {
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
}
