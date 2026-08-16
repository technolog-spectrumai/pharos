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
//! It exists BESIDE the native envelope, not instead of it. The native
//! XChaCha20-Poly1305 vault stays what it is — per-value AAD, wrapped DEKs, a
//! self-describing header — and remains the right tool for app-internal
//! storage (protasius). This module is for content that must be portable to
//! the platform, which fixes the construction: Fernet (AES-128-CBC +
//! HMAC-SHA256), the salt held server-side, no header of our own, because the
//! other implementation already exists and cannot be changed from here.
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
