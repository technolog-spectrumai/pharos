//! The sealing commands, as this app registers them.
//!
//! Three shims. The work is padova's (`crates/padova`) and detection is
//! substrate's; what is decided HERE is only which of them this app puts on
//! its IPC surface. Every name, parameter name and attribute below is part of
//! the contract with `src/security/lock.ts` — tauri derives the argument keys
//! the frontend sends from the Rust parameter names, so renaming `path` or
//! `password` breaks the call silently rather than at compile time.

use crate::LOCKER;

/// Encrypt `path` in place.
///
/// `async`, and that is not decoration: Argon2id at 64 MiB and three passes is
/// most of a second of pure CPU, and a synchronous command runs it on the main
/// thread — the window stops repainting, so the dialog's own spinner freezes
/// while the work it describes is happening.
#[tauri::command(async)]
pub fn lock_file(path: String, password: Option<String>) -> Result<padova::LockedInfo, String> {
    LOCKER.lock_file(&path, password)
}

/// Decrypt in place. A wrong password leaves the file untouched.
#[tauri::command(async)]
pub fn unlock_file(path: String, password: Option<String>) -> Result<padova::LockedInfo, String> {
    LOCKER.unlock_file(&path, password)
}

/// Cheap sniff, so a listing can badge sealed files without asking for
/// anything. Substrate's, not padova's: DETECTION is what every app needs and
/// sealing is what only some do. An app that offers no sealing registers this
/// and nothing else — it can draw a padlock without ever being able to open
/// one.
#[tauri::command]
pub fn is_file_locked(path: String) -> Result<bool, String> {
    Ok(substrate::is_sealed_file(&path))
}
