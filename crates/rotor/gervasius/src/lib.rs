//! Encryption-at-rest primitives for Enigma (and reusable elsewhere).
//!
//! Envelope: `passphrase --Argon2id--> UKEK --wraps--> DEK --XChaCha20-Poly1305--> data`.
//! Two tiers (no VMK): Enigma has a single data scope, so the UKEK wraps one random
//! DEK directly. Changing the passphrase re-wraps only that DEK (`rewrap`), so no
//! data is ever re-encrypted. Wrong passphrase fails closed (the AEAD tag on the
//! wrapped DEK is the verifier). All key material zeroizes on drop.
//!
//! This crate is pure and I/O-free: callers (e.g. `protasius`) persist the
//! `VaultHeader` and the sealed blobs. Ported from toto's `gervazy` crypto layer.

use zeroize::ZeroizeOnDrop;

mod aead;
mod kdf;
mod seal;
mod vault;

pub use aead::{open, seal, AEAD_NAME};
pub use kdf::{KDF_NAME, KDF_OUT_LEN};
#[cfg(feature = "gervazy")]
pub mod gervazy;

pub use seal::{
    open_sealed, seal_to, x25519_from_ed25519_pk, x25519_from_ed25519_sk, x25519_public,
    X25519_PK_LEN,
};
pub use vault::{create_vault, create_vault_with_params, rewrap, unlock, KdfParams, VaultHeader};

/// A 32-byte data-encryption key, zeroized on drop. Obtained from `create_vault`
/// or `unlock`; used with `seal`/`open`.
#[derive(Clone, ZeroizeOnDrop)]
pub struct Dek([u8; 32]);

impl Dek {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Rebuild a DEK from raw bytes. Used by protasius to re-seal its panic-code
    /// sidecar during a normal session: the panic slot's DEK is stashed (wrapped
    /// under the real DEK) at arm time, then unwrapped here to seal without needing
    /// the panic passphrase. Additive only — no algorithm or format change.
    pub fn from_bytes(bytes: [u8; 32]) -> Dek {
        Dek(bytes)
    }
}

/// Errors are intentionally coarse so nothing about *why* a decrypt failed leaks
/// (wrong passphrase and tampering both surface as `Aead`).
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// Argon2id derivation failed (bad params / OOM).
    Kdf(String),
    /// AEAD open failed: wrong key/passphrase, wrong AAD, or tampered ciphertext.
    Aead,
    /// Malformed input (too short to contain a nonce+tag, wrong key length).
    Format,
    /// Invalid KDF/key parameters.
    BadParams,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::Kdf(e) => write!(f, "key derivation failed: {e}"),
            CryptoError::Aead => write!(f, "decryption failed (wrong passphrase or corrupt data)"),
            CryptoError::Format => write!(f, "malformed ciphertext"),
            CryptoError::BadParams => write!(f, "invalid crypto parameters"),
        }
    }
}

