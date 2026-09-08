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
/// This app's frame. The LAYOUT is `substrate::FrameSpec`, shared with the
/// office apps; the magic and the AAD are enigma's own and must never change —
/// every locked file a user already has carries them.
const SPEC: substrate::FrameSpec = substrate::FrameSpec::ENIGMA;
const MAGIC: &[u8; 8] = SPEC.magic;
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

/// Parse a locked-file frame into its `VaultHeader` and the sealed body (borrowed from
/// `bytes`). Frame: `MAGIC || VERSION || header_len(u32 LE) || header || sealed`.
fn parse_frame(bytes: &[u8]) -> Result<(VaultHeader, &[u8]), String> {
    // The bounds checks live in substrate now — one implementation of this
    // layout for both apps, rather than two that drift.
    let (header_bytes, body) = SPEC.split(bytes)?;
    let header: VaultHeader =
        serde_json::from_slice(header_bytes).map_err(|e| e.to_string())?;
    Ok((header, body))
}

/// Build a locked-file frame from a header + already-sealed body.
fn build_frame(header: &VaultHeader, sealed: &[u8]) -> Result<Vec<u8>, String> {
    let header_json = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    Ok(SPEC.frame(&header_json, sealed))
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

    atomic_write(&path, &build_frame(&header, &sealed)?)?;
    Ok(LockedFileInfo { name: file_name(&path), size: plain.len() as u64 })
}

/// Decrypt a locked `path` in place under `passphrase`. Wrong passphrase (or a
/// tampered file) fails closed and leaves the file untouched.
#[tauri::command]
pub fn local_unlock_file(path: String, passphrase: String) -> Result<LockedFileInfo, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let (header, sealed) = parse_frame(&bytes)?;

    let dek = unlock(&header, &passphrase).map_err(crypto_err)?;
    let plain = open(&dek, AAD, sealed).map_err(crypto_err)?;

    atomic_write(&path, &plain)?;
    Ok(LockedFileInfo { name: file_name(&path), size: plain.len() as u64 })
}

/// Rotate a locked file's key: unlock under `current`, mint a fresh vault (new random
/// DEK + salt) under `new`, and re-encrypt the body under it. Pass `new == current` to
/// keep the same passphrase while still rolling the key. Wrong `current` (or a tampered
/// file) fails closed and leaves the file untouched.
#[tauri::command]
pub fn local_rotate_file(
    app: tauri::AppHandle,
    path: String,
    current: String,
    new: String,
) -> Result<LockedFileInfo, String> {
    let info = rotate_file_at(&path, &current, &new)?;
    // Privacy HP: same reasoning as the key ring — the file's own key is now a
    // key that no longer exists anywhere else. Pays once per rolling day.
    crate::privacy_hp::award_rotation(&app, "local.reencrypt.files");
    Ok(info)
}

/// The rotation itself, free of any Tauri handle so it stays directly testable.
fn rotate_file_at(path: &str, current: &str, new: &str) -> Result<LockedFileInfo, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let (header, sealed) = parse_frame(&bytes)?;

    let dek = unlock(&header, current).map_err(crypto_err)?;
    let plain = open(&dek, AAD, sealed).map_err(crypto_err)?;

    let (header2, dek2) = create_vault_with_params(new, crate::kdf_params()).map_err(crypto_err)?;
    let sealed2 = seal(&dek2, AAD, &plain).map_err(crypto_err)?;

    atomic_write(path, &build_frame(&header2, &sealed2)?)?;
    Ok(LockedFileInfo { name: file_name(path), size: plain.len() as u64 })
}

/// Whether the file at `path` currently begins with the ENIGLOCK magic. Infallible
/// (a missing/short/unreadable file is simply "not locked") so callers on a
/// best-effort path — like the panic wipe deleting marked files — can use it
/// without threading errors. Shared with the `local_is_locked` command.
pub fn is_locked_path(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut buf = [0u8; 8];
    matches!(f.read_exact(&mut buf), Ok(())) && &buf == MAGIC
}

/// Cheap magic sniff so the UI can reconcile its record with disk reality
/// (e.g. a file the user unlocked or deleted outside the app).
#[tauri::command]
pub fn local_is_locked(path: String) -> Result<bool, String> {
    Ok(is_locked_path(std::path::Path::new(&path)))
}

/// Editor size cap: keeps the editor responsive and bounds decrypt cost.
const MAX_NOTE_BYTES: usize = 8 * 1024 * 1024;

/// Disk reality for a note the UI remembers: `local_is_locked` alone can't tell a
/// missing file from a plain one (both are `Ok(false)`).
#[derive(Serialize, Debug)]
pub struct NoteStat {
    pub exists: bool,
    pub locked: bool,
    /// On-disk byte length (the locked frame's length for a locked file).
    pub size: u64,
}

/// A file's text handed to the editor, plus how it is stored on disk.
#[derive(Serialize, Debug)]
pub struct NoteReadResult {
    pub name: String,
    pub content: String,
    /// True if the bytes on disk are a locked frame (so saves must be re-sealed).
    pub locked: bool,
    /// Plaintext byte length.
    pub size: u64,
}

