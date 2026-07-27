//! Sealed room invites — the crypto behind the faros invite rendezvous.
//!
//! A room ticket is a BEARER CREDENTIAL: whoever holds it can reach the room
//! and, with today's auto-admit MLS flow, be added to the group. So an invite
//! that travels through a server must be sealed to the recipient and readable
//! by nobody else — least of all the server brokering it.
//!
//! Construction:
//!   * **Confidentiality** — HPKE single-shot seal (DHKEM-X25519 / HKDF-SHA256
//!     / ChaCha20Poly1305), the same primitive already vendored with openmls.
//!     The recipient is addressed by their iroh NodeId: an Ed25519 public key
//!     converted to X25519 (`to_montgomery`), the standard libsodium
//!     `crypto_sign_ed25519_pk_to_curve25519` trick. Our own DH scalar comes
//!     from the same identity key via `SigningKey::to_scalar_bytes`.
//!   * **Sender authenticity** — HPKE base mode is anonymous, and the direct
//!     (iroh) invite gets authenticity for free from the QUIC NodeId. We must
//!     not lose it here, so the envelope is signed with the sender's identity
//!     key and carries its NodeId; the recipient verifies before trusting a
//!     word of it.
//!   * **Binding** — `info` is a fixed domain-separation string (the key does
//!     double duty for signing and DH, so separation matters), and the AAD
//!     binds recipient ‖ sender ‖ expiry, so a sealed invite cannot be
//!     replayed at another device or stripped of its expiry.
//!
//! The wire form is postcard + base32 (lowercase, no padding), matching the
//! ticket idiom used everywhere else in the app.

use anyhow::{anyhow, Result};
use curve25519_dalek::edwards::CompressedEdwardsY;
use data_encoding::BASE32_NOPAD;
use iroh::{PublicKey, SecretKey};
use openmls_rust_crypto::RustCrypto;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::{HpkeAeadType, HpkeCiphertext, HpkeConfig, HpkeKdfType, HpkeKemType};
use serde::{Deserialize, Serialize};

/// Domain separation for the HPKE context. Bump the version if the payload
/// shape changes in an incompatible way.
const HPKE_INFO: &[u8] = b"enigma/invite-rdv/v1";
/// Domain separation for the envelope signature (distinct from HPKE's `info`
/// so a signature can never be confused with a KEM context).
const SIG_CONTEXT: &[u8] = b"enigma/invite-rdv/v1/sig";

const HPKE: HpkeConfig = HpkeConfig(
    HpkeKemType::DhKem25519,
    HpkeKdfType::HkdfSha256,
    HpkeAeadType::ChaCha20Poly1305,
);

/// What the recipient actually gets: enough to join, and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitePayload {
    pub v: u8,
    /// Room display name (shown in the prompt before the user accepts).
    pub room_name: String,
    /// The room ticket — the credential this whole module exists to protect.
    pub ticket: String,
}

/// The sealed envelope as stored by the server: opaque bytes plus the routing
/// and verification metadata needed to open it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Envelope {
    v: u8,
    /// Sender's NodeId — the signature below is checked against it.
    from: [u8; 32],
    /// Recipient's NodeId; also bound into the AAD.
    to: [u8; 32],
    /// Unix seconds. Bound into the AAD, because the underlying ticket never
    /// rotates — server-side TTL alone is not a revocation story.
    exp: u64,
    kem_output: Vec<u8>,
    ciphertext: Vec<u8>,
    /// Ed25519 signature over SIG_CONTEXT ‖ the fields above.
    sig: Vec<u8>,
}

/// Bytes a signature covers, and (minus the signature) the AAD.
fn binding(from: &[u8; 32], to: &[u8; 32], exp: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(72);
    out.extend_from_slice(from);
    out.extend_from_slice(to);
    out.extend_from_slice(&exp.to_be_bytes());
    out
}

fn signed_bytes(env: &Envelope) -> Vec<u8> {
    let mut out = Vec::from(SIG_CONTEXT);
    out.extend_from_slice(&binding(&env.from, &env.to, env.exp));
    out.extend_from_slice(&env.kem_output);
    out.extend_from_slice(&env.ciphertext);
    out
}

