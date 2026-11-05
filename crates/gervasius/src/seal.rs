//! Public-key sealing: encrypt to someone's public key, with no shared secret and
//! no prior handshake.
//!
//! Vesper's other primitives are all symmetric — a passphrase derives a key and
//! that key seals data for the same person later. That shape cannot express "only
//! Bob may open this", which is exactly what a Personal Invite needs: a QR handed
//! to Bob, unreadable by anyone else who photographs it, and carrying **no
//! decryption key of its own** (a sealed blob whose key rides alongside it would
//! be theatre).
//!
//! ## Construction
//!
//! Ephemeral-static X25519 → HKDF-SHA256 → the crate's existing XChaCha20-Poly1305:
//!
//! ```text
//! sealed = eph_pk(32) || nonce(24) || ciphertext+tag
//! shared = X25519(eph_sk, recipient_pk)
//! key    = HKDF-SHA256(ikm = shared, salt = eph_pk || recipient_pk, info = INFO)
//! ```
//!
//! Both public keys go into the HKDF salt, so a ciphertext is bound to the exact
//! recipient it was made for: it cannot be re-pointed at another key by rewriting
//! the ephemeral header. The caller's `aad` binds it further (Vesper passes the
//! invite id and format version, so a sealed body cannot be lifted into a
//! different invite).
//!
//! Forward secrecy is one-sided and that is the honest description: the ephemeral
//! key is discarded after sealing, but the recipient's key is long-lived, so
//! compromising it later opens any sealed blob that was captured. For an invite
//! that expires in hours this is the right trade; do not reach for this to protect
//! something that must stay secret for years.
//!
//! ## Identity keys as encryption keys
//!
//! Vesper knows a contact by their **iroh NodeId**, which is an Ed25519 *signing*
//! public key — the only key material a contact record holds. `x25519_from_ed25519_pk`
//! maps it onto Curve25519's Montgomery form so it can also serve as a Diffie-Hellman
//! key. This is the standard birational map (age does the same for `ssh-ed25519`
//! recipients, and libsodium ships it as `crypto_sign_ed25519_pk_to_curve25519`).
//!
//! It does mean one key pair is used for two purposes. That is a deliberate,
//! documented trade — the alternative is a second key per contact, distributed and
//! verified out of band, which Vesper has no channel for. The signing side is
//! Ed25519 (Schnorr over the Edwards form) and the sealing side is X25519 ECDH over
//! the Montgomery form; they use disjoint hash prefixes and neither protocol
//! interprets the other's messages, so the standard cross-protocol concerns do not
//! apply here. See technology.md §7.

use curve25519_dalek::edwards::CompressedEdwardsY;
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256, Sha512};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

use crate::aead::{open_with_key, seal_with_key};
use crate::CryptoError;

/// Domain separation for the HKDF step. Bumping this invalidates every previously
/// sealed blob, so it moves only alongside a format version.
const INFO: &[u8] = b"enigma/seal/x25519-hkdf-sha256/v1";

/// Length of an X25519 public key, and of the ephemeral header on a sealed blob.
pub const X25519_PK_LEN: usize = 32;

/// Convert an Ed25519 **public** key (e.g. an iroh NodeId) to its X25519 form.
///
/// Fails on bytes that are not a valid compressed Edwards point — a NodeId that
/// never came from a real key cannot be sealed to, and saying so is better than
/// sealing to a point nobody holds the secret for.
pub fn x25519_from_ed25519_pk(ed_pk: &[u8; 32]) -> Result<[u8; 32], CryptoError> {
    let point = CompressedEdwardsY(*ed_pk).decompress().ok_or(CryptoError::BadParams)?;
    // Reject the identity and other small-order points: a "public key" like that
    // forces a predictable shared secret, so treat it as malformed rather than
    // sealing something anyone could open.
    if point.is_small_order() {
        return Err(CryptoError::BadParams);
    }
    Ok(point.to_montgomery().to_bytes())
}

/// Convert an Ed25519 **secret** seed to the matching X25519 secret.
///
/// Ed25519 expands its 32-byte seed with SHA-512 and uses the low half as the
/// scalar; that same half is the X25519 secret. Clamping is applied by
/// `StaticSecret` at use, exactly as RFC 7748 requires.
pub fn x25519_from_ed25519_sk(ed_seed: &[u8; 32]) -> [u8; 32] {
    let mut wide = Sha512::digest(ed_seed);
    let mut out = [0u8; 32];
    out.copy_from_slice(&wide[..32]);
    wide.zeroize();
    out
}

