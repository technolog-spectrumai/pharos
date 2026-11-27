//! One rotor MLS session per (room, identity), what rakotis' `cryptoService` calls through the
//! app's `mls_*` commands — moved here from Enigma's `lib.rs` so Teutates runs the same code.
//! Every step that changes a session saves it in the app's [`Store`] (Enigma: protasius' `mls`
//! namespace; Teutates: the member vault), so a restart finds the group again.

use std::collections::HashMap;
use std::sync::Mutex;

use rotor_core::RotorSession;
use zeroize::Zeroize as _;

/// Where sessions are kept between runs (an exported rotor state per room and identity).
pub trait Store {
    /// The saved state.
    fn get(&self, room: &str, identity: &str) -> Option<Vec<u8>>;
    /// Saves a state.
    fn put(&self, room: &str, identity: &str, state: &[u8]);
    /// Forgets a state.
    fn delete(&self, room: &str, identity: &str);
}

/// The sessions in memory, by the app's key (Enigma's includes the profile).
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, RotorSession>>);

fn persist(store: &dyn Store, s: &RotorSession, room: &str, identity: &str) {
    if let Ok(mut bytes) = s.export_state() {
        store.put(room, identity, &bytes);
        bytes.zeroize();
    }
}

fn restore(store: &dyn Store, room: &str, identity: &str) -> Option<RotorSession> {
    let mut bytes = store.get(room, identity)?;
    let s = RotorSession::import_state(&bytes).ok();
    bytes.zeroize();
    s
}

/// A session's address: the map key, and the room and identity it is saved under.
#[derive(Clone, Copy)]
pub struct At<'a> {
    /// The key in memory.
    pub key: &'a str,
    /// The room.
    pub room: &'a str,
    /// The identity.
    pub identity: &'a str,
}

impl Sessions {
    /// The map itself (an app clears it when a profile closes or the vault locks).
    ///
    /// # Errors
    /// When the lock is poisoned.
    pub fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, HashMap<String, RotorSession>>> {
        self.0.lock()
    }

    fn with<T>(&self, store: &dyn Store, at: At<'_>, save: bool, f: impl FnOnce(&mut RotorSession) -> Result<T, String>) -> Result<T, String> {
        let mut map = self.0.lock().map_err(|e| e.to_string())?;
        let s = map.get_mut(at.key).ok_or_else(|| "session not initialised".to_string())?;
        let out = f(s)?;
        if save {
            persist(store, s, at.room, at.identity);
        }
        Ok(out)
    }

    /// Restores a saved session or creates a fresh group; `true` when one was there already.
    ///
    /// # Errors
    /// When rotor refuses.
    pub fn init(&self, store: &dyn Store, at: At<'_>) -> Result<bool, String> {
        let mut map = self.0.lock().map_err(|e| e.to_string())?;
        if map.contains_key(at.key) {
            return Ok(true);
        }
        if let Some(s) = restore(store, at.room, at.identity) {
            map.insert(at.key.to_string(), s);
            return Ok(true);
        }
        let mut s = RotorSession::new(at.room.to_string(), at.identity.to_string())?;
        s.create_group()?;
        persist(store, &s, at.room, at.identity);
        map.insert(at.key.to_string(), s);
        Ok(false)
    }

    /// A fresh key package.
    ///
    /// # Errors
    /// When the session is not there or rotor refuses.
    pub fn key_package(&self, store: &dyn Store, at: At<'_>) -> Result<Vec<u8>, String> {
        self.with(store, at, true, RotorSession::key_package)
    }

    /// Adds a member by its key package: (Welcome, commit).
    ///
    /// # Errors
    /// When the session is not there or rotor refuses.
    pub fn add_member(&self, store: &dyn Store, at: At<'_>, kp: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
        self.with(store, at, true, |s| s.add_member(kp))
    }

    /// The identity a key package's credential names, once it checks out (signature,
    /// lifetime): who [`Sessions::add_member_as`] would add with it.
    ///
    /// # Errors
    /// When the session is not there or the key package does not check out.
    pub fn key_package_identity(&self, store: &dyn Store, at: At<'_>, kp: &[u8]) -> Result<String, String> {
        self.with(store, at, false, |s| s.key_package_identity(kp))
    }

    /// [`Sessions::add_member`], but only the member the caller vouched for: the key package's
    /// own credential must name `member`, and someone already in the group is refused (a second
    /// leaf under an existing name would read as that member in every roster).
    ///
    /// # Errors
    /// When the session is not there, `member` is already in the group, or rotor refuses.
    pub fn add_member_as(&self, store: &dyn Store, at: At<'_>, kp: &[u8], member: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
        self.with(store, at, true, |s| {
            if s.members().unwrap_or_default().iter().any(|m| m == member) {
                return Err(format!("{member:?} is already in the group"));
            }
            s.add_member_as(kp, member)
        })
    }

    /// Joins the group a Welcome is for.
    ///
    /// # Errors
    /// When the session is not there or the Welcome is not for it.
    pub fn join_from_welcome(&self, store: &dyn Store, at: At<'_>, welcome: &[u8]) -> Result<(), String> {
        self.with(store, at, true, |s| s.join_from_welcome(welcome))
    }

    /// A commit, proposal or application message: the plaintext of the last.
    ///
    /// # Errors
    /// When the session is not there or rotor refuses.
    pub fn process_message(&self, store: &dyn Store, at: At<'_>, bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
        self.with(store, at, true, |s| s.process_message(bytes))
    }

