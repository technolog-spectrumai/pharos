#!/usr/bin/env bash
#
# Set up a machine to build and run Belisario's apps, or repair one.
#
#   ./install.sh                 everything below that is missing or broken
#   ./install.sh --no-system     skip the system packages (no sudo)
#   ./install.sh --check         say what is missing or broken, change nothing
#   ./install.sh --fresh-cargo   also clear every crate Cargo has unpacked
#                                (it unpacks them again from its download cache)
#
# In order:
#   1. Node and npm. Installed with nvm when there is none. When npm is there
#      but does not run (its own node_modules was deleted, which a cleanup of
#      every node_modules on disk does), that Node version is reinstalled
#      through nvm, as the newest Node 22 (the lockfile's packages want
#      22.22.2 or newer); outside nvm it says what to do.
#   2. Rust, through rustup, and updated when older than the repo's
#      rust-version (Cargo.toml). Crates in Cargo's cache that a cleanup
#      emptied ("failed to read …/registry/src/…/Cargo.toml") are removed,
#      so Cargo unpacks or downloads them again.
#   3. On Debian and Ubuntu, the system libraries the desktop apps link:
#      WebKitGTK, libsoup, ALSA, D-Bus, OpenSSL, the tray icon. Needs sudo.
#      Other systems are told the package names.
#   4. The npm packages (npm ci), as build.sh and run_dev.sh would.
#
# Android builds need the Android SDK and NDK as well; this does not install
# them (see docs/technology.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$REPO_ROOT/scripts/lib.sh"

SYSTEM=1
CHECK=0
FRESH_CARGO=0
for arg in "$@"; do
  case "$arg" in
    --no-system) SYSTEM=0 ;;
    --check)     CHECK=1 ;;
    --fresh-cargo) FRESH_CARGO=1 ;;
    -h|--help)   sed -n '3,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

NODE_MAJOR=22
MISSING=0
todo() { warn "$1"; MISSING=1; }

# ── 1. Node and npm ─────────────────────────────────────────────────────────
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # nvm is a shell function; a script has to source it itself.
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use && command -v nvm >/dev/null
}

npm_runs() { command -v npm >/dev/null && npm --version >/dev/null 2>&1; }

step "Node and npm"
node_new_enough() {  # 22.22.2 or newer: what the lockfile's packages want
  node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&(b>22||(b===22&&c>=2)))?0:1)' 2>/dev/null
}
# What there is: working and new enough (nothing to do), working but old
# (Ubuntu's own Node 18 is the usual one), broken (npm does not run), none.
state=none
if command -v node >/dev/null; then
  if ! npm_runs; then state=broken
  elif ! node_fits_vite; then state=old
  else state=ok
  fi
fi

if [ "$state" = ok ]; then
  echo "    node $(node --version) ($(command -v node)), npm $(npm --version)"
  node_new_enough \
    || warn "node $(node --version) works, but some packages want 22.22.2 or newer (nvm install $NODE_MAJOR); npm will print EBADENGINE warnings"
elif [ "$CHECK" = 1 ]; then
  case "$state" in
    broken) todo "npm does not run ($(command -v npm || echo 'not found')); ./install.sh repairs it" ;;
    old)    todo "node $(node --version) ($(command -v node)) is too old (Vite needs 20.19+ or 22.12+); ./install.sh installs Node $NODE_MAJOR with nvm" ;;
    none)   todo "node is not installed; ./install.sh installs it with nvm" ;;
  esac
