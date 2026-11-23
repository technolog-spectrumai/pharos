// This device's long-term key: an Ed25519 key kept encrypted in the vault, per
// profile. Its public half, as 64 hex digits, is the device id an invitation
// redemption proves (`invite_redeem`) and a personal invitation is sealed to
// (`invite_ticket`, through its X25519 twin).

use anyhow::{anyhow, Result};
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use tauri::AppHandle;

const VAULT_KEY: &str = "device_ed25519";

/// Load the device key, or make and keep one.
pub fn load_or_create(app: &AppHandle) -> Result<SigningKey> {
    if let Ok(Some(bytes)) = crate::vault::get(app, "keys", VAULT_KEY) {
        if let Ok(seed) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(SigningKey::from_bytes(&seed));
        }
    }
    let mut seed = [0u8; 32];
    chacha20poly1305::aead::rand_core::RngCore::fill_bytes(&mut chacha20poly1305::aead::OsRng, &mut seed);
    crate::vault::put(app, "keys", VAULT_KEY, &seed).map_err(|e| anyhow!("persist device key: {e}"))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// The device id: the public key as lowercase hex.
pub fn id_of(key: &SigningKey) -> String {
    hex(key.verifying_key().as_bytes())
}

/// The public key behind a device id.
pub fn public_of(id: &str) -> Option<[u8; 32]> {
    if id.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(id.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    VerifyingKey::from_bytes(&out).ok()?;
    Some(out)
}

pub fn sign(key: &SigningKey, msg: &[u8]) -> [u8; 64] {
    key.sign(msg).to_bytes()
}

/// Does `sig` prove that whoever made it holds the key behind `id`?
pub fn verify(id: &str, msg: &[u8], sig: &[u8; 64]) -> bool {
    let Some(pk) = public_of(id) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    vk.verify(msg, &Signature::from_bytes(sig)).is_ok()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_verifies_only_for_its_own_id() {
        let a = SigningKey::from_bytes(&[1; 32]);
        let b = SigningKey::from_bytes(&[2; 32]);
        let sig = sign(&a, b"challenge");
        assert!(verify(&id_of(&a), b"challenge", &sig));
        assert!(!verify(&id_of(&b), b"challenge", &sig));
        assert!(!verify(&id_of(&a), b"other", &sig));
    }

    #[test]
    fn ids_round_trip_and_junk_is_refused() {
        let a = SigningKey::from_bytes(&[3; 32]);
        assert_eq!(public_of(&id_of(&a)), Some(*a.verifying_key().as_bytes()));
        assert_eq!(public_of("nothex"), None);
    }
}
