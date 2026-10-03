//! The sealing commands, as this app registers them.
//!
//! Shims. The work is padova's (`crates/padova`) and detection is
//! substrate's; what is decided HERE is only which of them this app puts on
//! its IPC surface — and that every path is resolved against the open
//! workspace first, so the boundary the workspace module holds covers sealing
//! too. Every name, parameter name and attribute below is part of the contract
//! with padova's `lock.ts` — tauri derives the argument keys the frontend
//! sends from the Rust parameter names, so renaming `path` or `password`
//! breaks the call silently rather than at compile time.

use serde::Serialize;

use crate::mana;
use crate::sealed::SealSessions;
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

#[derive(Debug, Serialize, PartialEq)]
pub struct Rekeyed {
    /// Security Mana earned by the change; zero when the file earned within
    /// the cooldown, the day's cap is used up, or the bar was full.
    pub gained: f64,
}

/// The pure core of `rekey_file`: change the passphrase, move any open
/// editing session on the file to the new key, then credit Security Mana.
/// The credit is given HERE, after the change succeeded, and nowhere else —
/// the page has no command that earns Mana — and a credit that cannot be
/// written (a damaged metadata file) does not turn a done change into a
/// failure.
pub fn rekey(
    root: &std::path::Path,
    sessions: &SealSessions,
    path: &str,
    password: Option<String>,
    new_password: String,
    now: u64,
) -> Result<Rekeyed, String> {
    let resolved = resolve(root, path, false)?;
    let path_str = resolved.to_string_lossy().into_owned();
    LOCKER.rekey_file(&path_str, password, new_password.clone())?;
    sessions.follow_rekey(&path_str, &new_password);
    Ok(Rekeyed { gained: mana::reward_rekey(root, now, &resolved).unwrap_or(0.0) })
}

/// Change an encrypted file's passphrase: a new key, the same contents. Two
/// Argon2id derivations (the old passphrase, the new) — `async`.
#[tauri::command(async)]
pub fn rekey_file(
    ws: tauri::State<'_, WorkspaceState>,
    sessions: tauri::State<'_, SealSessions>,
    path: String,
    password: Option<String>,
    new_password: String,
) -> Result<Rekeyed, String> {
    rekey(&ws.root()?, &sessions, &path, password, new_password, mana::now_ms())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sealed::{open_text, write_text};
    use crate::workspace::tests::{put, scratch};

    #[test]
    fn a_rekey_moves_the_open_session_along_and_earns_mana_once() {
        let root = scratch("rekey");
        put(&root, "note.md", b"first");
        put(&root, "big.md", &vec![b'x'; 400 * 1024]);
        LOCKER.lock_file(&root.join("note.md").to_string_lossy(), Some("old".into())).unwrap();
        let t0 = 1_700_000_000_000;
        mana::settle(&root, t0).unwrap();
        mana::settle(&root, t0 + 10 * 3_600_000).unwrap(); // 100 − 3×10 = 70

        let sessions = SealSessions::new();
        let opened = open_text(&sessions, &root, "note.md", Some("old".into())).unwrap();
        let done = rekey(&root, &sessions, "note.md", Some("old".into()), "new".into(), t0 + 10 * 3_600_000).unwrap();
        assert_eq!(done, Rekeyed { gained: mana::REKEY_REWARD });

        // The page's token still saves, now under the new passphrase.
        write_text(&sessions, &root, opened.token, "note.md", "second").unwrap();
        let (_, plain) = LOCKER.open_sealed(&root.join("note.md").to_string_lossy(), Some("new".into())).unwrap();
        assert_eq!(plain, b"second");

        // Straight away again: a new key, but no second reward.
        let again = rekey(&root, &sessions, "note.md", Some("new".into()), "newer".into(), t0 + 10 * 3_600_000).unwrap();
        assert_eq!(again.gained, 0.0);
        // A refused change earns nothing and records nothing.
        let rows = crate::meta::load(&root).unwrap().ledger.len();
        assert!(rekey(&root, &sessions, "note.md", Some("wrong".into()), "x".into(), t0).unwrap_err().starts_with("wrong_password"));
        assert!(rekey(&root, &sessions, "big.md", Some("newer".into()), "x".into(), t0).unwrap_err().starts_with("not_locked"));
        assert!(rekey(&root, &sessions, "../x", Some("a".into()), "b".into(), t0).unwrap_err().starts_with("outside_workspace"));
        assert_eq!(crate::meta::load(&root).unwrap().ledger.len(), rows);
    }
}
