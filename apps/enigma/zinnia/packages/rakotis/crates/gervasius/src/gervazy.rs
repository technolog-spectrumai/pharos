//! The gervazy construction — the toto platform's file-vault crypto, exactly.
//!
//! `Argon2id(password, salt, costs) → base64url → Fernet`. This is what
//! zenobia's `UserStrongbox.derive_key` + `cryptography.fernet.Fernet` do, so
//! a file sealed through this module decrypts on the platform and a
//! platform-encrypted file decrypts here. gervasius came FROM gervazy
//! originally (see lib.rs); this module closes the circle for the one place
//! the two must produce identical bytes: files that cross between a desktop
//! and a server.
//!
//! TWO constructions live here, because the platform has two:
//!
//!   * `seal`/`open` — Argon2id → base64url → **Fernet**, which is what
//!     `toto.vault.strategy.*` uses today. Kept because files encrypted that
//!     way exist and must keep opening. Note what it is: AES-**128**-CBC +
//!     HMAC-SHA256 (Fernet splits the 32-byte key in half), no AAD, and a
//!     cleartext timestamp in every token.
//!   * `gcm_seal`/`gcm_open` — Argon2id → **AES-256-GCM**, which is what
//!     `toto.gervazy.crypto` uses, and what this crate was ported FROM. Real
//!     256-bit encryption, and an AAD that binds a value to what it belongs
//!     to — the thing Fernet cannot express, and the reason a Fernet token can
//!     be moved between files undetected.
//!
//! The second is where file locking should end up on both sides. It is the
//! only AEAD they can share: Python's `cryptography` ships AES-GCM and
//! ChaCha20-Poly1305 but not XChaCha20-Poly1305, so this crate's NATIVE
//! envelope (XChaCha20, in vault.rs) can never be the common format without
//! adding libsodium to the server. That native envelope stays what it is and
//! remains right for protasius, which never crosses the wire.
//!
//! Costs are parameters, not constants: the server owns them per user, and a
//! file must keep opening after the server raises its defaults for new users.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use zeroize::Zeroizing;

use crate::CryptoError;

/// Every Fernet token begins with the version byte 0x80, which base64url
/// renders as this prefix. It is the whole detection story — no sidecar, no
/// registry — matching how the platform's `is_encrypted` flag corresponds to
/// Fernet bytes in storage.
pub const FERNET_PREFIX: &[u8] = b"gAAAAA";

/// Whether bytes look like a gervazy-sealed value.
pub fn is_sealed(bytes: &[u8]) -> bool {
    bytes.starts_with(FERNET_PREFIX)
}