/// Derive the per-message key. Salting with both public keys is what binds a
/// ciphertext to its intended recipient.
fn derive_key(shared: &[u8; 32], eph_pk: &[u8; 32], recipient_pk: &[u8; 32]) -> [u8; 32] {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(eph_pk);
    salt[32..].copy_from_slice(recipient_pk);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut key = [0u8; 32];
    // Only fails for absurd output lengths; 32 bytes from SHA-256 cannot.
    hk.expand(INFO, &mut key).expect("hkdf expand of 32 bytes");
    key
}

/// Seal `plaintext` so that only the holder of `recipient_x25519_pk` can open it.
///
/// Returns `eph_pk(32) || nonce(24) || ct+tag`. The output carries no key material
/// of its own — losing the recipient's secret is the only way to lose the plaintext,
/// and possessing the blob alone reveals nothing.
pub fn seal_to(
    recipient_x25519_pk: &[u8; 32],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let mut eph_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut eph_bytes);
    let eph_sk = StaticSecret::from(eph_bytes);
    eph_bytes.zeroize();

    let eph_pk = PublicKey::from(&eph_sk);
    let recipient = PublicKey::from(*recipient_x25519_pk);
    let shared = eph_sk.diffie_hellman(&recipient);
    // A non-contributory exchange means the peer key was small-order and the
    // shared secret is a constant every observer can compute. Fail rather than
    // produce a blob that looks sealed and is not.
    if !shared.was_contributory() {
        return Err(CryptoError::BadParams);
    }

    let mut key = derive_key(shared.as_bytes(), eph_pk.as_bytes(), recipient_x25519_pk);
    let frame = seal_with_key(&key, aad, plaintext);
    key.zeroize();

    let frame = frame?;
    let mut out = Vec::with_capacity(X25519_PK_LEN + frame.len());
    out.extend_from_slice(eph_pk.as_bytes());
    out.extend_from_slice(&frame);
    Ok(out)
}

/// Open a blob produced by `seal_to`, using our own X25519 secret.
///
/// Fails closed and coarsely: a blob for someone else, a tampered ephemeral
/// header, a flipped ciphertext bit and a mismatched `aad` are indistinguishable
/// from each other in the error.
pub fn open_sealed(
    my_x25519_sk: &[u8; 32],
    aad: &[u8],
    sealed: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < X25519_PK_LEN {
        return Err(CryptoError::Format);
    }
    let (eph_raw, frame) = sealed.split_at(X25519_PK_LEN);
    let mut eph_pk = [0u8; 32];
    eph_pk.copy_from_slice(eph_raw);

    let sk = StaticSecret::from(*my_x25519_sk);
    let my_pk = PublicKey::from(&sk);
    let shared = sk.diffie_hellman(&PublicKey::from(eph_pk));
    if !shared.was_contributory() {
        return Err(CryptoError::Aead);
    }

    // Salted with OUR public key: if the blob was sealed to somebody else this
    // derives a different key and the AEAD tag rejects it.
    let mut key = derive_key(shared.as_bytes(), &eph_pk, my_pk.as_bytes());
    let out = open_with_key(&key, aad, frame);
    key.zeroize();
    out
}

