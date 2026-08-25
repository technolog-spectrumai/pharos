//! Remembering one passphrase, so sealing a second file does not mean typing it
//! again.
//!
//! **No command returns the passphrase.** That is the whole design, and it is
//! the rule the parked cloud module kept for its session token: this app renders
//! markup that arrived in a file, so anything handed to page JavaScript is
//! within reach of a document the user merely opened. Instead `lock_file` and
//! `unlock_file` take an OPTIONAL password, and when it is absent they ask this
//! module — inside Rust, where the answer stays.
//!
//! ONE entry, under a constant account name. The service and account of a
//! keyring entry are stored in the clear, so a per-file entry would publish the
//! path of every sealed document to anything that can list the keyring. One
//! name leaks nothing but the fact that this app is installed.
//!
//! The in-process fallback, for a machine with no secret service running (a bare
//! window manager with no gnome-keyring or KWallet is ordinary), deliberately is
//! NOT a file. Falling back to disk would quietly deliver something weaker than
//! the storage the user was promised. Losing the passphrase when the app exits
//! is honest, the UI says which store is holding it, and nothing is lost that
//! cannot be typed again — the FILES stay openable either way, because their
//! salt travels inside them.

use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// A constant, never anything the user typed — see the module docs.
const KEYRING_SERVICE: &str = "com.spectrumaipl.zinnia";
/// One slot. Not a path, not a file name.
const ACCOUNT: &str = "file-passphrase";

/// Where the passphrase ended up. Shown to the user: one that will not survive
/// a restart should say so rather than appear permanent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    /// The OS secret store.
    Keychain,
    /// This process only — no secret service was available.
    Memory,
}

#[derive(Debug, Serialize)]
pub struct SecretStatus {
    remembered: bool,
    storage: Option<Storage>,
}

fn memory() -> &'static Mutex<Option<String>> {
    static STORE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

/// Read it back for our own use. Private on purpose: the only callers are the
/// two sealing commands, in this crate.
pub fn recall() -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, ACCOUNT) {
        if let Ok(secret) = entry.get_password() {
            return Some(secret);
        }
    }
    memory().lock().ok().and_then(|m| m.clone())
}

fn store(passphrase: &str) -> Storage {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, ACCOUNT) {
        if entry.set_password(passphrase).is_ok() {
            // Drop any memory copy so the two cannot disagree.
            if let Ok(mut mem) = memory().lock() {
                *mem = None;
            }
            return Storage::Keychain;
        }
    }
    if let Ok(mut mem) = memory().lock() {
        *mem = Some(passphrase.to_string());
    }
    Storage::Memory
}

fn clear() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, ACCOUNT) {
        let _ = entry.delete_credential();
    }
    if let Ok(mut mem) = memory().lock() {
        *mem = None;
    }
}

// ── commands ────────────────────────────────────────────────────────────────

/// Remember a passphrase. Answers where it went, never what it was.
#[tauri::command]
pub fn secret_remember(passphrase: String) -> Result<Storage, String> {
    if passphrase.is_empty() {
        return Err("no_passphrase: nothing to remember".into());
    }
    Ok(store(&passphrase))
}

/// Forget it, from both stores, unconditionally.
#[tauri::command]
pub fn secret_forget() -> Result<(), String> {
    clear();
    Ok(())
}

/// Whether one is remembered, and where — the two facts the UI needs and the
/// only two it gets.
#[tauri::command]
pub fn secret_status() -> Result<SecretStatus, String> {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, ACCOUNT) {
        if entry.get_password().is_ok() {
            return Ok(SecretStatus { remembered: true, storage: Some(Storage::Keychain) });
        }
    }
    let in_memory = memory().lock().ok().map(|m| m.is_some()).unwrap_or(false);
    Ok(SecretStatus {
        remembered: in_memory,
        storage: in_memory.then_some(Storage::Memory),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The memory path, which is the one a headless test machine takes. The
    /// keyring path needs a running secret service and is not asserted here.
    #[test]
    fn remembers_and_forgets_without_ever_returning_it() {
        clear();
        assert!(recall().is_none());

        let where_ = store("hunter2");
        assert!(recall().as_deref() == Some("hunter2"), "the app can read it back");
        // Whichever store took it, the status says so and says nothing else.
        let status = secret_status().unwrap();
        assert!(status.remembered);
        assert_eq!(status.storage, Some(where_));

        clear();
        assert!(recall().is_none());
        assert!(!secret_status().unwrap().remembered);
    }

    #[test]
    fn refuses_to_remember_nothing() {
        assert!(secret_remember(String::new()).unwrap_err().starts_with("no_passphrase"));
    }
}