/// Ed25519 public key → X25519, rejecting keys with no valid curve point and
/// small-order keys (which would collapse the DH shared secret).
fn to_x25519_public(node_id: &PublicKey) -> Result<[u8; 32]> {
    let point = CompressedEdwardsY(*node_id.as_bytes())
        .decompress()
        .ok_or_else(|| anyhow!("recipient key is not a valid curve point"))?;
    if point.is_small_order() {
        return Err(anyhow!("recipient key is small order"));
    }
    Ok(point.to_montgomery().to_bytes())
}

/// Our Ed25519 identity key → the X25519 scalar for the same key pair.
fn to_x25519_secret(secret: &SecretKey) -> [u8; 32] {
    secret.as_signing_key().to_scalar_bytes()
}

/// Seal an invite to `recipient`, signed by `sender`. Returns the base32 blob
/// to hand to the server.
pub fn seal_invite(
    sender: &SecretKey,
    recipient: &PublicKey,
    payload: &InvitePayload,
    exp_unix: u64,
) -> Result<String> {
    let pk_r = to_x25519_public(recipient)?;
    let from = *sender.public().as_bytes();
    let to = *recipient.as_bytes();
    let aad = binding(&from, &to, exp_unix);
    let ptxt = postcard::to_allocvec(payload).map_err(|e| anyhow!("encode payload: {e}"))?;

    let sealed = RustCrypto::default()
        .hpke_seal(HPKE, &pk_r, HPKE_INFO, &aad, &ptxt)
        .map_err(|e| anyhow!("hpke seal failed: {e:?}"))?;

    let mut env = Envelope {
        v: 1,
        from,
        to,
        exp: exp_unix,
        kem_output: sealed.kem_output.as_slice().to_vec(),
        ciphertext: sealed.ciphertext.as_slice().to_vec(),
        sig: Vec::new(),
    };
    env.sig = sender.sign(&signed_bytes(&env)).to_bytes().to_vec();

    let bytes = postcard::to_allocvec(&env).map_err(|e| anyhow!("encode envelope: {e}"))?;
    Ok(BASE32_NOPAD.encode(&bytes).to_lowercase())
}

/// Who sent an invite, and what they sent.
#[derive(Debug, Clone)]
pub struct OpenedInvite {
    pub from: PublicKey,
    pub payload: InvitePayload,
    pub exp: u64,
}