else
  [ "$state" = old ] && echo "    node $(node --version) ($(command -v node)) is too old for Vite; installing Node $NODE_MAJOR with nvm beside it"
  if ! load_nvm; then
    if [ "$state" = broken ]; then
      case "$(command -v node)" in
        */.nvm/*) ;;
        *) die "npm does not run, and this Node ($(command -v node)) is not nvm's. Reinstall Node from where it came (your package manager, or nodejs.org), or remove it and run ./install.sh again to get nvm's." ;;
      esac
    fi
    step "Installing nvm"
    # nvm's installer adds the lines that load it to ~/.bashrc (or ~/.zshrc),
    # so new terminals find Node $NODE_MAJOR before the system's.
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    load_nvm || die "nvm did not install into $NVM_DIR"
  fi
  if [ "$state" = broken ] && case "$(command -v node)" in */.nvm/*) true ;; *) false ;; esac; then
    # `nvm install` of a version it already has does nothing, and
    # --reinstall-packages-from needs a working npm: the repair is to remove
    # that version and install Node again — the newest $NODE_MAJOR, which the
    # lockfile's packages want. Its global packages went with its npm already.
    broken="$(node --version)"
    step "Replacing Node $broken (its npm is broken) with the newest Node $NODE_MAJOR"
    nvm deactivate >/dev/null 2>&1 || true
    nvm uninstall "$broken"
  else
    step "Installing Node $NODE_MAJOR (nvm)"
  fi
  nvm install "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR" >/dev/null
  nvm use default >/dev/null
  npm_runs || die "npm still does not run after installing Node ($(command -v npm))"
  node_fits_vite || die "node is still $(node --version) ($(command -v node)) after nvm install"
  echo "    node $(node --version) ($(command -v node)), npm $(npm --version)"
  # This script's PATH has nvm's Node now; the terminal that ran it does not.
  NODE_CHANGED=1
fi

# ── 2. Rust ─────────────────────────────────────────────────────────────────
step "Rust"
want_rust="$(grep -m1 -oE '^rust-version *= *"[0-9.]+"' "$REPO_ROOT/Cargo.toml" | grep -oE '[0-9]+\.[0-9]+' || echo 1.94)"
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
older() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" != "$2" ]; }  # is $1 older than $2
if command -v cargo >/dev/null; then
  have_rust="$(rustc --version | grep -oE '[0-9]+\.[0-9]+' | head -1)"
  echo "    rustc $have_rust (the repo needs $want_rust or newer)"
  if older "$have_rust" "$want_rust"; then
    if [ "$CHECK" = 1 ]; then todo "Rust $have_rust is older than $want_rust (rustup update stable)"
    elif command -v rustup >/dev/null; then step "Updating Rust"; rustup update stable
    else todo "Rust $have_rust is older than $want_rust and did not come from rustup; update it where it came from"; fi
  fi
elif [ "$CHECK" = 1 ]; then
  todo "Rust is not installed; ./install.sh installs it with rustup"
else
  step "Installing Rust (rustup)"
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  echo "    rustc $(rustc --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
  echo "    New terminals need ~/.cargo/bin on PATH: source \"\$HOME/.cargo/env\" (or add it to ~/.bashrc)"
fi

# Cargo unpacks each crate once, under registry/src (and git dependencies
# under git/checkouts), and marks it done with a .cargo-ok file; it never looks
# again. A cleanup that deletes files there (the one that takes every
# node_modules often takes these too) leaves crates marked done but empty, and
# every build then fails with "failed to read …/Cargo.toml". Removing such a
# crate's directory makes Cargo unpack it again from registry/cache, or
# download it.
CARGO_DIR="${CARGO_HOME:-$HOME/.cargo}"
if [ "$FRESH_CARGO" = 1 ] && [ "$CHECK" = 0 ]; then
  # Unpacked sources only: registry/cache keeps the downloaded .crate files,
  # so nothing has to come from the network that is still there.
  step "Clearing Cargo's unpacked sources"
  rm -rf "$CARGO_DIR"/registry/src "$CARGO_DIR"/git/checkouts
  echo "    removed registry/src and git/checkouts; the next build unpacks what it needs"
fi
damaged=()
# A registry crate always has its Cargo.toml at the top; a git checkout may
# keep its workspace in a subfolder (Malachite's is in code/) but always has
# its .git.
for dir in "$CARGO_DIR"/registry/src/*/*/; do
  [ -f "$dir/.cargo-ok" ] && [ ! -f "$dir/Cargo.toml" ] && damaged+=("${dir%/}")