/// Our own X25519 public key, for handing to whoever will seal to us.
pub fn x25519_public(my_x25519_sk: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*my_x25519_sk)).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway X25519 pair.
    fn pair() -> ([u8; 32], [u8; 32]) {
        let mut sk = [0u8; 32];
        OsRng.fill_bytes(&mut sk);
        let pk = x25519_public(&sk);
        (sk, pk)
    }

    #[test]
    fn roundtrips_to_the_intended_recipient() {
        let (sk, pk) = pair();
        let sealed = seal_to(&pk, b"invite-1", b"capability").unwrap();
        assert_eq!(open_sealed(&sk, b"invite-1", &sealed).unwrap(), b"capability");
    }

    #[test]
    fn the_blob_reveals_nothing_by_itself() {
        // The whole point: no key material travels with the ciphertext.
        let (_sk, pk) = pair();
        let sealed = seal_to(&pk, b"", b"capability").unwrap();
        assert!(!sealed.windows(10).any(|w| w == b"capability"));
        // Header is exactly one ephemeral public key, then the AEAD frame.
        assert_eq!(sealed.len(), X25519_PK_LEN + 24 + b"capability".len() + 16);
    }

    #[test]
    fn a_different_recipient_cannot_open_it() {
        let (_sk_a, pk_a) = pair();
        let (sk_b, _pk_b) = pair();
        let sealed = seal_to(&pk_a, b"", b"secret").unwrap();
        assert_eq!(open_sealed(&sk_b, b"", &sealed), Err(CryptoError::Aead));
    }

    #[test]
    fn every_sealing_is_distinct() {
        let (sk, pk) = pair();
        let a = seal_to(&pk, b"", b"same").unwrap();
        let b = seal_to(&pk, b"", b"same").unwrap();
        assert_ne!(a, b, "fresh ephemeral key per sealing");
        assert_eq!(open_sealed(&sk, b"", &a).unwrap(), b"same");
        assert_eq!(open_sealed(&sk, b"", &b).unwrap(), b"same");
    }

    #[test]
    fn tampering_anywhere_fails_closed() {
        let (sk, pk) = pair();
        let good = seal_to(&pk, b"aad", b"payload").unwrap();

        // Ephemeral header (byte 0), nonce (byte 33) and ciphertext (last byte).
        for idx in [0usize, X25519_PK_LEN + 1, good.len() - 1] {
            let mut bad = good.clone();
            bad[idx] ^= 0x01;
            assert!(
                matches!(open_sealed(&sk, b"aad", &bad), Err(CryptoError::Aead)),
                "tamper at {idx} must fail"
            );
        }
    }

    #[test]
    fn the_aad_must_match() {
        // Vesper binds the invite id here, so a sealed body cannot be moved into
        // a different invite.
        let (sk, pk) = pair();
        let sealed = seal_to(&pk, b"invite-1", b"cap").unwrap();
        assert_eq!(open_sealed(&sk, b"invite-2", &sealed), Err(CryptoError::Aead));
    }

    #[test]
    fn truncated_input_is_malformed_not_a_decrypt_failure() {
        let (sk, _pk) = pair();
        assert_eq!(open_sealed(&sk, b"", &[0u8; 10]), Err(CryptoError::Format));
    }

    #[test]
    fn ed25519_conversion_matches_the_reference_vector() {
        // libsodium's crypto_sign_ed25519_pk_to_curve25519 over the RFC 8032
        // test-1 public key, and the matching secret-seed conversion.
        let ed_seed: [u8; 32] =
            hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        let ed_pk: [u8; 32] =
            hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        let want_x_pk: [u8; 32] =
            hex("d85e07ec22b0ad881537c2f44d662d1a143cf830c57aca4305d85c7a90f6b62e");

        assert_eq!(x25519_from_ed25519_pk(&ed_pk).unwrap(), want_x_pk);
        // And the converted seed is the secret for exactly that public key.
        assert_eq!(x25519_public(&x25519_from_ed25519_sk(&ed_seed)), want_x_pk);
    }

    #[test]
    fn a_contact_can_be_sealed_to_by_node_id_alone() {
        // The real Vesper flow: all we hold for a contact is their Ed25519 NodeId.
        let ed_seed: [u8; 32] =
            hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        let ed_pk: [u8; 32] =
            hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");

        let sealed = seal_to(&x25519_from_ed25519_pk(&ed_pk).unwrap(), b"id", b"cap").unwrap();
        let their_sk = x25519_from_ed25519_sk(&ed_seed);
        assert_eq!(open_sealed(&their_sk, b"id", &sealed).unwrap(), b"cap");
    }

    #[test]
    fn small_order_keys_are_refused_rather_than_sealed_to() {
        // The Edwards identity decompresses fine but has order 1, so the shared
        // secret would be a constant and the "sealed" blob would open for anyone.
        let identity = hex("0100000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(x25519_from_ed25519_pk(&identity), Err(CryptoError::BadParams));
    }

    #[test]
    fn an_off_curve_encoding_is_refused() {
        let mut off_curve = [0u8; 32];
        off_curve[0] = 4;
        off_curve[31] = 4;
        assert_eq!(x25519_from_ed25519_pk(&off_curve), Err(CryptoError::BadParams));
    }

    #[test]
    fn this_is_not_a_node_id_validator() {
        // Worth pinning, because it is tempting to assume otherwise: roughly half
        // of all 32-byte strings ARE valid curve points, so a successful
        // conversion says nothing about whether anyone holds the secret. `[0xff;
        // 32]` is the trap — it looks like obvious garbage and converts happily.
        assert!(x25519_from_ed25519_pk(&[0xff; 32]).is_ok());
    }

    fn hex(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
}
