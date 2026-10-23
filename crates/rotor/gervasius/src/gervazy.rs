//! Sealed content the platform and the desktop both read.
//!
//! ONE construction, chosen on purpose: `Argon2id(password, salt, costs)` →
//! **XChaCha20-Poly1305**, framed as `MAGIC(8) || VERSION(1) || nonce(24) ||
//! ciphertext+tag`. Both sides implement exactly this — Rust through
//! `chacha20poly1305`, Python through libsodium (PyNaCl) — and frames written
//! by either open in the other.
//!
//! XChaCha20 over AES-GCM because of the nonce. 192 bits means a random nonce
//! per seal is safe for as many messages as anyone will ever write, with no
//! counter to keep and no state to corrupt; AES-GCM's 96-bit nonce is fine
//! until the day something reuses one, and then it is catastrophic. It is also
//! what this crate already used natively, so the desktop keeps one cipher for
//! everything rather than two.
//!
//! The KDF stays gervazy's, and the salt and costs stay the SERVER'S: they
//! live on the user's strongbox row, which is what makes the same password
//! derive the same key on every device. They are parameters here, never
//! constants — a file must keep opening after the server raises its defaults.
//!
//! `legacy_fernet_open` is the one concession to history. The vault's older
//! strategies wrote `Argon2id → base64url → Fernet` (AES-128-CBC + HMAC, no
//! AAD, cleartext timestamp), and files encrypted that way must keep opening.
//! Nothing writes it any more.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use zeroize::Zeroizing;

use crate::CryptoError;

/// Every Fernet token begins with the version byte 0x80, which base64url
/// renders as this prefix. It is the whole detection story — no sidecar, no
/// registry — matching how the platform's `is_encrypted` flag corresponds to
/// Fernet bytes in storage.
pub const FERNET_PREFIX: &[u8] = b"gAAAAA";

/// The current frame's marker. A local file has no `is_encrypted` column to
/// consult, so the bytes have to say what they are.
pub const MAGIC: &[u8; 8] = b"TOTOSEAL";
pub const VERSION: u8 = 1;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = 8 + 1;

/// Whether bytes are sealed — either the current frame or a legacy token.
pub fn is_sealed(bytes: &[u8]) -> bool {
    is_current(bytes) || bytes.starts_with(FERNET_PREFIX)
}

