//! The vault envelope: create / unlock / rewrap a passphrase-wrapped DEK.

use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::aead::{open_with_key, seal_with_key};
use crate::kdf::derive_ukek;
use crate::{CryptoError, Dek};

/// AAD binding the wrapped-DEK ciphertext to its purpose (defence against a
/// cross-context ciphertext swap).
const WRAP_AAD: &[u8] = b"gervasius:dek:v1";

/// Argon2id cost parameters. Stored in the header so a vault created at one cost
/// still opens after a future default bump, and is portable across devices.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    pub out_len: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        // 64 MiB / 3 passes / 4 lanes / 32-byte key (matches toto's gervazy).
        Self { m_cost_kib: 65536, t_cost: 3, p_cost: 4, out_len: 32 }
    }
}

/// The public, non-secret vault header. Persisted in the clear (it reveals nothing
/// without the passphrase): salt + the AEAD-wrapped DEK.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultHeader {
    pub version: u16,
    pub kdf: KdfParams,
    pub salt: [u8; 16],
    pub wrapped_dek: Vec<u8>, // seal_with_key(ukek, WRAP_AAD, dek)
}

/// Create a fresh vault: random salt + random DEK, DEK wrapped under the
/// passphrase-derived UKEK. Returns the header (to persist) and the live DEK.
pub fn create_vault(passphrase: &str) -> Result<(VaultHeader, Dek), CryptoError> {
    create_vault_with_params(passphrase, KdfParams::default())
}

/// `create_vault` with caller-chosen Argon2id costs (e.g. from the app's build
/// config). The params are recorded in the header, so the vault opens under any
/// future costs. `out_len` must be 32 (`derive_ukek` rejects otherwise).
pub fn create_vault_with_params(
    passphrase: &str,
    kdf: KdfParams,
) -> Result<(VaultHeader, Dek), CryptoError> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let ukek = derive_ukek(passphrase, &salt, &kdf)?;

    let mut dek = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(dek.as_mut());
    let wrapped_dek = seal_with_key(&ukek, WRAP_AAD, dek.as_ref())?;

    let header = VaultHeader { version: 1, kdf, salt, wrapped_dek };
    Ok((header, Dek(*dek)))
}

/// Open a vault with a passphrase. Wrong passphrase => the wrapped-DEK tag fails =>
/// `Err(Aead)`. Never returns a partial/garbage key.
pub fn unlock(header: &VaultHeader, passphrase: &str) -> Result<Dek, CryptoError> {
    let ukek = derive_ukek(passphrase, &header.salt, &header.kdf)?;
    let dek_bytes = Zeroizing::new(open_with_key(&ukek, WRAP_AAD, &header.wrapped_dek)?);
    if dek_bytes.len() != 32 {
        return Err(CryptoError::Format);
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&dek_bytes);
    Ok(Dek(arr))
}