impl std::error::Error for CryptoError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip_with_aad() {
        let (_h, dek) = create_vault("correct horse").unwrap();
        let pt = b"the quick brown fox";
        let ct = seal(&dek, b"aad-1", pt).unwrap();
        assert_ne!(&ct[..], &pt[..]);
        assert_eq!(open(&dek, b"aad-1", &ct).unwrap(), pt);
        // Wrong AAD must fail.
        assert_eq!(open(&dek, b"aad-2", &ct), Err(CryptoError::Aead));
    }

    #[test]
    fn tamper_and_truncation_fail() {
        let (_h, dek) = create_vault("pw").unwrap();
        let mut ct = seal(&dek, b"", b"secret").unwrap();
        let last = ct.len() - 1;
        ct[last] ^= 0x01;
        assert_eq!(open(&dek, b"", &ct), Err(CryptoError::Aead));
        assert_eq!(open(&dek, b"", &ct[..10]), Err(CryptoError::Format));
    }

    #[test]
    fn wrong_passphrase_fails_closed() {
        let (header, _dek) = create_vault("right").unwrap();
        assert!(matches!(unlock(&header, "wrong"), Err(CryptoError::Aead)));
    }

    #[test]
    fn unlock_recovers_the_same_dek() {
        let (header, dek) = create_vault("s3cret").unwrap();
        let ct = seal(&dek, b"probe", b"payload").unwrap();
        let dek2 = unlock(&header, "s3cret").unwrap();
        assert_eq!(dek.as_bytes(), dek2.as_bytes());
        assert_eq!(open(&dek2, b"probe", &ct).unwrap(), b"payload");
    }

    #[test]
    fn rewrap_preserves_data_and_rotates_passphrase() {
        let (header, dek) = create_vault("old-pass").unwrap();
        let ct = seal(&dek, b"k", b"data").unwrap();

        let header2 = rewrap(&header, &dek, "new-pass").unwrap();
        // New passphrase opens; old no longer does.
        let dek2 = unlock(&header2, "new-pass").unwrap();
        assert!(matches!(unlock(&header2, "old-pass"), Err(CryptoError::Aead)));
        // The DEK is unchanged, so the original ciphertext still opens.
        assert_eq!(dek2.as_bytes(), dek.as_bytes());
        assert_eq!(open(&dek2, b"k", &ct).unwrap(), b"data");
        // A fresh salt was rolled.
        assert_ne!(header.salt, header2.salt);
    }

    #[test]
    fn header_serde_roundtrips() {
        let (header, _dek) = create_vault("pw").unwrap();
        let json = serde_json::to_string(&header).unwrap();
        let back: VaultHeader = serde_json::from_str(&json).unwrap();
        assert_eq!(back.version, header.version);
        assert_eq!(back.salt, header.salt);
        assert_eq!(back.wrapped_dek, header.wrapped_dek);
    }

    // ── the union of the two forks ─────────────────────────────────────────
    //
    // `gervasius` lived in two diverged copies until 2026-09-08: enigma's had
    // `seal.rs` (X25519 public-key sealing), zinnia's had `gervazy.rs` (the
    // toto platform's Argon2id -> Fernet vault, which zinnia's sealed-file
    // DETECTION depends on). Neither was a superset. These tests pin what the
    // merge is supposed to guarantee — that both halves are present, and that
    // sharing one crate did not let either change the other's behaviour.

    #[cfg(feature = "gervazy")]
    #[test]
    fn both_forks_export_their_own_surface() {
        // The regression this catches: a future tidy-up drops one `mod` line
        // from lib.rs and the crate still compiles for whichever consumer does
        // not use it, going silently missing for the other.
        //
        // enigma's half — public-key sealing.
        let sk = x25519_from_ed25519_sk(&[7u8; 32]);
        let pk = x25519_public(&sk);
        let blob = seal_to(&pk, b"aad", b"hello").unwrap();
        assert_eq!(open_sealed(&sk, b"aad", &blob).unwrap(), b"hello");
        assert_eq!(X25519_PK_LEN, 32);

        // zinnia's half — the platform vault, reached as a public module.
        assert!(gervazy::is_sealed(gervazy::FERNET_PREFIX));
        assert!(!gervazy::is_sealed(b"plain text"));
    }

    #[cfg(feature = "gervazy")]
    #[test]
    fn the_two_formats_never_claim_each_others_bytes() {
        // The property zinnia's substrate::is_sealed_file rests on: it asks
        // BOTH detectors and must get exactly one yes. If a merge ever made
        // the magics collide, a file would be routed to the wrong opener.
        let (header, dek) = create_vault("pw").unwrap();
        let vault_bytes = seal(&dek, b"aad", b"payload").unwrap();
        assert!(!gervazy::is_sealed(&vault_bytes),
            "the enigma vault's ciphertext must not read as platform-sealed");

        // And the reverse: a platform frame must not be mistaken for ours.
        // Same costs its own tests use; the params are part of the key.
        let platform = gervazy::seal("pw", &[9u8; 16], 19456, 2, 1, b"aad", b"payload").unwrap();
        assert!(gervazy::is_sealed(&platform));
        assert!(gervazy::is_current(&platform));
        // The vault header is JSON; a platform frame is not, so parsing it as
        // one must fail rather than half-succeed.
        assert!(serde_json::from_slice::<VaultHeader>(&platform).is_err());
        let _ = header;
    }

    #[test]
    fn the_shared_primitives_are_one_implementation() {
        // aead.rs and kdf.rs were byte-identical in both forks, which is why
        // the merge was safe. This asserts they still serve both halves: a
        // key derived through the vault path and used through the raw AEAD
        // path must interoperate, so nobody can fork them again by accident.
        let (_h, dek) = create_vault("shared").unwrap();
        let ct = seal(&dek, b"a", b"m").unwrap();
        assert_eq!(open(&dek, b"a", &ct).unwrap(), b"m");
        assert_eq!(AEAD_NAME, "xchacha20-poly1305");
        assert_eq!(KDF_NAME, "argon2id");
        assert_eq!(KDF_OUT_LEN, 32);
    }
}
