//! The sealing commands, as this app registers them.
//!
//! Three shims. The work is padova's (`crates/padova`) and detection is
//! substrate's; what is decided HERE is only which of them this app puts on
//! its IPC surface — and that every path is resolved against the open
//! workspace first, so the boundary the workspace module holds covers sealing
//! too. Every name, parameter name and attribute below is part of the contract
//! with padova's `lock.ts` — tauri derives the argument keys the frontend
//! sends from the Rust parameter names, so renaming `path` or `password`
//! breaks the call silently rather than at compile time.

use crate::workspace::{resolve, WorkspaceState};
use crate::LOCKER;

fn inside(ws: &WorkspaceState, path: &str) -> Result<String, String> {
    Ok(resolve(&ws.root()?, path, false)?.to_string_lossy().into_owned())
}

/// Encrypt `path` in place.
///
/// `async`, and that is not decoration: Argon2id at 64 MiB and three passes is
/// most of a second of pure CPU, and a synchronous command runs it on the main
/// thread — the window stops repainting, so the dialog's own spinner freezes
/// while the work it describes is happening.
#[tauri::command(async)]
pub fn lock_file(ws: tauri::State<'_, WorkspaceState>, path: String, password: Option<String>) -> Result<padova::LockedInfo, String> {
    LOCKER.lock_file(&inside(&ws, &path)?, password)
}

/// Decrypt in place. A wrong password leaves the file untouched.
#[tauri::command(async)]
pub fn unlock_file(ws: tauri::State<'_, WorkspaceState>, path: String, password: Option<String>) -> Result<padova::LockedInfo, String> {
    LOCKER.unlock_file(&inside(&ws, &path)?, password)
}

/// Cheap sniff, so a listing can badge sealed files without asking for
/// anything. Substrate's, not padova's: DETECTION is what every app needs and
/// sealing is what only some do. An app that offers no sealing registers this
/// and nothing else — it can draw a padlock without ever being able to open
/// one.
#[tauri::command]
pub fn is_file_locked(ws: tauri::State<'_, WorkspaceState>, path: String) -> Result<bool, String> {
    Ok(substrate::is_sealed_file(&inside(&ws, &path)?))
}