/// Change the passphrase: derive a new UKEK (fresh salt) and re-wrap the SAME DEK.
/// Data sealed under the DEK is untouched, so this is O(1) regardless of data size.
pub fn rewrap(header: &VaultHeader, dek: &Dek, new_passphrase: &str) -> Result<VaultHeader, CryptoError> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let ukek = derive_ukek(new_passphrase, &salt, &header.kdf)?;
    let wrapped_dek = seal_with_key(&ukek, WRAP_AAD, dek.as_bytes())?;
    Ok(VaultHeader { version: header.version, kdf: header.kdf.clone(), salt, wrapped_dek })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Argon2id near its floor, so these tests exercise the envelope rather than
    /// spending seconds of CPU per case. The costs travel in the header, so
    /// nothing here depends on them being the production defaults.
    const CHEAP: KdfParams = KdfParams { m_cost_kib: 64, t_cost: 1, p_cost: 1, out_len: 32 };

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// A header assembled OUTSIDE this crate: @noble/hashes' Argon2id derived
    /// the UKEK for "correct horse" over salt 00..0f at CHEAP, and
    /// @noble/ciphers' XChaCha20-Poly1305 wrapped the DEK below under it with
    /// the given AAD and nonce 10..27.
    fn foreign_header(wrapped_dek_hex: &str) -> VaultHeader {
        let mut salt = [0u8; 16];
        for (i, b) in salt.iter_mut().enumerate() {
            *b = i as u8;
        }
        VaultHeader { version: 1, kdf: CHEAP, salt, wrapped_dek: unhex(wrapped_dek_hex) }
    }

    const FOREIGN_DEK: &str = "d0d1d2d3d4d5d6d7d8d9dadbdcdddedfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf";

    #[test]
    fn an_independently_built_vault_unlocks_to_its_exact_dek() {
        // The envelope is a persisted format: every vault already on a disk
        // was built this way. A header made by a different implementation
        // pins the KDF mapping, the nonce-first frame and the wrap AAD all at
        // once — drift in any of them would surface to a user only as "wrong
        // passphrase" on a vault that used to open.
        let header = foreign_header(
            "101112131415161718191a1b1c1d1e1f2021222324252627\
             34e2cac2c653586abf8d7ba0e77b5abf812e1bd8e63853c7ef5cb0a0f694d28e\
             8f994e7080dcd94aa5999fb4565864c0",
        );
        let dek = unlock(&header, "correct horse").unwrap();
        assert_eq!(dek.as_bytes().to_vec(), unhex(FOREIGN_DEK));
        assert_eq!(unlock(&header, "correct horse!").err(), Some(CryptoError::Aead));
    }

    #[test]
    fn a_wrapped_dek_sealed_for_another_purpose_does_not_unlock() {
        // The right DEK under the right UKEK, but bound to a different AAD:
        // the cross-context swap WRAP_AAD exists to stop.
        let header = foreign_header(
            "101112131415161718191a1b1c1d1e1f2021222324252627\
             34e2cac2c653586abf8d7ba0e77b5abf812e1bd8e63853c7ef5cb0a0f694d28e\
             352df0349e358aaa8e74f79cd2642593",
        );
        assert_eq!(unlock(&header, "correct horse").err(), Some(CryptoError::Aead));
    }

    #[test]
    fn a_wrapped_key_of_the_wrong_length_is_refused_not_padded() {
        // Authentic, correctly bound, but 16 bytes: unlock must never hand back
        // a partial key that would seal data nobody can open again.
        let header = foreign_header(
            "101112131415161718191a1b1c1d1e1f2021222324252627\
             34e2cac2c653586abf8d7ba0e77b5abfcf8417eb6829377c4a12c2bcae1b7c80",
        );
        assert_eq!(unlock(&header, "correct horse").err(), Some(CryptoError::Format));
    }

    #[test]
    fn the_header_records_the_costs_it_was_made_with() {
        let (header, dek) = create_vault_with_params("pw", CHEAP).unwrap();
        assert_eq!(header.version, 1);
        assert_eq!(header.kdf, CHEAP);
        // nonce || 32-byte DEK || tag.
        assert_eq!(header.wrapped_dek.len(), 24 + 32 + 16);

        // Persisted and read back, the costs come with it: the vault opens
        // without the reader knowing what they were.
        let back: VaultHeader =
            serde_json::from_slice(&serde_json::to_vec(&header).unwrap()).unwrap();
        assert_eq!(back.kdf, CHEAP);
        assert_eq!(unlock(&back, "pw").unwrap().as_bytes(), dek.as_bytes());
    }

    #[test]
    fn the_default_cost_is_the_platform_vaults() {
        // "Matches toto's gervazy": the platform interop tests derive at
        // 64 MiB / 3 / 4, and a vault made at the default must be openable
        // by the same costs on the other side.
        assert_eq!(
            KdfParams::default(),
            KdfParams { m_cost_kib: 65536, t_cost: 3, p_cost: 4, out_len: 32 }
        );
    }

    #[test]
    fn the_same_passphrase_twice_makes_two_unrelated_vaults() {
        let (a, dek_a) = create_vault_with_params("same", CHEAP).unwrap();
        let (b, dek_b) = create_vault_with_params("same", CHEAP).unwrap();
        assert_ne!(a.salt, b.salt, "a fresh salt per vault");
        assert_ne!(dek_a.as_bytes(), dek_b.as_bytes(), "a fresh DEK per vault");
        assert_eq!(unlock(&a, "same").unwrap().as_bytes(), dek_a.as_bytes());
        assert_eq!(unlock(&b, "same").unwrap().as_bytes(), dek_b.as_bytes());
    }

    #[test]
    fn the_passphrase_is_matched_byte_for_byte() {
        // No trimming, no case folding: a near miss is a wrong passphrase.
        let (header, _dek) = create_vault_with_params("Tr0ub4dor", CHEAP).unwrap();
        for near in ["tr0ub4dor", "Tr0ub4dor ", " Tr0ub4dor", "Tr0ub4do", ""] {
            assert_eq!(unlock(&header, near).err(), Some(CryptoError::Aead), "{near:?}");
        }
        // And the empty passphrase is a passphrase like any other: this crate
        // does not police strength, the app does.
        let (empty, dek) = create_vault_with_params("", CHEAP).unwrap();
        assert_eq!(unlock(&empty, "").unwrap().as_bytes(), dek.as_bytes());
        assert_eq!(unlock(&empty, " ").err(), Some(CryptoError::Aead));
    }

    #[test]
    fn tampering_with_any_part_of_the_header_fails_closed() {
        let (good, _dek) = create_vault_with_params("pw", CHEAP).unwrap();

        // The salt and the costs are inputs to the key: change either and the
        // derived UKEK no longer opens the wrap.
        let mut h = good.clone();
        h.salt[0] ^= 1;
        assert_eq!(unlock(&h, "pw").err(), Some(CryptoError::Aead));
        let mut h = good.clone();
        h.kdf.t_cost = 2;
        assert_eq!(unlock(&h, "pw").err(), Some(CryptoError::Aead));
        let mut h = good.clone();
        h.kdf.m_cost_kib = 128;
        assert_eq!(unlock(&h, "pw").err(), Some(CryptoError::Aead));

        // Nonce, DEK ciphertext and tag are each authenticated.
        for idx in [0usize, 24 + 5, good.wrapped_dek.len() - 1] {
            let mut h = good.clone();
            h.wrapped_dek[idx] ^= 0x80;
            assert_eq!(unlock(&h, "pw").err(), Some(CryptoError::Aead), "flip at {idx}");
        }
        let mut h = good.clone();
        h.wrapped_dek.push(0);
        assert_eq!(unlock(&h, "pw").err(), Some(CryptoError::Aead), "an extra byte");
    }

    #[test]
    fn a_wrapped_dek_too_short_to_hold_a_tag_is_malformed() {
        // Distinct from a failed decrypt: there is nothing to verify.
        let (good, _dek) = create_vault_with_params("pw", CHEAP).unwrap();
        for len in [0usize, 23, 39] {
            let mut h = good.clone();
            h.wrapped_dek.truncate(len);
            assert_eq!(unlock(&h, "pw").err(), Some(CryptoError::Format), "len {len}");
        }
    }

    #[test]
    fn unusable_costs_are_refused_on_every_path() {
        // A header is read from disk, so its costs are untrusted input: bad
        // ones must come back as an error, never a panic, and the same error
        // whether creating, unlocking or re-wrapping.
        let (good, dek) = create_vault_with_params("pw", CHEAP).unwrap();

        let short_key = KdfParams { out_len: 16, ..CHEAP };
        assert_eq!(create_vault_with_params("pw", short_key.clone()).err(), Some(CryptoError::BadParams));
        let h = VaultHeader { kdf: short_key.clone(), ..good.clone() };
        assert_eq!(unlock(&h, "pw").err(), Some(CryptoError::BadParams));
        assert_eq!(rewrap(&h, &dek, "new").err(), Some(CryptoError::BadParams));

        // Costs Argon2 itself rejects surface as `Kdf`, with its reason.
        for bad in [
            KdfParams { m_cost_kib: 0, ..CHEAP },
            KdfParams { t_cost: 0, ..CHEAP },
            KdfParams { p_cost: 0, ..CHEAP },
        ] {
            assert!(
                matches!(create_vault_with_params("pw", bad.clone()), Err(CryptoError::Kdf(ref m)) if !m.is_empty()),
                "{bad:?}"
            );
            let h = VaultHeader { kdf: bad.clone(), ..good.clone() };
            assert!(matches!(unlock(&h, "pw"), Err(CryptoError::Kdf(_))), "{bad:?}");
            assert!(matches!(rewrap(&h, &dek, "new"), Err(CryptoError::Kdf(_))), "{bad:?}");
        }
    }

    #[test]
    fn rewrap_keeps_the_vaults_costs_and_version() {
        let (header, dek) = create_vault_with_params("old", CHEAP).unwrap();
        let header = VaultHeader { version: 7, ..header };
        let next = rewrap(&header, &dek, "new").unwrap();
        assert_eq!(next.version, 7);
        assert_eq!(next.kdf, CHEAP, "a rewrap must not silently change the cost");
        assert_ne!(next.wrapped_dek, header.wrapped_dek);
        assert_eq!(unlock(&next, "new").unwrap().as_bytes(), dek.as_bytes());
    }

    #[test]
    fn rewrap_does_not_invalidate_a_copy_of_the_old_header() {
        // Worth pinning, because it is easy to assume otherwise: the DEK is
        // the same, so anyone who kept the old header and knew the old
        // passphrase still recovers it. A rewrap is for convenience; a
        // passphrase that may have leaked needs a fresh DEK (padova's rekey
        // does exactly that).
        let (old, dek) = create_vault_with_params("old", CHEAP).unwrap();
        let _next = rewrap(&old, &dek, "new").unwrap();
        assert_eq!(unlock(&old, "old").unwrap().as_bytes(), dek.as_bytes());
    }

    #[test]
    fn rewrapping_to_the_same_passphrase_still_rolls_a_fresh_salt() {
        let (header, dek) = create_vault_with_params("pw", CHEAP).unwrap();
        let again = rewrap(&header, &dek, "pw").unwrap();
        assert_ne!(again.salt, header.salt);
        assert_eq!(unlock(&again, "pw").unwrap().as_bytes(), dek.as_bytes());
    }
}