/// `Argon2id(password, salt) → base64url`, the platform's key shape.
///
/// Version 0x13, raw output, the salt used as-is — any deviation is a key that
/// silently never matches the server's. The intermediate raw key zeroizes; the
/// returned string is what Fernet consumes and lives as long as the caller
/// needs it.
pub fn derive_key(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<String, CryptoError> {
    let params = Params::new(m_cost_kib, t_cost, p_cost, Some(32))
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(base64::engine::general_purpose::URL_SAFE.encode(out.as_ref()))
}

fn fernet_from(key: &str) -> Result<fernet::Fernet, CryptoError> {
    fernet::Fernet::new(key).ok_or(CryptoError::BadParams)
}

/// Seal bytes as a platform-compatible Fernet token (UTF-8/ASCII text).
pub fn seal(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
    plaintext: &[u8],
) -> Result<String, CryptoError> {
    let key = derive_key(password, salt, m_cost_kib, t_cost, p_cost)?;
    Ok(fernet_from(&key)?.encrypt(plaintext))
}

/// Open a token. Wrong password and tampering both fail on the HMAC and both
/// surface as `Aead` — deliberately indistinguishable, like the native AEAD.
///
/// No TTL: the platform sets no expiry on file tokens, and a file that stopped
/// opening because it aged would be data loss with extra steps.
pub fn open(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
    token: &str,
) -> Result<Vec<u8>, CryptoError> {
    let key = derive_key(password, salt, m_cost_kib, t_cost, p_cost)?;
    fernet_from(&key)?
        .decrypt(token.trim_end())
        .map_err(|_| CryptoError::Aead)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    #[test]
    fn round_trips() {
        let token = seal("pw", &SALT, 19456, 2, 1, b"bytes").unwrap();
        assert!(is_sealed(token.as_bytes()));
        assert_eq!(open("pw", &SALT, 19456, 2, 1, &token).unwrap(), b"bytes");
    }

    #[test]
    fn wrong_password_and_tampering_are_indistinguishable() {
        let token = seal("pw", &SALT, 19456, 2, 1, b"bytes").unwrap();
        assert_eq!(open("nope", &SALT, 19456, 2, 1, &token), Err(CryptoError::Aead));
        let mut bad = token.into_bytes();
        let n = bad.len() - 2;
        bad[n] ^= 1;
        let bad = String::from_utf8(bad).unwrap();
        assert_eq!(open("pw", &SALT, 19456, 2, 1, &bad), Err(CryptoError::Aead));
    }

    #[test]
    fn the_costs_are_part_of_the_key() {
        // A cost mismatch must fail like a wrong password, not decrypt junk.
        let token = seal("pw", &SALT, 19456, 2, 1, b"bytes").unwrap();
        assert_eq!(open("pw", &SALT, 19456, 3, 1, &token), Err(CryptoError::Aead));
    }
}

// ── the envelope half: AES-256-GCM, as toto.gervazy.crypto does it ─────────
//
// This is the construction the platform's OWN crypto layer uses — the one this
// crate was ported from — and it is the only AEAD both sides can speak.
// Python's `cryptography` ships AES-GCM and ChaCha20-Poly1305 but NOT
// XChaCha20-Poly1305, so the native envelope above can never be the shared
// format without adding libsodium to the server. AES-256-GCM can, today, on
// both sides, with no new dependency anywhere.
//
// Frame: `nonce(12) || ciphertext+tag(16)`. gervazy's helpers hand back the
// nonce separately; concatenating it is the obvious way to make one byte
// stream out of them, and matches how this crate frames its native AEAD.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

/// 12 bytes — `AES_GCM_NONCE_SIZE` on the platform side, which validates it.
const GCM_NONCE_LEN: usize = 12;
const GCM_TAG_LEN: usize = 16;

/// The raw 32-byte key, before gervazy's base64url wrapper.
///
/// `derive_key` returns the base64url form because Fernet wants text;
/// `decode_derived_key` on the platform turns it back into these bytes for
/// AES-GCM. Deriving the raw form directly skips a round trip that can only
/// introduce a difference.
pub fn derive_raw_key(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let params = Params::new(m_cost_kib, t_cost, p_cost, Some(32))
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(out)
}

/// Seal with AES-256-GCM under the platform's construction.
pub fn gcm_seal(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let key = derive_raw_key(password, salt, m_cost_kib, t_cost, p_cost)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| CryptoError::BadParams)?;
    let mut nonce = [0u8; GCM_NONCE_LEN];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| CryptoError::Aead)?;
    let mut out = Vec::with_capacity(GCM_NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Open an AES-256-GCM frame. Wrong password and tampering both fail on the
/// tag and are indistinguishable, as everywhere else in this crate.
pub fn gcm_open(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
    aad: &[u8],
    frame: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if frame.len() < GCM_NONCE_LEN + GCM_TAG_LEN {
        return Err(CryptoError::Format);
    }
    let key = derive_raw_key(password, salt, m_cost_kib, t_cost, p_cost)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| CryptoError::BadParams)?;
    let (nonce, ct) = frame.split_at(GCM_NONCE_LEN);
    cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| CryptoError::Aead)
}

#[cfg(test)]
mod gcm_tests {
    use super::*;
    use base64::Engine as _;

    fn fx() -> serde_json::Value {
        serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests_fixtures_gcm.json"
            ))
            .expect("fixture"),
        )
        .unwrap()
    }

    /// Sealed by `toto.gervazy.crypto.aes_gcm_encrypt` — the PLATFORM's own
    /// function — and opened here. This is the proof that one construction can
    /// serve both sides, which is the whole reason for this module.
    #[test]
    fn opens_what_the_platform_sealed() {
        let f = fx();
        let salt = base64::engine::general_purpose::STANDARD
            .decode(f["salt_b64"].as_str().unwrap())
            .unwrap();
        let frame = base64::engine::general_purpose::STANDARD
            .decode(f["frame_b64"].as_str().unwrap())
            .unwrap();
        let plain = gcm_open(
            f["password"].as_str().unwrap(),
            &salt,
            f["memory_cost"].as_u64().unwrap() as u32,
            f["iterations"].as_u64().unwrap() as u32,
            f["lanes"].as_u64().unwrap() as u32,
            f["aad"].as_str().unwrap().as_bytes(),
            &frame,
        )
        .expect("platform frame must open");
        assert_eq!(plain, f["plaintext"].as_str().unwrap().as_bytes());
    }

    #[test]
    fn the_aad_is_binding() {
        // The property Fernet cannot express, and the reason the file vault's
        // current scheme lets a token be moved between files.
        let f = fx();
        let salt = base64::engine::general_purpose::STANDARD
            .decode(f["salt_b64"].as_str().unwrap())
            .unwrap();
        let sealed = gcm_seal("pw", &salt, 19456, 2, 1, b"file:a", b"secret").unwrap();
        assert_eq!(
            gcm_open("pw", &salt, 19456, 2, 1, b"file:b", &sealed),
            Err(CryptoError::Aead),
        );
        assert_eq!(
            gcm_open("pw", &salt, 19456, 2, 1, b"file:a", &sealed).unwrap(),
            b"secret",
        );
    }
}
