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

    #[test]
    fn a_frame_sealed_by_another_implementation_opens() {
        // @noble/ciphers' XChaCha20-Poly1305, key 40..5f, nonce a0..b7, AAD
        // "frame-aad". Pins the layout — nonce FIRST, then ciphertext+tag —
        // that the platform's libsodium side and every stored blob rely on.
        let key: [u8; 32] = core::array::from_fn(|i| 0x40 + i as u8);
        let frame = unhex(
            "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7\
             02b4759d0d87b92f4f74e3440e7bd4967e01\
             05669b57ddb5e92e56adae6c8cf860",
        );
        assert_eq!(open_with_key(&key, b"frame-aad", &frame).unwrap(), b"independent bytes");
    }

    #[test]
    fn the_frame_is_exactly_nonce_plus_plaintext_plus_tag() {
        // Around ChaCha's 64-byte block, where an off-by-one would show.
        let key = [3u8; 32];
        for n in [0usize, 1, 63, 64, 65, 1000] {
            let pt = vec![0xa5u8; n];
            let ct = seal_with_key(&key, b"len", &pt).unwrap();
            assert_eq!(ct.len(), NONCE_LEN + n + TAG_LEN, "plaintext of {n}");
            assert_eq!(open_with_key(&key, b"len", &ct).unwrap(), pt, "plaintext of {n}");
        }
    }

    #[test]
    fn an_empty_plaintext_is_still_authenticated() {
        // Sealing nothing still yields a tag, so an empty blob cannot be
        // forged or moved under another AAD.
        let key = [4u8; 32];
        let ct = seal_with_key(&key, b"aad", b"").unwrap();
        assert_eq!(open_with_key(&key, b"aad", &ct).unwrap(), b"");
        assert_eq!(open_with_key(&key, b"other", &ct), Err(CryptoError::Aead));
        let mut bad = ct.clone();
        bad[NONCE_LEN] ^= 1;
        assert_eq!(open_with_key(&key, b"aad", &bad), Err(CryptoError::Aead));
    }

    #[test]
    fn the_length_floor_is_nonce_plus_tag() {
        // Below 40 bytes there is nothing to verify: malformed. At 40 the
        // frame is structurally whole and the tag is what refuses it.
        let key = [5u8; 32];
        for len in [0usize, 1, NONCE_LEN, NONCE_LEN + TAG_LEN - 1] {
            assert_eq!(open_with_key(&key, b"", &vec![0u8; len]), Err(CryptoError::Format), "len {len}");
        }
        assert_eq!(open_with_key(&key, b"", &[0u8; NONCE_LEN + TAG_LEN]), Err(CryptoError::Aead));
    }

    #[test]
    fn every_region_of_the_frame_is_authenticated() {
        let key = [6u8; 32];
        let good = seal_with_key(&key, b"aad", b"some plaintext").unwrap();
        // Nonce, ciphertext body, tag.
        for idx in [0usize, NONCE_LEN - 1, NONCE_LEN, good.len() - TAG_LEN, good.len() - 1] {
            let mut bad = good.clone();
            bad[idx] ^= 0x01;
            assert_eq!(open_with_key(&key, b"aad", &bad), Err(CryptoError::Aead), "flip at {idx}");
        }
        // Shortened or lengthened by one byte, still above the floor.
        assert_eq!(open_with_key(&key, b"aad", &good[..good.len() - 1]), Err(CryptoError::Aead));
        let mut longer = good.clone();
        longer.push(0);
        assert_eq!(open_with_key(&key, b"aad", &longer), Err(CryptoError::Aead));
    }

    #[test]
    fn the_aad_is_compared_exactly_not_as_a_prefix() {
        let key = [8u8; 32];
        let ct = seal_with_key(&key, b"ab", b"x").unwrap();
        for wrong in [&b"a"[..], b"abc", b"", b"AB", b"ba"] {
            assert_eq!(open_with_key(&key, wrong, &ct), Err(CryptoError::Aead), "{wrong:?}");
        }
        let ct = seal_with_key(&key, b"", b"x").unwrap();
        assert_eq!(open_with_key(&key, b"\0", &ct), Err(CryptoError::Aead), "empty is not a NUL");
    }

    #[test]
    fn a_nonce_cannot_be_moved_onto_another_frames_body() {
        let key = [9u8; 32];
        let a = seal_with_key(&key, b"", b"first").unwrap();
        let b = seal_with_key(&key, b"", b"other").unwrap();
        let mut spliced = a[..NONCE_LEN].to_vec();
        spliced.extend_from_slice(&b[NONCE_LEN..]);
        assert_eq!(open_with_key(&key, b"", &spliced), Err(CryptoError::Aead));
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
}
