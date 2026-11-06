//! Sealing for Pharos.
//!
//! - [`Friendship`]: an MLS group (Ferrozine's rotor) for two friends, or a
//!   small group. Messages are [`pharos_wire::Envelope`]s, padded with
//!   [`pharos_wire::pad`] before they are encrypted, so the ciphertext's
//!   length gives away only the bucket.
//! - [`seal_labelled`] / [`open_labelled`]: XChaCha20-Poly1305 with a random
//!   24-byte nonce and a label as associated data. A box opens only under the
//!   label it was sealed with, so a value moved to another place (another
//!   table row, another friend's record) does not open. Directory records and
//!   Relay' at-rest sealing use it.

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::XChaCha20Poly1305;
use pharos_rendezvous::FriendshipSecret;
use pharos_wire::{pad, unpad, Envelope};
use rotor_core::RotorSession;

/// The MLS exporter label the friendship secret is taken with.
pub const FRIENDSHIP_LABEL: &str = "pharos/friendship/v1";
const NONCE: usize = 24;

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("mls: {0}")]
    Mls(String),
    #[error("wire: {0}")]
    Wire(#[from] pharos_wire::WireError),
    #[error("box did not open (wrong key, wrong label, or tampered)")]
    Open,
}

pub type Result<T> = std::result::Result<T, SealError>;

fn mls(e: String) -> SealError {
    SealError::Mls(e)
}

