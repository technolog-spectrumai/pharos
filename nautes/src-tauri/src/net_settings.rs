//! User settings the transports share.
//!
//! These lived in p2p_dht.rs, where they were first needed. They are not the
//! DHT's: the connect deadline bounds invitations and direct invites too, and
//! the DHT is an optional feature — a build without it still has a deadline.

use tauri::AppHandle;

pub(crate) const SETTINGS_NS: &str = "p2p:settings";
pub(crate) const SETTINGS_SCOPE: &str = "default";

/// A seconds-valued setting from the profile's encrypted store, clamped to the
/// build's bounds; the build default while the vault is locked or the key unset.
pub(crate) fn setting_secs(app: &AppHandle, key: &str, default: u64, min: u64, max: u64) -> u64 {
    crate::vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, key)
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(min, max))
        .unwrap_or(default)
}

/// The user-set connect deadline (same value the frontend's join window uses —
/// see technology.md §15: never hardcode a connect deadline).
/// Default + clamp bounds come from build_config.yaml (settings section).
pub fn connect_timeout_secs(app: &AppHandle) -> u64 {
    use crate::build_config::settings as s;
    setting_secs(
        app,
        "connect_timeout_secs",
        s::CONNECT_TIMEOUT_DEFAULT_SECS,
        s::CONNECT_TIMEOUT_MIN_SECS,
        s::CONNECT_TIMEOUT_MAX_SECS,
    )
}
