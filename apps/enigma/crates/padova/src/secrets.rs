//! Remembering one passphrase, so sealing a second file does not mean typing it
//! again.
//!
//! **Nothing here returns the passphrase to a caller outside this crate.** That
//! is the whole design, and it is the rule the parked cloud module kept for its
//! session token: the apps render markup that arrived in a file, so anything
//! handed to page JavaScript is within reach of a document the user merely
//! opened. Instead `lock_file` and `unlock_file` take an OPTIONAL password, and
//! when it is absent they ask this module — inside Rust, where the answer
//! stays.
//!
//! ONE entry per app, under a constant account name. The service and account
//! of a keyring entry are stored in the clear, so a per-file entry would
//! publish the path of every sealed document to anything that can list the
//! keyring. One name leaks nothing but the fact that this app is installed.
//!
//! The in-process fallback, for a machine with no secret service running (a
//! bare window manager with no gnome-keyring or KWallet is ordinary),
//! deliberately is NOT a file. Falling back to disk would quietly deliver
//! something weaker than the storage the user was promised. Losing the
//! passphrase when the app exits is honest, the UI says which store is holding
//! it, and nothing is lost that cannot be typed again — the FILES stay
//! openable either way, because their salt travels inside them.

use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::Locker;

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

/// Whether a passphrase is remembered, and where — the two facts the UI needs
/// and the only two it gets.
#[derive(Debug, Serialize)]
pub struct SecretStatus {
    remembered: bool,
    storage: Option<Storage>,
}

/// The in-process slot. One per process, not per `Locker`: a process is one
/// app, and the fallback exists for the machine, not the service name.
fn memory() -> &'static Mutex<Option<String>> {
    static STORE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

impl Locker {
    fn entry(&self) -> Option<keyring::Entry> {
        keyring::Entry::new(self.service, ACCOUNT).ok()
    }

    /// Read it back for our own use. `pub(crate)` on purpose, and pinned by the
    /// doctest on `Locker`: the only callers are the two sealing functions.
    pub(crate) fn recall(&self) -> Option<String> {
        if let Some(entry) = self.entry() {
            if let Ok(secret) = entry.get_password() {
                return Some(secret);
            }
        }
        memory().lock().ok().and_then(|m| m.clone())
    }

    /// Remember a passphrase. Answers where it went, never what it was.
    pub fn remember(&self, passphrase: &str) -> Result<Storage, String> {
        if passphrase.is_empty() {
            return Err("no_passphrase: nothing to remember".into());
        }
        if let Some(entry) = self.entry() {
            if entry.set_password(passphrase).is_ok() {
                // Drop any memory copy so the two cannot disagree.
                if let Ok(mut mem) = memory().lock() {
                    *mem = None;
                }
                return Ok(Storage::Keychain);
            }
        }
        if let Ok(mut mem) = memory().lock() {
            *mem = Some(passphrase.to_string());
        }
        Ok(Storage::Memory)
    }

    /// Forget it, from both stores, unconditionally.
    pub fn forget(&self) {
        if let Some(entry) = self.entry() {
            let _ = entry.delete_credential();
        }
        if let Ok(mut mem) = memory().lock() {
            *mem = None;
        }
    }

    /// Whether one is remembered, and where.
    pub fn status(&self) -> SecretStatus {
        if let Some(entry) = self.entry() {
            if entry.get_password().is_ok() {
                return SecretStatus { remembered: true, storage: Some(Storage::Keychain) };
            }
        }
        let in_memory = memory().lock().ok().map(|m| m.is_some()).unwrap_or(false);
        SecretStatus {
            remembered: in_memory,
            storage: in_memory.then_some(Storage::Memory),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{serial, LOCKER};

    /// Works against whichever store this machine has. On a desktop with a
    /// secret service running it exercises the REAL keyring — verified doing so
    /// on gnome-keyring, where `remember` answers `Keychain` — and on a headless
    /// box it exercises the in-process fallback. Both are supported paths, so
    /// the test asserts the behaviour they share rather than pinning one.
    #[test]
    fn remembers_and_forgets_without_ever_returning_it() {
        let _serial = serial();
        LOCKER.forget();
        assert!(LOCKER.recall().is_none());

        let where_ = LOCKER.remember("hunter2").unwrap();
        assert!(LOCKER.recall().as_deref() == Some("hunter2"), "the crate can read it back");
        // Whichever store took it, the status says so and says nothing else.
        let status = LOCKER.status();
        assert!(status.remembered);
        assert_eq!(status.storage, Some(where_));

        LOCKER.forget();
        assert!(LOCKER.recall().is_none());
        assert!(!LOCKER.status().remembered);
    }

    /// Proves the secret really left this process when the keychain took it.
    /// Emptying the in-memory slot by hand and still reading the value back can
    /// only mean it came from the OS store — which is the difference between
    /// "remembered" and "remembered until you quit", and the difference the UI
    /// reports to the user.
    #[test]
    fn a_keychain_secret_outlives_the_memory_slot() {
        let _serial = serial();
        LOCKER.forget();
        let where_ = LOCKER.remember("hunter2").unwrap();
        if where_ == Storage::Memory {
            // No secret service on this machine; there is nothing to prove.
            LOCKER.forget();
            return;
        }
        if let Ok(mut mem) = memory().lock() {
            *mem = None;
        }
        assert_eq!(LOCKER.recall().as_deref(), Some("hunter2"), "must come from the keychain");
        assert_eq!(LOCKER.status().storage, Some(Storage::Keychain));

        LOCKER.forget();
        assert!(LOCKER.recall().is_none(), "forget must reach the keychain too");
    }

    #[test]
    fn refuses_to_remember_nothing() {
        assert!(LOCKER.remember("").unwrap_err().starts_with("no_passphrase"));
    }

    /// Two apps, two entries. What one remembers, the other cannot recall —
    /// the decision that made `service` a field rather than a constant.
    #[test]
    fn two_services_do_not_share_a_remembered_passphrase() {
        let _serial = serial();
        const OTHER: Locker = Locker::new("com.spectrumaipl.padova.test-other");
        LOCKER.forget();
        OTHER.forget();

        let where_ = LOCKER.remember("mine").unwrap();
        if where_ == Storage::Memory {
            // The in-process slot is per process, not per service: with no
            // secret service the two lockers share it, and that is documented.
            // There is nothing about separation to prove on this machine.
            LOCKER.forget();
            return;
        }
        assert_eq!(LOCKER.recall().as_deref(), Some("mine"));
        assert!(OTHER.recall().is_none(), "the other app's entry must stay empty");
        assert!(!OTHER.status().remembered);

        LOCKER.forget();
        OTHER.forget();
    }
}
