//! The engine's outside: transport, mailbox, device key, storage, clock.

use ed25519_dalek::{Signer as _, SigningKey, Verifier as _, VerifyingKey};
use serde_json::Value;

use crate::types::LinkStatus;

/// A room opened on this device; `onion` is ours for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenedRoom {
    /// The slug.
    pub room: String,
    /// The name.
    pub name: String,
    /// Our onion for it: from stage b2 (enigma-client) our home Beacon's onion, which
    /// presence announces and other members pass to `set_peers`.
    pub onion: String,
}

/// The transport (mirrors `ChatTransport.ts`). Incoming frames and status come back
/// through [`crate::Engine::handle_frame`] / [`crate::Engine::handle_status`].
pub trait Transport {
    /// Host a new room.
    ///
    /// # Errors
    /// The transport's reason.
    fn create_room(&self, name: &str) -> Result<OpenedRoom, String>;
    /// Open a room and link to these onions.
    ///
    /// # Errors
    /// The transport's reason.
    fn join_room(&self, name: &str, peers: &[String]) -> Result<OpenedRoom, String>;
    /// Every other member's onion.
    fn set_peers(&self, room: &str, peers: &[String]);
    /// Abort an in-flight join.
    fn cancel_join(&self) {}
    /// Close a room's links.
    fn leave_room(&self, room: &str);
    /// Drop a room's onion (delete).
    fn forget_onion(&self, name: &str);
    /// Send a frame (JSON text) to the room.
    fn send(&self, room: &str, payload: &str);
    /// The last status known for a room.
    fn last_status(&self, _room: &str) -> Option<LinkStatus> {
        None
    }
}

/// A Beacon mailbox (mirrors `ChatMailbox` in mailbox.ts).
pub trait Mailbox {
    /// Post an envelope.
    ///
    /// # Errors
    /// The server does not answer.
    fn post(&self, body: &Value) -> Result<(), String>;
    /// One page of `(id, body)` after `after`.
    ///
    /// # Errors
    /// The server does not answer.
    fn fetch(&self, after: u64, room: &str) -> Result<Vec<(u64, String)>, String>;
    /// The mean gap between catch-ups (ms).
    fn every_ms(&self) -> u64 {
        30_000
    }
}

/// The device key (`resetAuth` + `deviceId` in TS).
pub trait Signer {
    /// This device's id: its Ed25519 public key, 64 hex. Also the MLS identity.
    fn device_id(&self) -> String;
    /// Hex signature over `msg`.
    fn sign(&self, msg: &[u8]) -> String;
    /// Whether `sig` (hex) is `device_id`'s over `msg`.
    fn verify(&self, device_id: &str, msg: &[u8], sig: &str) -> bool;
}

/// An Ed25519 device key held in memory.
pub struct Ed25519Signer(SigningKey);

impl Ed25519Signer {
    /// From a 32-byte seed.
    #[must_use]
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self(SigningKey::from_bytes(seed))
    }
}

/// Checks an Ed25519 signature by a 64-hex device id.
#[must_use]
pub fn verify_ed25519(device_id: &str, msg: &[u8], sig: &str) -> bool {
    let Some(key) = hex::decode(device_id).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else { return false };
    let Some(sig) = hex::decode(sig.trim()).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&key) else { return false };
    vk.verify(msg, &ed25519_dalek::Signature::from_bytes(&sig)).is_ok()
}

impl Signer for Ed25519Signer {
    fn device_id(&self) -> String {
        hex::encode(self.0.verifying_key().to_bytes())
    }
    fn sign(&self, msg: &[u8]) -> String {
        hex::encode(self.0.sign(msg).to_bytes())
    }
    fn verify(&self, device_id: &str, msg: &[u8], sig: &str) -> bool {
        verify_ed25519(device_id, msg, sig)
    }
}

/// What a reset request is signed over (same as `device.rs`' `reset_message`).
#[must_use]
pub fn reset_message(room: &str, reset_id: &str, ts: u64) -> Vec<u8> {
    format!("enigma27-reset\0{room}\0{reset_id}\0{ts}").into_bytes()
}

/// Small key/value storage (`KvBackend`): saved rooms, admitted flags, mailbox place, log.
pub trait Kv {
    /// Read.
    fn get(&self, ns: &str, key: &str) -> Option<String>;
    /// Write.
    fn put(&self, ns: &str, key: &str, value: &str);
    /// Delete.
    fn delete(&self, ns: &str, key: &str);
}

/// Time (ms since the epoch).
pub trait Clock {
    /// Now.
    fn now_ms(&self) -> u64;
}

/// The system clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
    }
}
