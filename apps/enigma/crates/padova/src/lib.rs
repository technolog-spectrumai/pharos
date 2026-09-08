//! Padova — sealing files, and remembering the passphrase that seals them.
//!
//! This is the half of file locking that needs a password. The other half —
//! what a sealed file looks like and whether a given file is one — is
//! substrate's, and the line between them is the point: every app must
//! RECOGNISE a sealed file, to badge it and to refuse handing ciphertext to an
//! editor, but only an app that offers sealing should be able to OPEN one.
//! Recognising costs nothing and grants nothing; opening needs the keyring.
//!
//! ## The one property
//!
//! **Nothing in this crate's public API returns the passphrase.** `lock_file`
//! and `unlock_file` take an *optional* password and, when it is absent, ask
//! the keyring inside Rust — the answer never crosses into page JavaScript,
//! which is within reach of any document the user merely opened. The read-back
//! is `Locker::recall`, and it is `pub(crate)`. That is not a convention: the
//! doctest on [`Locker`] fails if it is ever made public, so `cargo test`
//! refuses the change — from the workspace root, which is where `test:rust`
//! runs it.
//!
//! ## Registration is per app
//!
//! There is no `tauri` here. An app wraps the methods it wants in its own
//! `#[tauri::command]` shims and lists those in its `generate_handler!`. So
//! the code is shared, but what lands on each app's IPC surface is that app's
//! decision — an app that renders untrusted markup and offers no sealing can
//! depend on substrate alone and never link this crate.

mod lock;
mod secrets;

pub use lock::LockedInfo;
pub use secrets::{SecretStatus, Storage};

/// One app's locker: the sealing functions, bound to the keyring entry they
/// use.
///
/// The `service` is what the OS keyring files the passphrase under, and it is
/// **per app by decision**: two apps built from this crate use two entries, so
/// remembering a passphrase in one never silently unlocks a session in the
/// other. Sealed files still open everywhere — each carries its own salt — it
/// is only the *remembered* passphrase that stays with the app that was told
/// it. Construct one per app, as a constant, from the app's identifier.
///
/// The stored passphrase is readable only from inside this crate. The snippet
/// below must fail to compile; if it ever compiles, the property is gone:
///
/// ```compile_fail,E0624
/// let _ = padova::Locker::recall;
/// ```
///
/// It names the method as a PATH rather than calling it, and that is the whole
/// point. A call — `locker.recall()` — fails to compile for a private method,
/// but it also fails for a *public* one whose parameters or return type
/// changed, so `cargo test` would stay green while the read-back was public.
/// A bare path compiles for any public signature and fails only on privacy,
/// which is the property being pinned. (The `E0624` is documentation: rustdoc
/// checks the error code only on nightly, so on stable this is a plain
/// `compile_fail` and the body has to do the discriminating.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Locker {
    service: &'static str,
}

impl Locker {
    /// `service` is filed in the clear in the keyring, so it must be a
    /// constant that leaks nothing but the fact the app is installed — the
    /// app's bundle identifier, never anything the user typed.
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::Locker;
    use std::sync::{Mutex, MutexGuard};

    /// A service of its own, so `cargo test` never clears whatever passphrase
    /// the user's real app has remembered.
    pub(crate) const LOCKER: Locker = Locker::new("com.spectrumaipl.padova.test");

    /// Tests that touch the keyring share one entry and one in-memory slot, and
    /// the test runner is parallel. Hold this for the duration of any test that
    /// remembers, recalls or forgets.
    pub(crate) fn serial() -> MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
