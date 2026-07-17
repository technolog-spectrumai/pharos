//! Passphrase-protected local files ("lock a file"): encrypt a user-chosen file
//! in place so its on-disk bytes become opaque, and restore it later with the
//! same passphrase.
//!
//! Reuses the at-rest crypto primitives (`gervasius`) directly — each locked file
//! is a *self-contained* vault: a random DEK wrapped under a passphrase-derived
//! Argon2id key (fail-closed on the wrong passphrase), sealing the file bytes with
//! XChaCha20-Poly1305. Nothing about the passphrase is stored; the public
//! `VaultHeader` (salt + wrapped DEK) is embedded in the clear because it reveals
//! nothing without the passphrase.
//!
//! On-disk frame:
//! ```text
//!   MAGIC(8) || VERSION(1) || header_len(u32 LE) || VaultHeader(JSON) || sealed
//! ```
//! where `sealed = nonce(24) || ciphertext+tag`. The file is rewritten atomically
//! (temp file + rename) so a crash mid-write cannot corrupt it.

use std::path::Path;

use gervasius::{create_vault_with_params, open, seal, unlock, CryptoError, VaultHeader};
use serde::Serialize;

/// Marks a locked file and lets us detect one without a passphrase.
const MAGIC: &[u8; 8] = b"ENIGLOCK";
const VERSION: u8 = 1;
/// AEAD associated data — a constant (not the filename), so a locked file can be
/// renamed or moved without breaking decryption.
const AAD: &[u8] = b"enigma:localfile:v1";

/// Returned to the UI after a lock/unlock so it can label the row.
#[derive(Serialize, Debug)]
pub struct LockedFileInfo {
    /// The file's base name (for display).
    pub name: String,
    /// Plaintext byte length (what the user recognizes as "the file size").
    pub size: u64,
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn crypto_err(e: CryptoError) -> String {
    match e {
        CryptoError::Aead => "wrong passphrase or corrupt file".to_string(),
        other => other.to_string(),
    }
}

/// Rewrite `path` with `bytes` atomically: write a sibling temp file, then rename
/// over the original. Best-effort temp cleanup if the rename fails.
fn atomic_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = format!("{path}.eniglock.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// True if the file at `path` already begins with the lock magic.
fn has_magic(bytes: &[u8]) -> bool {
    bytes.len() >= MAGIC.len() && &bytes[..MAGIC.len()] == MAGIC
}

/// Encrypt `path` in place under `passphrase`. Errors if the file is already
/// locked. The plaintext never leaves the process; the passphrase is not stored.
#[tauri::command]
pub fn local_lock_file(path: String, passphrase: String) -> Result<LockedFileInfo, String> {
    let plain = std::fs::read(&path).map_err(|e| e.to_string())?;
    if has_magic(&plain) {
        return Err("file is already locked".to_string());
    }

    let (header, dek) =
        create_vault_with_params(&passphrase, crate::kdf_params()).map_err(crypto_err)?;
    let sealed = seal(&dek, AAD, &plain).map_err(crypto_err)?;
    let header_json = serde_json::to_vec(&header).map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(MAGIC.len() + 1 + 4 + header_json.len() + sealed.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_json);
    out.extend_from_slice(&sealed);

    atomic_write(&path, &out)?;
    Ok(LockedFileInfo { name: file_name(&path), size: plain.len() as u64 })
}

/// Decrypt a locked `path` in place under `passphrase`. Wrong passphrase (or a
/// tampered file) fails closed and leaves the file untouched.
#[tauri::command]
pub fn local_unlock_file(path: String, passphrase: String) -> Result<LockedFileInfo, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;

    // Parse frame: MAGIC || VERSION || header_len(u32 LE) || header || sealed.
    let head = MAGIC.len() + 1 + 4;
    if bytes.len() < head || &bytes[..MAGIC.len()] != MAGIC {
        return Err("not a locked file".to_string());
    }
    if bytes[MAGIC.len()] != VERSION {
        return Err("unsupported locked-file version".to_string());
    }
    let hl_off = MAGIC.len() + 1;
    let header_len =
        u32::from_le_bytes([bytes[hl_off], bytes[hl_off + 1], bytes[hl_off + 2], bytes[hl_off + 3]])
            as usize;
    let header_end = head + header_len;
    if bytes.len() < header_end {
        return Err("locked file is truncated".to_string());
    }
    let header: VaultHeader =
        serde_json::from_slice(&bytes[head..header_end]).map_err(|e| e.to_string())?;
    let sealed = &bytes[header_end..];

    let dek = unlock(&header, &passphrase).map_err(crypto_err)?;
    let plain = open(&dek, AAD, sealed).map_err(crypto_err)?;

    atomic_write(&path, &plain)?;
    Ok(LockedFileInfo { name: file_name(&path), size: plain.len() as u64 })
}

/// Cheap magic sniff so the UI can reconcile its record with disk reality
/// (e.g. a file the user unlocked or deleted outside the app).
#[tauri::command]
pub fn local_is_locked(path: String) -> Result<bool, String> {
    use std::io::Read;
    let mut f = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    let mut buf = [0u8; 8];
    match f.read_exact(&mut buf) {
        Ok(()) => Ok(&buf == MAGIC),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> String {
        let dir = std::env::temp_dir();
        let p = dir.join(format!("enigma_locktest_{tag}_{}.bin", std::process::id()));
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn lock_then_unlock_roundtrips() {
        let path = tmp_path("roundtrip");
        let original = b"the quick brown fox jumps over the lazy dog".to_vec();
        std::fs::write(&path, &original).unwrap();

        local_lock_file(path.clone(), "hunter2-correct".into()).unwrap();
        // On disk it is now an opaque locked blob, not the original bytes.
        let locked = std::fs::read(&path).unwrap();
        assert!(has_magic(&locked));
        assert_ne!(locked, original);

        local_unlock_file(path.clone(), "hunter2-correct".into()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn wrong_passphrase_fails_closed_and_leaves_file_intact() {
        let path = tmp_path("wrongpass");
        let original = b"secret payload".to_vec();
        std::fs::write(&path, &original).unwrap();
        local_lock_file(path.clone(), "right-pass".into()).unwrap();
        let locked = std::fs::read(&path).unwrap();

        let err = local_unlock_file(path.clone(), "wrong-pass".into()).unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");
        // The locked bytes are unchanged after a failed unlock.
        assert_eq!(std::fs::read(&path).unwrap(), locked);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn double_lock_is_rejected() {
        let path = tmp_path("double");
        std::fs::write(&path, b"data").unwrap();
        local_lock_file(path.clone(), "pw".into()).unwrap();
        let err = local_lock_file(path.clone(), "pw".into()).unwrap_err();
        assert!(err.contains("already locked"), "got: {err}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn is_locked_reflects_state() {
        let path = tmp_path("islocked");
        std::fs::write(&path, b"plain content here").unwrap();
        assert!(!local_is_locked(path.clone()).unwrap());
        local_lock_file(path.clone(), "pw".into()).unwrap();
        assert!(local_is_locked(path.clone()).unwrap());
        assert!(!local_is_locked(tmp_path("missing")).unwrap());
        std::fs::remove_file(&path).ok();
    }
}
