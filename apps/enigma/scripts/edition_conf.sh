# Sourced helper: which tauri config overlay the active ENIGMA_EDITION needs.
#
# Editions use one fixed installable identity: Enigma26 /
# com.spectrumaipl.enigma26. These overlays are still passed to Tauri so edition
# builds keep the same binary/product identity while varying feature gates.
#
# The overlay is a partial config the tauri CLI deep-merges over tauri.conf.json.
# build.rs applies the same merge before asserting that the edition YAML matches
# the effective identity (see `edition_conf_overlay` there) — the two must stay
# in lockstep, or the bundle would carry one identity while the assertion checks
# another.
#
# `custom` deliberately has no overlay: the Enigma Builder writes
# build_config.custom.yaml and uses the fixed identity from tauri.conf.json.

# Prints the --config path (relative to apps/enigma, the tauri CLI's cwd), or
# nothing when the edition has no overlay. Requires $APP_DIR.
edition_conf_rel() {
  local edition="${ENIGMA_EDITION:-}"
  [ -n "$edition" ] || return 0
  edition="$(printf '%s' "$edition" | tr '[:upper:]' '[:lower:]')"
  local rel="src-tauri/tauri.$edition.conf.json"
  [ -f "$APP_DIR/$rel" ] || return 0
  printf '%s' "$rel"
}

# Fills the array named by $1 with (--config <path>), or leaves it empty.
edition_conf_args() {
  local __out="$1" rel
  rel="$(edition_conf_rel)"
  if [ -n "$rel" ]; then
    eval "$__out=(--config \"\$rel\")"
  else
    eval "$__out=()"
  fi
}