/// Seal `plaintext` under `key`, bound to `label`. Output: nonce ‖ ciphertext.
pub fn seal_labelled(key: &[u8; 32], label: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad: label })
        .expect("XChaCha20-Poly1305 encryption does not fail");
    let mut out = Vec::with_capacity(NONCE + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

pub fn open_labelled(key: &[u8; 32], label: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < NONCE + 16 {
        return Err(SealError::Open);
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let (nonce, ct) = sealed.split_at(NONCE);
    cipher
        .decrypt(nonce.into(), Payload { msg: ct, aad: label })
        .map_err(|_| SealError::Open)
}

/// What opening a friendship message gave.
#[derive(Debug, PartialEq, Eq)]
pub enum Opened {
    /// An application message.
    Message(Envelope),
    /// A handshake message (a commit) that moved the group on; nothing to show.
    Handshake,
}

/// One side of a friendship's MLS group.
pub struct Friendship {
    session: RotorSession,
}

impl Friendship {
    /// A not-yet-paired side: it can only hand out a key package.
    pub fn new(friendship_id: &str, me: &str) -> Result<Self> {
        Ok(Friendship { session: RotorSession::new(friendship_id.to_string(), me.to_string()).map_err(mls)? })
    }

    /// This side's key package, to put on its contact card.
    pub fn key_package(&mut self) -> Result<Vec<u8>> {
        self.session.key_package().map_err(mls)
    }

    /// Start the group with the friend whose key package we scanned.
    /// Returns the welcome for them.
    pub fn start(&mut self, their_key_package: &[u8]) -> Result<Vec<u8>> {
        self.session.create_group().map_err(mls)?;
        let (welcome, _commit) = self.session.add_member(their_key_package).map_err(mls)?;
        Ok(welcome)
    }

    /// Join the group from the welcome the friend sent.
    pub fn join(&mut self, welcome: &[u8]) -> Result<()> {
        self.session.join_from_welcome(welcome).map_err(mls)
    }

    /// The friendship's long-lived secret. Take it right after pairing and keep it:
    /// MLS exporter output changes with every epoch.
    pub fn friendship_secret(&self) -> Result<FriendshipSecret> {
        let v = self.session.export_secret(FRIENDSHIP_LABEL, b"", 32).map_err(mls)?;
        Ok(FriendshipSecret::from_bytes(v.try_into().expect("asked for 32 bytes")))
    }

    pub fn members(&self) -> Result<Vec<String>> {
        self.session.members().map_err(mls)
    }

    /// Pad and encrypt one envelope.
    pub fn seal(&mut self, env: &Envelope) -> Result<Vec<u8>> {
        self.session.encrypt_app(&pad(&env.encode())).map_err(mls)
    }

    /// Decrypt one MLS message from the friend.
    pub fn open(&mut self, ciphertext: &[u8]) -> Result<Opened> {
        match self.session.process_message(ciphertext).map_err(mls)? {
            Some(padded) => Ok(Opened::Message(Envelope::decode(unpad(&padded)?)?)),
            None => Ok(Opened::Handshake),
        }
    }

    pub fn export_state(&self) -> Result<Vec<u8>> {
        self.session.export_state().map_err(mls)
    }

    pub fn import_state(state: &[u8]) -> Result<Self> {
        Ok(Friendship { session: RotorSession::import_state(state).map_err(mls)? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pharos_wire::Body;

    fn pair() -> (Friendship, Friendship) {
        let mut alice = Friendship::new("f1", "alice").unwrap();
        let mut bob = Friendship::new("f1", "bob").unwrap();
        let kp = bob.key_package().unwrap();
        let welcome = alice.start(&kp).unwrap();
        bob.join(&welcome).unwrap();
        (alice, bob)
    }

    #[test]
    fn friends_share_a_secret_and_exchange_messages() {
        let (mut alice, mut bob) = pair();
        assert_eq!(alice.friendship_secret().unwrap().as_bytes(), bob.friendship_secret().unwrap().as_bytes());
        let env = Envelope::text([1; 16], 5, "hello bob").unwrap();
        let ct = alice.seal(&env).unwrap();
        assert_eq!(bob.open(&ct).unwrap(), Opened::Message(env));
        let back = Envelope::new([2; 16], 6, Body::Ack(vec![[1; 16]]));
        assert_eq!(alice.open(&bob.seal(&back).unwrap()).unwrap(), Opened::Message(back));
    }

    #[test]
    fn ciphertexts_of_short_and_medium_texts_are_the_same_length() {
        let (mut alice, _) = pair();
        let a = alice.seal(&Envelope::text([0; 16], 0, "hi").unwrap()).unwrap();
        let b = alice.seal(&Envelope::text([0; 16], 0, &"x".repeat(450)).unwrap()).unwrap();
        assert_eq!(a.len(), b.len());
    }

    #[test]
    fn state_survives_export_and_import() {
        let (alice, mut bob) = pair();
        let mut alice = Friendship::import_state(&alice.export_state().unwrap()).unwrap();
        let env = Envelope::text([3; 16], 0, "after restart").unwrap();
        assert_eq!(bob.open(&alice.seal(&env).unwrap()).unwrap(), Opened::Message(env));
    }

    #[test]
    fn a_stranger_cannot_open() {
        let (mut alice, _) = pair();
        let (_, mut eve) = pair();
        let ct = alice.seal(&Envelope::text([0; 16], 0, "secret").unwrap()).unwrap();
        assert!(eve.open(&ct).is_err());
    }

    #[test]
    fn a_replayed_message_is_refused() {
        let (mut alice, mut bob) = pair();
        let ct = alice.seal(&Envelope::text([4; 16], 0, "once").unwrap()).unwrap();
        assert!(matches!(bob.open(&ct).unwrap(), Opened::Message(_)));
        assert!(bob.open(&ct).is_err(), "MLS deletes each message key after use");
        // Bob's own message, reflected back to him, does not open either.
        let mine = bob.seal(&Envelope::text([5; 16], 0, "mine").unwrap()).unwrap();
        assert!(bob.open(&mine).is_err());
        assert!(bob.open(&[0u8; 64]).is_err());
    }

    #[test]
    fn labelled_boxes_open_only_under_their_label() {
        let key = [9u8; 32];
        let b = seal_labelled(&key, b"mailbox/1", b"data");
        assert_eq!(open_labelled(&key, b"mailbox/1", &b).unwrap(), b"data");
        assert!(open_labelled(&key, b"mailbox/2", &b).is_err());
        assert!(open_labelled(&[8u8; 32], b"mailbox/1", &b).is_err());
        let mut t = b.clone();
        *t.last_mut().unwrap() ^= 1;
        assert!(open_labelled(&key, b"mailbox/1", &t).is_err());
        assert!(open_labelled(&key, b"x", &[0; 10]).is_err());
        assert_ne!(b, seal_labelled(&key, b"mailbox/1", b"data"), "fresh nonce each time");
    }
}
