// This device's long-term key: an Ed25519 secret kept sealed in the vault.
//
// It is what a contact card and an invitation name this device by, and what
// signs the challenge when an invitation is redeemed over Tor. In Vesper it
// was iroh's endpoint key; Pharos keeps only the key types (`iroh-base`) and
// no iroh transport. Step 2.5 replaces this with Pharos's own identity.
//
// The vault entry keeps Vesper's name (`keys/iroh_gossip`) so an existing
// profile keeps the same identity.

use anyhow::{anyhow, Result};
pub use iroh_base::{EndpointId, SecretKey, Signature};
use tauri::AppHandle;

/// The device key named `name`, created and sealed on first use.
pub fn load_or_create_secret(app: &AppHandle, name: &str) -> Result<SecretKey> {
    let key = format!("iroh_{name}");
    if let Ok(Some(bytes)) = crate::vault::get(app, "keys", &key) {
        if bytes.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            return Ok(SecretKey::from_bytes(&arr));
        }
    }
    let sk = SecretKey::generate();
    crate::vault::put(app, "keys", &key, &sk.to_bytes()).map_err(|e| anyhow!("persist device key: {e}"))?;
    Ok(sk)
}
