# Shared preflight for every app's dev, build and test scripts.
#
# Sourced, never executed:
#
#   HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$HERE/scripts/lib.sh"            # from the repo root
#   . "$HERE/../../scripts/lib.sh"      # from apps/<name>/
#
# This exists because every app carries its own dev runner, and the checks
# below are the half that is genuinely identical across them: the same
# toolchain, the same system libraries, the same snap trap. Copying them per
# app would mean fixing every future toolchain problem once per app.
#
# What is NOT here, deliberately: anything that names a port or an app. Those
# differ per app and belong in the caller, where they are visible.

# The repo root: the directory above scripts/.
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

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
  # Present is not the same as working. npm keeps its own dependencies in a
  # node_modules beside it, and a disk cleanup that deletes every node_modules
  # it finds takes that one too — after which every npm command dies with
  # "Cannot find module 'graceful-fs'" and a stack trace that names no cause.
  npm --version >/dev/null 2>&1 \
    || die "npm is installed but does not run ($(command -v npm)) — its own node_modules is probably gone; reinstall this Node version (nvm install $(node --version) --reinstall-packages-from=current, or reinstall Node)"
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
# up in one) exports the snap's GTK runtime, and that breaks BOTH:
#
#   * the desktop binary loads GTK modules built against the snap's glibc and
#     dies with "symbol lookup error: ... undefined symbol:
#     __libc_pthread_init" — after a build that succeeded;
#   * XDG_DATA_HOME can point inside the snap sandbox, so the app would keep
#     its data in — and --reset would clear — a path the real app never uses.
#
# So the environment is put back before anything is launched: variables the
# snap launcher saved (it keeps each original as <NAME>_VSCODE_SNAP_ORIG) are
# restored, and whatever still points into a snap is dropped so GTK falls back
# to the system default. Everything else passes through untouched.
#
# Sets IN_SNAP to 1 or 0; returns 0 either way so `set -e` callers are safe.
scrub_snap_env() {
  IN_SNAP=0
  [ -n "${SNAP:-}${SNAP_REVISION:-}" ] || return 0
  IN_SNAP=1

  local name orig value kept entry entries
  for orig in $(compgen -v | grep '_VSCODE_SNAP_ORIG$' || true); do
    name="${orig%_VSCODE_SNAP_ORIG}"
    if [ -n "${!orig}" ]; then export "$name=${!orig}"; else unset "$name"; fi
  done

  # Path lists: keep the entries that are not the snap's.
  for name in LD_LIBRARY_PATH GTK_PATH GIO_MODULE_DIR GSETTINGS_SCHEMA_DIR \
              XDG_DATA_DIRS XDG_CONFIG_DIRS FONTCONFIG_PATH LOCPATH; do
    value="${!name:-}"
    [ -n "$value" ] || continue
    kept=""
    IFS=: read -ra entries <<< "$value"
    for entry in "${entries[@]}"; do
      case "$entry" in
        ''|*/snap/*) ;;
        *) kept="${kept:+$kept:}$entry" ;;
      esac
    done
    if [ -n "$kept" ]; then export "$name=$kept"; else unset "$name"; fi
  done

  # Single paths: there is nothing to keep, so a snap one is simply removed.
  for name in GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR GTK_EXE_PREFIX \
              GTK_IM_MODULE_FILE XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME; do
    case "${!name:-}" in */snap/*) unset "$name" ;; esac
  done
  return 0
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

# Every directory Tauri may keep this app's state in: config (Irena's recent
# files), data (the webview's localStorage, the app's own files) and cache.
# One per line, so a caller can `while read` them. Same identifier rule as
# app_data_dir, and a config with no identifier is refused rather than read
# as the literal "undefined" — `rm -rf ~/.config/undefined` is the bug.
#
# $1: path to tauri.conf.json.
app_stored_dirs() {
  local identifier
  identifier="$(node -p "require('$1').identifier")"
  [ -n "$identifier" ] && [ "$identifier" != "undefined" ] || die "no identifier in $1"
  case "$(uname -s)" in
    Darwin)
      echo "$HOME/Library/Application Support/$identifier"
      echo "$HOME/Library/Caches/$identifier"
      ;;
    *)
      echo "${XDG_CONFIG_HOME:-$HOME/.config}/$identifier"
      echo "${XDG_DATA_HOME:-$HOME/.local/share}/$identifier"
      echo "${XDG_CACHE_HOME:-$HOME/.cache}/$identifier"
      ;;
  esac
}

# Removes each directory named on stdin (one per line, as app_data_dir and
# app_stored_dirs print them) and says what it did with each — the "--reset"
# of every dev runner. Empty lines are skipped, never `rm -rf ""`.
remove_stored_dirs() {
  local dir
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if [ -d "$dir" ]; then
      rm -rf "$dir"
      echo "    removed $dir"
    else
      echo "    nothing stored yet ($dir)"
    fi
  done
}

# ── dev runners ─────────────────────────────────────────────────────────────
# The argument loop of a dev runner that offers --web and --reset (Morion,
# Irena). Sets WEB, RESET and RESET_ONLY to 0 or 1; --help prints lines 2–9
# of the calling script's header, which is where those runners keep their usage.
#
#   dev_parse_args "$@"
dev_parse_args() {
  WEB=0
  RESET=0
  RESET_ONLY=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --web)        WEB=1 ;;
      --reset)      RESET=1 ;;
      --reset-only) RESET=1; RESET_ONLY=1 ;;
      -h|--help)    sed -n '2,9p' "${BASH_SOURCE[1]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
  done
}

# The dev port, read from the vite.config.ts in the current directory rather
# than repeated by the caller: it already lives in four files and a test fails
# if they drift. Echoes nothing when the config names no port.
#
# $1: path to vite.config.ts (default ./vite.config.ts).
vite_port() {
  grep -oE 'port: *[0-9]+' "${1:-vite.config.ts}" | grep -oE '[0-9]+' | head -1
}

# Serves the front end alone, in the browser, from the current directory —
# the --web of every dev runner. Replaces the shell.
start_web_dev() {
  step "Starting Vite (browser only)"
  echo "    http://localhost:$(vite_port)"
  exec npm run dev
}

# ── dependencies ────────────────────────────────────────────────────────────
# The apps are npm WORKSPACES: their dependencies hoist into the root
# node_modules, and apps/<name>/node_modules may never exist at all. So "is it
# installed" is asked of the root.
#
# Installed is not the same as current: a checkout that already has packages
# never learns that a pull added some, and the first page that imports one
# fails ("Failed to resolve import" in Vite). So this installs again whenever
# package-lock.json is not the one node_modules was installed from, judged by
# its hash (a checkout touches mtimes, not contents), kept beside the packages.
#
# `npm ci`, because the lockfile is authoritative — reproducible, and it refuses
# rather than silently resolving a drifted package.json.
ensure_deps() {
  local lock="$REPO_ROOT/package-lock.json"
  local stamp="$REPO_ROOT/node_modules/.lock-sha256"
  local want have=""
  want="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$lock")"
  [ -f "$stamp" ] && have="$(cat "$stamp")"
  if [ -f "$REPO_ROOT/node_modules/.package-lock.json" ] && [ "$have" = "$want" ]; then
    return 0
  fi
  if [ -d "$REPO_ROOT/node_modules" ]; then
    step "Updating dependencies (package-lock.json changed)"
  else
    step "Installing dependencies"
  fi
  (cd "$REPO_ROOT" && npm ci --no-audit --no-fund)
  printf '%s' "$want" > "$stamp"
}

# Morion's name for the same thing, from before the two were one.
fresh_deps() { ensure_deps; }