/// Open a sealed invite: verify the sender's signature, check addressing and
/// expiry, then decrypt. Every failure is fatal — never fall back to trusting
/// unverified content.
pub fn open_invite(me: &SecretKey, blob: &str, now_unix: u64) -> Result<OpenedInvite> {
    let bytes = BASE32_NOPAD
        .decode(blob.trim().to_uppercase().as_bytes())
        .map_err(|_| anyhow!("invite is not valid base32"))?;
    let env: Envelope =
        postcard::from_bytes(&bytes).map_err(|e| anyhow!("malformed invite: {e}"))?;
    if env.v != 1 {
        return Err(anyhow!("unsupported invite version {}", env.v));
    }

    let from = PublicKey::from_bytes(&env.from).map_err(|_| anyhow!("bad sender key"))?;
    let sig_bytes: [u8; 64] = env
        .sig
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("bad signature length"))?;
    from.verify(&signed_bytes(&env), &iroh::Signature::from_bytes(&sig_bytes))
        .map_err(|_| anyhow!("invite signature does not verify"))?;

    if env.to != *me.public().as_bytes() {
        return Err(anyhow!("invite is addressed to another device"));
    }
    if env.exp <= now_unix {
        return Err(anyhow!("invite has expired"));
    }

    let aad = binding(&env.from, &env.to, env.exp);
    let sealed = HpkeCiphertext {
        kem_output: env.kem_output.clone().into(),
        ciphertext: env.ciphertext.clone().into(),
    };
    let ptxt = RustCrypto::default()
        .hpke_open(HPKE, &sealed, &to_x25519_secret(me), HPKE_INFO, &aad)
        .map_err(|_| anyhow!("invite could not be decrypted"))?;
    let payload: InvitePayload =
        postcard::from_bytes(&ptxt).map_err(|e| anyhow!("malformed invite payload: {e}"))?;

    Ok(OpenedInvite { from, payload, exp: env.exp })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> InvitePayload {
        InvitePayload {
            v: 1,
            room_name: "midnight".to_string(),
            ticket: "tabcdefghijklmnop".to_string(),
        }
    }

    fn keys() -> (SecretKey, SecretKey) {
        (SecretKey::generate(), SecretKey::generate())
    }

    #[test]
    fn round_trip_recovers_the_ticket_and_sender() {
        let (alice, bob) = keys();
        let blob = seal_invite(&alice, &bob.public(), &payload(), 2_000).unwrap();
        let opened = open_invite(&bob, &blob, 1_000).unwrap();
        assert_eq!(opened.payload, payload());
        assert_eq!(opened.from, alice.public());
        assert_eq!(opened.exp, 2_000);
    }

    #[test]
    fn the_blob_does_not_leak_the_ticket() {
        let (alice, bob) = keys();
        let blob = seal_invite(&alice, &bob.public(), &payload(), 2_000).unwrap();
        assert!(!blob.contains("tabcdefghijklmnop"));
        assert!(!blob.to_lowercase().contains("midnight"));
    }

    #[test]
    fn another_device_cannot_open_it() {
        let (alice, bob) = keys();
        let eve = SecretKey::generate();
        let blob = seal_invite(&alice, &bob.public(), &payload(), 2_000).unwrap();
        assert!(open_invite(&eve, &blob, 1_000).is_err());
    }

    #[test]
    fn expired_invites_are_refused() {
        let (alice, bob) = keys();
        let blob = seal_invite(&alice, &bob.public(), &payload(), 1_000).unwrap();
        assert!(open_invite(&bob, &blob, 1_000).is_err());
        assert!(open_invite(&bob, &blob, 5_000).is_err());
    }

    #[test]
    fn tampering_is_detected() {
        let (alice, bob) = keys();
        let blob = seal_invite(&alice, &bob.public(), &payload(), 2_000).unwrap();
        let mut raw = BASE32_NOPAD.decode(blob.to_uppercase().as_bytes()).unwrap();
        let mut env: Envelope = postcard::from_bytes(&raw).unwrap();

        // Re-addressing it (say, by the server) breaks the signature.
        let mallory = SecretKey::generate();
        let mut moved = env.clone();
        moved.to = *mallory.public().as_bytes();
        let moved_blob =
            BASE32_NOPAD.encode(&postcard::to_allocvec(&moved).unwrap()).to_lowercase();
        assert!(open_invite(&mallory, &moved_blob, 1_000).is_err());

        // Extending the expiry breaks it too.
        env.exp = 9_999;
        let stretched =
            BASE32_NOPAD.encode(&postcard::to_allocvec(&env).unwrap()).to_lowercase();
        assert!(open_invite(&bob, &stretched, 1_000).is_err());

        // So does flipping a ciphertext byte.
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        let flipped = BASE32_NOPAD.encode(&raw).to_lowercase();
        assert!(open_invite(&bob, &flipped, 1_000).is_err());
    }

    #[test]
    fn garbage_is_refused_without_panicking() {
        let bob = SecretKey::generate();
        for junk in ["", "not base32!", "aaaa", &"a".repeat(500)] {
            assert!(open_invite(&bob, junk, 1_000).is_err());
        }
    }

    #[test]
    fn small_order_recipient_keys_are_rejected() {
        // The all-zero Ed25519 point decompresses but is small order — sealing
        // to it would produce a degenerate shared secret.
        let alice = SecretKey::generate();
        if let Ok(pk) = PublicKey::from_bytes(&[0u8; 32]) {
            assert!(seal_invite(&alice, &pk, &payload(), 2_000).is_err());
        }
    }
}