    /// Seals an application message (the plaintext is wiped).
    ///
    /// # Errors
    /// When the session is not there or rotor refuses.
    pub fn encrypt(&self, store: &dyn Store, at: At<'_>, mut plaintext: Vec<u8>) -> Result<Vec<u8>, String> {
        let out = self.with(store, at, true, |s| s.encrypt_app(&plaintext));
        plaintext.zeroize();
        out
    }

    /// The group's members (device identities).
    ///
    /// # Errors
    /// When the session is not there.
    pub fn members(&self, store: &dyn Store, at: At<'_>) -> Result<Vec<String>, String> {
        self.with(store, at, false, |s| s.members())
    }

    /// A secret from the current epoch's MLS exporter (RFC 9420): every member at
    /// this epoch derives the same bytes, a removed member cannot.
    ///
    /// # Errors
    /// When the session or its group is not there.
    pub fn export_secret(&self, store: &dyn Store, at: At<'_>, label: &str, context: &[u8], len: usize) -> Result<Vec<u8>, String> {
        self.with(store, at, false, |s| s.export_secret(label, context, len))
    }

    /// Removes a member: the commit to send.
    ///
    /// # Errors
    /// When the session is not there or rotor refuses.
    pub fn remove_member(&self, store: &dyn Store, at: At<'_>, target: &str) -> Result<Vec<u8>, String> {
        self.with(store, at, true, |s| s.remove_member(target))
    }

    /// Forgets a session, in memory and saved.
    pub fn clear(&self, store: &dyn Store, at: At<'_>) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(at.key);
        }
        store.delete(at.room, at.identity);
    }

    /// Moves a session to another room (Enigma's invitation redeemer: its key package was made
    /// before it knew the room). Refuses to overwrite a session that exists.
    ///
    /// # Errors
    /// `MLS_SESSION_EXISTS`, or when the session is not there.
    pub fn adopt(&self, store: &dyn Store, from: At<'_>, to: At<'_>) -> Result<(), String> {
        if from.key == to.key {
            return Ok(());
        }
        let mut map = self.0.lock().map_err(|e| e.to_string())?;
        if map.contains_key(to.key) || restore(store, to.room, to.identity).is_some() {
            return Err("MLS_SESSION_EXISTS".to_string());
        }
        let s = map.remove(from.key).ok_or_else(|| "session not initialised".to_string())?;
        let mut bytes = s.export_state()?;
        let adopted = RotorSession::import_state(&bytes)?;
        bytes.zeroize();
        persist(store, &adopted, to.room, to.identity);
        map.insert(to.key.to_string(), adopted);
        store.delete(from.room, from.identity);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Mem(RefCell<HashMap<String, Vec<u8>>>);
    impl Store for Mem {
        fn get(&self, r: &str, i: &str) -> Option<Vec<u8>> {
            self.0.borrow().get(&format!("{r}\0{i}")).cloned()
        }
        fn put(&self, r: &str, i: &str, s: &[u8]) {
            self.0.borrow_mut().insert(format!("{r}\0{i}"), s.to_vec());
        }
        fn delete(&self, r: &str, i: &str) {
            self.0.borrow_mut().remove(&format!("{r}\0{i}"));
        }
    }
    const fn at<'a>(room: &'a str, identity: &'a str) -> At<'a> {
        At { key: identity, room, identity }
    }

    #[test]
    fn two_members_talk_and_a_restart_keeps_the_group() {
        let (sa, sb) = (Mem::default(), Mem::default());
        let (a, b) = (Sessions::default(), Sessions::default());
        assert!(!a.init(&sa, at("r", "alice")).unwrap());
        assert!(!b.init(&sb, at("r", "bob")).unwrap());
        let kp = b.key_package(&sb, at("r", "bob")).unwrap();
        let (welcome, _commit) = a.add_member(&sa, at("r", "alice"), &kp).unwrap();
        b.join_from_welcome(&sb, at("r", "bob"), &welcome).unwrap();
        let ct = a.encrypt(&sa, at("r", "alice"), b"hi".to_vec()).unwrap();
        assert_eq!(b.process_message(&sb, at("r", "bob"), &ct).unwrap().as_deref(), Some(&b"hi"[..]));
        // Bob's app closes and opens again: the saved group reads Alice's next message.
        let b2 = Sessions::default();
        assert!(b2.init(&sb, at("r", "bob")).unwrap());
        let ct = a.encrypt(&sa, at("r", "alice"), b"again".to_vec()).unwrap();
        assert_eq!(b2.process_message(&sb, at("r", "bob"), &ct).unwrap().as_deref(), Some(&b"again"[..]));
        let mut m = a.members(&sa, at("r", "alice")).unwrap();
        m.sort();
        assert_eq!(m, vec!["alice", "bob"]);
        // Bob leaves: Alice's removal changes the keys; his saved group no longer reads.
        let _ = a.remove_member(&sa, at("r", "alice"), "bob").unwrap();
        let ct = a.encrypt(&sa, at("r", "alice"), b"after".to_vec()).unwrap();
        assert!(b2.process_message(&sb, at("r", "bob"), &ct).is_err());
        a.clear(&sa, at("r", "alice"));
        assert!(sa.get("r", "alice").is_none());
    }
}