/// Existence + lock state + size in one call, so the notes list can reconcile its
/// records with disk in a single round trip per file.
#[tauri::command]
pub fn local_note_stat(path: String) -> Result<NoteStat, String> {
    let md = match std::fs::metadata(&path) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(NoteStat { exists: false, locked: false, size: 0 })
        }
        Err(e) => return Err(e.to_string()),
    };
    Ok(NoteStat { exists: true, locked: local_is_locked(path)?, size: md.len() })
}

/// Read a text file for the editor. A locked file needs `passphrase` and is decrypted
/// *in memory only* — reading never writes plaintext to disk.
#[tauri::command]
pub fn local_note_read(path: String, passphrase: Option<String>) -> Result<NoteReadResult, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // Reject oversize before decrypting; the slack covers the frame's own overhead.
    if bytes.len() > MAX_NOTE_BYTES + 4096 {
        return Err("file too large to edit (max 8 MB)".to_string());
    }

    let locked = has_magic(&bytes);
    let plain = if locked {
        let pass = passphrase.ok_or_else(|| "passphrase required".to_string())?;
        let (header, sealed) = parse_frame(&bytes)?;
        let dek = unlock(&header, &pass).map_err(crypto_err)?;
        open(&dek, AAD, sealed).map_err(crypto_err)?
    } else {
        bytes
    };
    if plain.len() > MAX_NOTE_BYTES {
        return Err("file too large to edit (max 8 MB)".to_string());
    }

    let content = String::from_utf8(plain).map_err(|_| "not a UTF-8 text file".to_string())?;
    let size = content.len() as u64;
    Ok(NoteReadResult { name: file_name(&path), content, locked, size })
}