/// Whether bytes are the CURRENT frame specifically.
pub fn is_current(bytes: &[u8]) -> bool {
    bytes.len() > HEADER_LEN && bytes.starts_with(MAGIC) && bytes[8] == VERSION
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

/// LEGACY, read path only — nothing should call this.
#[deprecated(note = "Fernet is the old vault format; seal() writes XChaCha20")]
#[allow(dead_code)]
pub fn legacy_fernet_seal(
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

/// Open a legacy Fernet token, so files sealed before 8/2026 still open.
///
/// No TTL: the platform set no expiry on file tokens, and a file that stopped
/// opening because it aged would be data loss with extra steps.
pub fn legacy_fernet_open(
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

/// The raw 32-byte key.
///
/// `derive_key` returns the base64url form because Fernet wanted text; the
/// AEAD wants the bytes. Deriving them directly skips an encode/decode round
/// trip that can only introduce a difference between the two sides.
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

/// Seal content in the shared frame.
///
/// `aad` binds the ciphertext to what it belongs to — pass something stable
/// and meaningful (the platform uses `toto:vault:file:v1`). It is NOT stored:
/// the opener must supply the same bytes, which is the point.
pub fn seal(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let key = derive_raw_key(password, salt, m_cost_kib, t_cost, p_cost)?;
    let dek = crate::Dek::from_bytes(*<&[u8; 32]>::try_from(key.as_ref()).unwrap());
    let sealed = crate::seal(&dek, aad, plaintext)?;
    let mut out = Vec::with_capacity(HEADER_LEN + sealed.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Open a frame. Wrong password and tampering both fail on the tag and are
/// deliberately indistinguishable.
pub fn open(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
    aad: &[u8],
    frame: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if !is_current(frame) || frame.len() < HEADER_LEN + NONCE_LEN + TAG_LEN {
        return Err(CryptoError::Format);
    }
    let key = derive_raw_key(password, salt, m_cost_kib, t_cost, p_cost)?;
    let dek = crate::Dek::from_bytes(*<&[u8; 32]>::try_from(key.as_ref()).unwrap());
    crate::open(&dek, aad, &frame[HEADER_LEN..])
}

/// Open whatever it is: the current frame, or a legacy Fernet token.
///
/// One door, because every caller wants the same thing — the plaintext — and
/// which era a file comes from is not their business. Legacy tokens carry no
/// AAD, so the argument is ignored on that path; that is a property of the old
/// format, not a choice made here.
pub fn open_any(
    password: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
    aad: &[u8],
    bytes: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if is_current(bytes) {
        return open(password, salt, m_cost_kib, t_cost, p_cost, aad, bytes);
    }
    let token = std::str::from_utf8(bytes).map_err(|_| CryptoError::Format)?;
    legacy_fernet_open(password, salt, m_cost_kib, t_cost, p_cost, token)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const AAD: &[u8] = b"toto:vault:file:v1";

    #[test]
    fn round_trips_and_is_self_describing() {
        let frame = seal("pw", &SALT, 19456, 2, 1, AAD, b"bytes").unwrap();
        assert!(is_current(&frame), "a sealed file must announce itself");
        assert!(is_sealed(&frame));
        assert_eq!(open("pw", &SALT, 19456, 2, 1, AAD, &frame).unwrap(), b"bytes");
    }

    #[test]
    fn plaintext_is_not_mistaken_for_a_frame() {
        // The detector decides whether a file gets a padlock and whether an
        // unlock is even offered, so a false positive is a file the app
        // refuses to open for no reason.
        for plain in [&b"hello"[..], b"", b"TOTOSEA", b"<svg xmlns=\"x\"/>"] {
            assert!(!is_current(plain), "{plain:?}");
            assert!(!is_sealed(plain), "{plain:?}");
        }
    }

    #[test]
    fn wrong_password_and_tampering_are_indistinguishable() {
        let mut frame = seal("pw", &SALT, 19456, 2, 1, AAD, b"bytes").unwrap();
        assert_eq!(open("nope", &SALT, 19456, 2, 1, AAD, &frame), Err(CryptoError::Aead));
        let last = frame.len() - 1;
        frame[last] ^= 1;
        assert_eq!(open("pw", &SALT, 19456, 2, 1, AAD, &frame), Err(CryptoError::Aead));
    }

    #[test]
    fn the_aad_is_binding() {
        // What Fernet could not express: a frame cannot be moved to another
        // file and still open.
        let frame = seal("pw", &SALT, 19456, 2, 1, b"file:a", b"secret").unwrap();
        assert_eq!(open("pw", &SALT, 19456, 2, 1, b"file:b", &frame), Err(CryptoError::Aead));
    }

    #[test]
    fn the_costs_are_part_of_the_key() {
        let frame = seal("pw", &SALT, 19456, 2, 1, AAD, b"bytes").unwrap();
        assert_eq!(open("pw", &SALT, 19456, 3, 1, AAD, &frame), Err(CryptoError::Aead));
    }

    #[test]
    fn legacy_fernet_tokens_still_open() {
        // Files sealed before 8/2026 must keep opening; nothing writes this.
        #[allow(deprecated)]
        let token = legacy_fernet_seal("pw", &SALT, 19456, 2, 1, b"old bytes").unwrap();
        assert!(is_sealed(token.as_bytes()));
        assert!(!is_current(token.as_bytes()));
        assert_eq!(
            open_any("pw", &SALT, 19456, 2, 1, AAD, token.as_bytes()).unwrap(),
            b"old bytes",
        );
    }

    #[test]
    fn open_any_takes_either_era() {
        let new = seal("pw", &SALT, 19456, 2, 1, AAD, b"new").unwrap();
        assert_eq!(open_any("pw", &SALT, 19456, 2, 1, AAD, &new).unwrap(), b"new");
    }

    // The cases below run at Argon2's floor: they are about framing and
    // refusals, and the costs are parameters anyway.

    #[test]
    fn a_bare_header_is_not_a_frame() {
        // MAGIC and VERSION with nothing after them is the detector's edge:
        // the badge has to go on content, not on a nine-byte stub.
        let mut stub = MAGIC.to_vec();
        stub.push(VERSION);
        assert!(!is_current(&stub));
        assert!(!is_sealed(&stub));
        stub.push(0);
        assert!(is_current(&stub), "one byte past the header is a (short) frame");

        // The right magic under an unknown version is not this frame.
        let mut future = MAGIC.to_vec();
        future.push(VERSION + 1);
        future.extend_from_slice(&[0u8; 64]);
        assert!(!is_current(&future));
        assert!(!is_sealed(&future));
    }

    #[test]
    fn a_frame_too_short_for_nonce_and_tag_is_malformed() {
        // Refused before any key is derived: there is nothing to verify, and a
        // short read must not cost a second of Argon2 to reject.
        let mut short = MAGIC.to_vec();
        short.push(VERSION);
        short.extend_from_slice(&[0u8; NONCE_LEN + TAG_LEN - 1]);
        assert_eq!(open("pw", &SALT, 64, 1, 1, AAD, &short), Err(CryptoError::Format));
        assert_eq!(open("pw", &SALT, 64, 1, 1, AAD, b"not a frame at all"), Err(CryptoError::Format));

        // At exactly header + nonce + tag the frame is whole; the tag decides.
        short.push(0);
        assert_eq!(open("pw", &SALT, 64, 1, 1, AAD, &short), Err(CryptoError::Aead));
    }

    #[test]
    fn a_frame_from_one_salt_does_not_open_under_another() {
        // The salt is the server's, per strongbox row: two users with the same
        // password must not be able to open each other's files.
        let frame = seal("pw", &SALT, 64, 1, 1, AAD, b"bytes").unwrap();
        let mut other = SALT;
        other[15] ^= 1;
        assert_eq!(open("pw", &other, 64, 1, 1, AAD, &frame), Err(CryptoError::Aead));
    }

    #[test]
    fn open_any_refuses_bytes_of_neither_era() {
        // Not a frame and not text, so not a token either: malformed.
        assert_eq!(
            open_any("pw", &SALT, 64, 1, 1, AAD, &[0xff, 0xfe, 0x00, 0x80]),
            Err(CryptoError::Format)
        );
        // Text that is not a Fernet token fails the way a wrong password does —
        // coarse on purpose, like every other refusal here.
        assert_eq!(open_any("pw", &SALT, 64, 1, 1, AAD, b"hello"), Err(CryptoError::Aead));
    }

    #[test]
    fn a_legacy_token_with_a_trailing_newline_still_opens() {
        // Token files went through editors and shells that append a newline;
        // a file must not stop opening because of one.
        #[allow(deprecated)]
        let token = legacy_fernet_seal("pw", &SALT, 64, 1, 1, b"old").unwrap();
        let saved = format!("{token}\n");
        assert_eq!(open_any("pw", &SALT, 64, 1, 1, AAD, saved.as_bytes()).unwrap(), b"old");
        assert_eq!(legacy_fernet_open("pw", &SALT, 64, 1, 1, &format!("{token} \r\n")).unwrap(), b"old");
    }

    #[test]
    fn a_legacy_token_refuses_the_wrong_password_and_tampering() {
        #[allow(deprecated)]
        let token = legacy_fernet_seal("pw", &SALT, 64, 1, 1, b"old").unwrap();
        assert_eq!(legacy_fernet_open("nope", &SALT, 64, 1, 1, &token), Err(CryptoError::Aead));
        // Swap one base64 character in the middle of the token's ciphertext.
        let mut bytes = token.into_bytes();
        let mid = bytes.len() / 2;
        bytes[mid] = if bytes[mid] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert_eq!(legacy_fernet_open("pw", &SALT, 64, 1, 1, &tampered), Err(CryptoError::Aead));
    }

    #[test]
    fn the_fernet_key_is_the_raw_key_in_base64url() {
        // The two eras must derive the SAME key from the same row: Fernet just
        // wanted it as text. If these drifted, a password that opens a legacy
        // file would fail on its re-sealed copy.
        let text = derive_key("pw", &SALT, 64, 1, 1).unwrap();
        let raw = derive_raw_key("pw", &SALT, 64, 1, 1).unwrap();
        assert_eq!(text, base64::engine::general_purpose::URL_SAFE.encode(raw.as_ref()));
        assert_eq!(text.len(), 44, "32 bytes, padded base64url");
    }

    #[test]
    fn costs_argon2_rejects_are_an_error_on_every_path() {
        for (m, t, p) in [(0, 1, 1), (64, 0, 1), (64, 1, 0)] {
            assert!(matches!(derive_raw_key("pw", &SALT, m, t, p), Err(CryptoError::Kdf(_))), "{m}/{t}/{p}");
            assert!(matches!(derive_key("pw", &SALT, m, t, p), Err(CryptoError::Kdf(_))), "{m}/{t}/{p}");
            assert!(matches!(seal("pw", &SALT, m, t, p, AAD, b"x"), Err(CryptoError::Kdf(_))), "{m}/{t}/{p}");
        }
        // Argon2's salt floor is 8 bytes; the server's is 16, but a corrupt
        // row must still come back as an error.
        assert!(matches!(derive_raw_key("pw", &[0u8; 4], 64, 1, 1), Err(CryptoError::Kdf(_))));
    }
}

#[cfg(test)]
mod cross_language {
    //! The interop, from this side. `SHARED_IN` is a frame Python sealed;
    //! `SHARED_OUT` receives one for Python to open. Run with --ignored, and
    //! the platform half lives in toto/gervazy/tests_sealed.py.
    use super::*;

    const AAD: &[u8] = b"toto:vault:file:v1";

    fn salt() -> Vec<u8> { (0u8..16).collect() }

    #[test]
    #[ignore]
    fn opens_a_frame_python_sealed() {
        let frame = std::fs::read(std::env::var("SHARED_IN").unwrap()).unwrap();
        assert!(is_current(&frame), "python wrote a frame this side does not recognise");
        let plain = open("correct horse", &salt(), 65536, 3, 4, AAD, &frame)
            .expect("python's frame must open here");
        assert_eq!(plain, b"python sealed with the shared frame\n");
    }

    #[test]
    #[ignore]
    fn writes_a_frame_python_can_open() {
        let frame = seal("correct horse", &salt(), 65536, 3, 4, AAD,
                         b"rust sealed with the shared frame\n").unwrap();
        std::fs::write(std::env::var("SHARED_OUT").unwrap(), frame).unwrap();
    }
}

#[cfg(test)]
mod xchacha_interop {
    //! Can XChaCha20-Poly1305 be the format on BOTH sides? This emits a frame
    //! from the crate's NATIVE envelope so the Python side can try to open it
    //! with libsodium. `cargo test --ignored emit_xchacha`.
    use super::*;
    use crate::Dek;

    #[test]
    #[ignore]
    fn emit_xchacha_frame_for_python() {
        let out = std::env::var("XCHACHA_OUT").expect("XCHACHA_OUT");
        let salt: Vec<u8> = (0u8..16).collect();
        let key = derive_raw_key("correct horse", &salt, 65536, 3, 4).unwrap();
        let mut raw = [0u8; 32];
        raw.copy_from_slice(key.as_ref());
        let dek = Dek::from_bytes(raw);
        // nonce(24) || ciphertext+tag — the native frame, AAD bound.
        let sealed = crate::seal(&dek, b"toto:vault:file:v1", b"one cipher, both sides\n").unwrap();
        std::fs::write(out, sealed).unwrap();
    }
}

#[cfg(test)]
mod xchacha_from_python {
    //! The reverse direction: a frame libsodium sealed, opened here.
    //! `XCHACHA_IN=<file> cargo test --ignored opens_python`.
    use super::*;
    use crate::Dek;

    #[test]
    #[ignore]
    fn opens_python_xchacha_frame() {
        let path = std::env::var("XCHACHA_IN").expect("XCHACHA_IN");
        let salt: Vec<u8> = (0u8..16).collect();
        let key = derive_raw_key("correct horse", &salt, 65536, 3, 4).unwrap();
        let mut raw = [0u8; 32];
        raw.copy_from_slice(key.as_ref());
        let dek = Dek::from_bytes(raw);
        let frame = std::fs::read(path).unwrap();
        let plain = crate::open(&dek, b"toto:vault:file:v1", &frame).expect("libsodium frame");
        assert_eq!(plain, b"python sealed this\n");
    }
}
