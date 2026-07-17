//! Argon2id key derivation: passphrase + salt + params -> 32-byte UKEK.

use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroizing;

use crate::{vault::KdfParams, CryptoError};

/// Canonical name of the KDF compiled into this crate (`Algorithm::Argon2id`
/// below). The app's build_config.yaml assert compares against it.
pub const KDF_NAME: &str = "argon2id";

/// The only supported derived-key length; `derive_ukek` rejects anything else.
pub const KDF_OUT_LEN: u32 = 32;

/// Derive the user key-encryption key (UKEK) from a passphrase. Deterministic for a
/// given (passphrase, salt, params) — the same inputs always yield the same key, so
/// `unlock` can re-derive it. The result zeroizes on drop.
pub(crate) fn derive_ukek(
    passphrase: &str,
    salt: &[u8; 16],
    p: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if p.out_len != KDF_OUT_LEN {
        return Err(CryptoError::BadParams);
    }
    let params = Params::new(p.m_cost_kib, p.t_cost, p.p_cost, Some(32))
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, out.as_mut())
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_salt_sensitive() {
        let p = KdfParams::default();
        let a = derive_ukek("pw", &[1u8; 16], &p).unwrap();
        let b = derive_ukek("pw", &[1u8; 16], &p).unwrap();
        let c = derive_ukek("pw", &[2u8; 16], &p).unwrap(); // different salt
        let d = derive_ukek("other", &[1u8; 16], &p).unwrap(); // different pass
        assert_eq!(a.as_ref(), b.as_ref());
        assert_ne!(a.as_ref(), c.as_ref());
        assert_ne!(a.as_ref(), d.as_ref());
    }

    #[test]
    fn rejects_non_32_output() {
        let mut p = KdfParams::default();
        p.out_len = 16;
        assert_eq!(derive_ukek("pw", &[0u8; 16], &p), Err(CryptoError::BadParams));
    }
}