/// Save an edited buffer back to `path`.
///
/// Without a passphrase this writes plaintext, but refuses if the file on disk is
/// currently locked — we never clobber ciphertext with plaintext. With a passphrase it
/// writes a locked frame: for an already-locked file the passphrase is checked against
/// the file's *current* header and that header + DEK are reused, so a file re-keyed by
/// something else in the meantime fails closed instead of being overwritten under a
/// stale key. A fresh vault is minted only for a new file or a plain → locked
/// conversion. Either way the write is atomic, and the temp file only ever holds the
/// same bytes the final file does.
#[tauri::command]
pub fn local_note_write(
    path: String,
    content: String,
    passphrase: Option<String>,
) -> Result<LockedFileInfo, String> {
    let plain = content.into_bytes();
    let size = plain.len() as u64;

    match passphrase {
        None => {
            if local_is_locked(path.clone())? {
                return Err("file is locked on disk — save it with its passphrase".to_string());
            }
            atomic_write(&path, &plain)?;
        }
        Some(pass) => {
            let existing = match std::fs::read(&path) {
                Ok(b) => Some(b),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.to_string()),
            };
            let (header, dek) = match existing.as_deref().filter(|b| has_magic(b)) {
                Some(bytes) => {
                    let (header, _) = parse_frame(bytes)?;
                    let dek = unlock(&header, &pass).map_err(crypto_err)?;
                    (header, dek)
                }
                None => create_vault_with_params(&pass, crate::kdf_params()).map_err(crypto_err)?,
            };
            let sealed = seal(&dek, AAD, &plain).map_err(crypto_err)?;
            atomic_write(&path, &build_frame(&header, &sealed)?)?;
        }
    }

    Ok(LockedFileInfo { name: file_name(&path), size })
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

    #[test]
    fn rotate_rolls_key_but_keeps_content_same_passphrase() {
        let path = tmp_path("rotate");
        let original = b"rotate me please".to_vec();
        std::fs::write(&path, &original).unwrap();
        local_lock_file(path.clone(), "pass-one".into()).unwrap();
        let before = std::fs::read(&path).unwrap();

        // Same-passphrase rotation still rolls salt/DEK/nonce → on-disk bytes differ.
        rotate_file_at(&path, "pass-one", "pass-one").unwrap();
        let after = std::fs::read(&path).unwrap();
        assert!(has_magic(&after));
        assert_ne!(before, after, "rotation must roll the key material");

        // Content still recovers under the same passphrase.
        local_unlock_file(path.clone(), "pass-one".into()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rotate_can_change_passphrase() {
        let path = tmp_path("rotate_pass");
        let original = b"secret".to_vec();
        std::fs::write(&path, &original).unwrap();
        local_lock_file(path.clone(), "old-pass".into()).unwrap();

        rotate_file_at(&path, "old-pass", "new-pass").unwrap();

        // Old passphrase no longer unlocks; the new one does.
        let err = local_unlock_file(path.clone(), "old-pass".into()).unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");
        local_unlock_file(path.clone(), "new-pass".into()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rotate_wrong_current_fails_closed() {
        let path = tmp_path("rotate_wrong");
        std::fs::write(&path, b"data").unwrap();
        local_lock_file(path.clone(), "right".into()).unwrap();
        let locked = std::fs::read(&path).unwrap();

        let err = rotate_file_at(&path, "wrong", "whatever").unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");
        // The file is untouched after a failed rotation.
        assert_eq!(std::fs::read(&path).unwrap(), locked);

        std::fs::remove_file(&path).ok();
    }

    // ── editor reads/writes ──────────────────────────────────────────────────────

    #[test]
    fn note_plain_roundtrips() {
        let path = tmp_path("note_plain");
        std::fs::write(&path, b"first draft").unwrap();

        let read = local_note_read(path.clone(), None).unwrap();
        assert_eq!(read.content, "first draft");
        assert!(!read.locked);

        local_note_write(path.clone(), "second draft".into(), None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second draft");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn note_locked_roundtrips_without_ever_writing_plaintext() {
        let path = tmp_path("note_locked");
        std::fs::write(&path, b"classified").unwrap();
        local_lock_file(path.clone(), "pw-note".into()).unwrap();

        let read = local_note_read(path.clone(), Some("pw-note".into())).unwrap();
        assert_eq!(read.content, "classified");
        assert!(read.locked);
        // Reading did not decrypt the file in place.
        assert!(has_magic(&std::fs::read(&path).unwrap()));

        local_note_write(path.clone(), "classified, edited".into(), Some("pw-note".into())).unwrap();
        let on_disk = std::fs::read(&path).unwrap();
        assert!(has_magic(&on_disk));
        assert!(!on_disk.windows(10).any(|w| w == b"classified"), "plaintext leaked into the frame");

        let again = local_note_read(path.clone(), Some("pw-note".into())).unwrap();
        assert_eq!(again.content, "classified, edited");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn note_read_locked_without_passphrase_is_rejected() {
        let path = tmp_path("note_nopass");
        std::fs::write(&path, b"data").unwrap();
        local_lock_file(path.clone(), "pw".into()).unwrap();

        let err = local_note_read(path.clone(), None).unwrap_err();
        assert!(err.contains("passphrase required"), "got: {err}");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn note_plain_write_over_locked_file_is_refused() {
        let path = tmp_path("note_clobber");
        std::fs::write(&path, b"secret").unwrap();
        local_lock_file(path.clone(), "pw".into()).unwrap();
        let locked = std::fs::read(&path).unwrap();

        let err = local_note_write(path.clone(), "oops".into(), None).unwrap_err();
        assert!(err.contains("locked on disk"), "got: {err}");
        // Ciphertext survived the refused write.
        assert_eq!(std::fs::read(&path).unwrap(), locked);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn note_write_with_passphrase_converts_plain_file() {
        let path = tmp_path("note_convert");
        std::fs::write(&path, b"was plain").unwrap();
        assert!(!local_is_locked(path.clone()).unwrap());

        local_note_write(path.clone(), "now sealed".into(), Some("pw".into())).unwrap();
        assert!(local_is_locked(path.clone()).unwrap());
        assert_eq!(
            local_note_read(path.clone(), Some("pw".into())).unwrap().content,
            "now sealed"
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn note_write_after_external_rotation_fails_closed() {
        let path = tmp_path("note_rotated");
        std::fs::write(&path, b"original").unwrap();
        local_lock_file(path.clone(), "pass-one".into()).unwrap();

        // Something else re-keys the file while the editor holds the old passphrase.
        rotate_file_at(&path, "pass-one", "pass-two").unwrap();
        let rotated = std::fs::read(&path).unwrap();

        let err = local_note_write(path.clone(), "edited".into(), Some("pass-one".into())).unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");
        // Nothing was written under the stale key.
        assert_eq!(std::fs::read(&path).unwrap(), rotated);
        assert_eq!(
            local_note_read(path.clone(), Some("pass-two".into())).unwrap().content,
            "original"
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn note_read_rejects_non_utf8() {
        let path = tmp_path("note_binary");
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x01]).unwrap();

        let err = local_note_read(path.clone(), None).unwrap_err();
        assert!(err.contains("UTF-8"), "got: {err}");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn note_read_rejects_oversize() {
        let path = tmp_path("note_big");
        std::fs::write(&path, vec![b'a'; MAX_NOTE_BYTES + 8192]).unwrap();

        let err = local_note_read(path.clone(), None).unwrap_err();
        assert!(err.contains("too large"), "got: {err}");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn note_stat_distinguishes_missing_plain_and_locked() {
        let path = tmp_path("note_stat");
        let missing = local_note_stat(tmp_path("note_stat_missing")).unwrap();
        assert!(!missing.exists && !missing.locked);

        std::fs::write(&path, b"plain bytes").unwrap();
        let plain = local_note_stat(path.clone()).unwrap();
        assert!(plain.exists && !plain.locked);
        assert_eq!(plain.size, 11);

        local_lock_file(path.clone(), "pw".into()).unwrap();
        let locked = local_note_stat(path.clone()).unwrap();
        assert!(locked.exists && locked.locked);

        std::fs::remove_file(&path).ok();
    }
}
