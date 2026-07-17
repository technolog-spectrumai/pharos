//! XChaCha20-Poly1305 AEAD. Frame = `nonce(24) || ciphertext+tag`. The 192-bit
//! nonce is random per encryption (birthday-safe for arbitrarily many blobs under
//! one key, so we never manage a counter).

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};

use crate::{CryptoError, Dek};

/// Canonical name of the AEAD compiled into this crate. Kept beside the cipher
/// use below; the app's build_config.yaml assert compares against it.
pub const AEAD_NAME: &str = "xchacha20-poly1305";

const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;

pub(crate) fn seal_with_key(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| CryptoError::BadParams)?;
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| CryptoError::Aead)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub(crate) fn open_with_key(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < NONCE_LEN + TAG_LEN {
        return Err(CryptoError::Format);
    }
    let (nonce, ct) = sealed.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| CryptoError::BadParams)?;
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| CryptoError::Aead)
}

/// Seal `plaintext` under the DEK, binding it to `aad`. Returns `nonce || ct+tag`.
pub fn seal(dek: &Dek, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    seal_with_key(dek.as_bytes(), aad, plaintext)
}

/// Open a `seal`ed frame under the DEK; `aad` must match exactly. Fails closed.
pub fn open(dek: &Dek, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    open_with_key(dek.as_bytes(), aad, sealed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_nonce_uniqueness() {
        let key = [7u8; 32];
        let a = seal_with_key(&key, b"", b"hello").unwrap();
        let b = seal_with_key(&key, b"", b"hello").unwrap();
        assert_ne!(a, b, "random nonces => distinct ciphertexts");
        assert_eq!(open_with_key(&key, b"", &a).unwrap(), b"hello");
        assert_eq!(open_with_key(&key, b"", &b).unwrap(), b"hello");
    }

    #[test]
    fn wrong_key_fails() {
        let ct = seal_with_key(&[1u8; 32], b"", b"x").unwrap();
        assert_eq!(open_with_key(&[2u8; 32], b"", &ct), Err(CryptoError::Aead));
    }
}
