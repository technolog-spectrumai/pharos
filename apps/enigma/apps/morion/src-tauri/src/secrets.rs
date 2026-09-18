//! The passphrase commands, as this app registers them.
//!
//! Three shims over padova's keyring half. Note what is NOT here: anything
//! that returns the passphrase. `remember` answers where it went, `status`
//! answers whether and where, `forget` answers nothing — and padova's own
//! read-back is `pub(crate)`, so this file could not hand it out even if a
//! command were written to try.

use crate::LOCKER;

/// Remember a passphrase. Answers where it went, never what it was.
#[tauri::command]
pub fn secret_remember(passphrase: String) -> Result<padova::Storage, String> {
    LOCKER.remember(&passphrase)
}

/// Forget it, from both stores, unconditionally.
#[tauri::command]
pub fn secret_forget() -> Result<(), String> {
    LOCKER.forget();
    Ok(())
}

/// Whether one is remembered, and where — the two facts the UI needs and the
/// only two it gets.
#[tauri::command]
pub fn secret_status() -> Result<padova::SecretStatus, String> {
    Ok(LOCKER.status())
}
