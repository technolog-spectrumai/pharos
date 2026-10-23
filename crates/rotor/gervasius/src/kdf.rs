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

    /// Argon2id near its floor; the tests below are about the mapping from
    /// `KdfParams` to Argon2, not about cost.
    const CHEAP: KdfParams = KdfParams { m_cost_kib: 64, t_cost: 1, p_cost: 1, out_len: 32 };
    const SALT: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    fn unhex32(s: &str) -> [u8; 32] {
        core::array::from_fn(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
    }

    #[test]
    fn matches_an_independent_argon2id() {
        // @noble/hashes' argon2id, v0x13, over the same inputs. The UKEK has
        // to come out identical on every device and every future build; a
        // dependency bump or a swapped (t, p) mapping would otherwise surface
        // only as "wrong passphrase" on a vault that used to open.
        let k = derive_ukek("correct horse", &SALT, &CHEAP).unwrap();
        assert_eq!(*k, unhex32("25ce5233cc1e4d37e9bca31bfef41710e40446cd1cb575932791c5fd3780bd3c"));
        let k = derive_ukek("correct horse", &SALT, &KdfParams { t_cost: 2, ..CHEAP }).unwrap();
        assert_eq!(*k, unhex32("9c87c06898bc18516669b54a8b95d36e622946494d7a55c26f391a0406068c19"));
    }

    #[test]
    fn every_cost_parameter_is_part_of_the_key() {
        // Costs live in the header, not in code, so each one must reach
        // Argon2 — and not be confused with its neighbour.
        let keys = [
            CHEAP,
            KdfParams { m_cost_kib: 128, ..CHEAP },
            KdfParams { t_cost: 2, ..CHEAP },
            KdfParams { p_cost: 2, ..CHEAP },
        ]
        .map(|p| *derive_ukek("pw", &SALT, &p).unwrap());
        for i in 0..keys.len() {
            for j in i + 1..keys.len() {
                assert_ne!(keys[i], keys[j], "params {i} and {j} derived the same key");
            }
        }
    }

    #[test]
    fn only_a_32_byte_output_is_accepted() {
        for out_len in [0u32, 31, 33, 64] {
            let p = KdfParams { out_len, ..CHEAP };
            assert_eq!(derive_ukek("pw", &SALT, &p), Err(CryptoError::BadParams), "out_len {out_len}");
        }
        assert!(derive_ukek("pw", &SALT, &CHEAP).is_ok());
    }

    #[test]
    fn costs_argon2_rejects_are_an_error_not_a_panic() {
        // These arrive from a header on disk. Argon2's minimum memory is
        // 8 KiB per lane, so 15 KiB over 2 lanes is one short.
        for bad in [
            KdfParams { m_cost_kib: 0, ..CHEAP },
            KdfParams { m_cost_kib: 15, p_cost: 2, ..CHEAP },
            KdfParams { t_cost: 0, ..CHEAP },
            KdfParams { p_cost: 0, ..CHEAP },
        ] {
            match derive_ukek("pw", &SALT, &bad) {
                Err(CryptoError::Kdf(reason)) => assert!(!reason.is_empty(), "{bad:?}"),
                other => panic!("{bad:?} gave {:?}", other.map(|k| *k)),
            }
        }
        // And exactly the floor is accepted.
        assert!(derive_ukek("pw", &SALT, &KdfParams { m_cost_kib: 16, p_cost: 2, ..CHEAP }).is_ok());
    }

    #[test]
    fn an_empty_passphrase_derives_a_key_of_its_own() {
        let empty = derive_ukek("", &SALT, &CHEAP).unwrap();
        let space = derive_ukek(" ", &SALT, &CHEAP).unwrap();
        assert_ne!(*empty, *space);
        assert_ne!(*empty, [0u8; 32]);
    }
}
