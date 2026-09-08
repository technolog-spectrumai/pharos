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