done
for dir in "$CARGO_DIR"/git/checkouts/*/*/; do
  [ -f "$dir/.cargo-ok" ] && [ ! -e "$dir/.git" ] && damaged+=("${dir%/}")
done
if [ ${#damaged[@]} -gt 0 ]; then
  if [ "$CHECK" = 1 ]; then
    todo "${#damaged[@]} crate(s) in Cargo's cache were emptied (e.g. ${damaged[0]##*/}); ./install.sh removes them so Cargo fetches them again"
  else
    step "Repairing Cargo's cache (${#damaged[@]} emptied crate(s))"
    for dir in "${damaged[@]}"; do echo "    ${dir#"$CARGO_DIR"/}"; rm -rf "$dir"; done
    echo "    Cargo unpacks or downloads them again on the next build."
  fi
fi

# ── 3. System libraries ─────────────────────────────────────────────────────
# What the desktop apps link on Linux: Tauri's WebKitGTK and libsoup, the tray
# icon, librsvg; Vesper's ALSA (calls); the OS keyring's D-Bus; OpenSSL.
APT_PACKAGES=(build-essential pkg-config curl wget file
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libxdo-dev libssl-dev
  libayatana-appindicator3-dev librsvg2-dev libasound2-dev libdbus-1-dev)
PC_NEEDED=(webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 alsa dbus-1 openssl)

if [ "$(uname -s)" = Linux ]; then
  step "System libraries"
  missing_pc=()
  if command -v pkg-config >/dev/null; then
    for pc in "${PC_NEEDED[@]}"; do pkg-config --exists "$pc" 2>/dev/null || missing_pc+=("$pc"); done
  else
    missing_pc=(pkg-config)
  fi
  if [ ${#missing_pc[@]} -eq 0 ]; then
    echo "    all present"
  elif [ "$CHECK" = 1 ] || [ "$SYSTEM" = 0 ]; then
    todo "missing: ${missing_pc[*]} — on Debian/Ubuntu: sudo apt-get install ${APT_PACKAGES[*]}"
  elif command -v apt-get >/dev/null; then
    echo "    missing: ${missing_pc[*]}; installing with apt-get (sudo)"
    sudo apt-get update
    sudo apt-get install -y "${APT_PACKAGES[@]}"
  else
    todo "missing: ${missing_pc[*]}. This is not a Debian/Ubuntu system; install the equivalents of: ${APT_PACKAGES[*]}"
  fi
fi

# ── 4. npm packages ─────────────────────────────────────────────────────────
if [ "$CHECK" = 1 ]; then
  [ -f "$REPO_ROOT/node_modules/.package-lock.json" ] || todo "the npm packages are not installed; ./install.sh (or build.sh) installs them"
elif npm_runs; then
  ensure_deps
  echo "    npm packages up to date"
fi

if [ "$MISSING" = 1 ]; then
  echo
  [ "$CHECK" = 1 ] && die "something is missing or broken (above); ./install.sh fixes what it can"
  die "not everything could be set up (above)"
fi
step "Ready"
if [ "${NODE_CHANGED:-0}" = 1 ] && [ -z "${FROM_BUILD:-}" ]; then
  echo "    Node $NODE_MAJOR is installed with nvm. Open a new terminal (or run"
  echo "    source ~/.nvm/nvm.sh) before build.sh, then check: node --version"
  echo "    If it still says an old version, something earlier on PATH wins"
  echo "    (a conda environment can carry its own node: conda deactivate)."
fi
if [ -z "${FROM_BUILD:-}" ]; then
  echo "    ./run_dev.sh <app>     run one in development"
  echo "    ./build.sh --list      what can be built"
fi
