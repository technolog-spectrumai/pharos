#!/usr/bin/env bash
# Pull a newer rakotis into the workspace: resolve a ref of the rakotis repo,
# repin the git dependency in every app manifest, and refresh the install.
#
#   bash scripts/update_rakotis.sh [ref-or-sha] [--no-install]
#
#   ref-or-sha   branch, tag, or full 40-hex commit of the rakotis repo
#                (default: HEAD — the repo's default branch)
#   --no-install skip `npm install` (only rewrite the manifests)
#
# The dependency stays pinned to an exact commit — the ref is resolved once,
# here, so builds remain reproducible. Commit the manifest + lockfile changes
# after reviewing them.
set -euo pipefail

HTTPS_URL="https://gitlab.com/janhagit-group/rakotis.git"
SSH_URL="git@gitlab.com:janhagit-group/rakotis.git"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS=(enigma aurora enigma_plus)

REF="HEAD"
INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) REF="$arg" ;;
  esac
done

# Resolve the ref to a commit. A full 40-hex argument is taken as-is; otherwise
# ls-remote the repo (https first so url.insteadOf rewrites apply, ssh fallback).
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  SHA="$REF"
else
  resolve() {
    if [[ "$REF" == "HEAD" ]]; then
      git ls-remote "$1" HEAD 2>/dev/null | head -1 | cut -f1
    else
      git ls-remote "$1" "refs/heads/$REF" "refs/tags/$REF" 2>/dev/null | head -1 | cut -f1
    fi
  }
  SHA="$(resolve "$HTTPS_URL")"
  [[ -n "$SHA" ]] || SHA="$(resolve "$SSH_URL")"
  [[ -n "$SHA" ]] || { echo "ERROR: could not resolve '$REF' on $HTTPS_URL" >&2; exit 1; }
fi

CURRENT="$(node -p "require('$ROOT/apps/enigma/package.json').dependencies.rakotis" | sed 's/.*#//')"
echo "rakotis: $CURRENT -> $SHA ($REF)"
if [[ "$CURRENT" == "$SHA" ]]; then
  echo "Already up to date."
  exit 0
fi

for app in "${APPS[@]}"; do
  node -e "
    const fs = require('fs');
    const f = '$ROOT/apps/$app/package.json';
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    p.dependencies.rakotis = 'git+$HTTPS_URL#$SHA';
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
  "
  echo "  pinned in apps/$app/package.json"
done

if [[ "$INSTALL" == "1" ]]; then
  echo "Refreshing install (lockfile + node_modules)…"
  (cd "$ROOT" && npm install)
else
  echo "Skipped npm install (--no-install) — the lockfile is now stale until you run it."
fi

echo "Done. Review the diff, run the tests, then commit the manifests + package-lock.json."
