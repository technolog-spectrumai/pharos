//! Locking a file in place, self-contained.
//!
//! Every sealed file carries everything needed to open it except the password:
//!
//! ```text
//! ZINNLOCK(8) || VERSION(1) || header_len(u32 LE) || VaultHeader(JSON) || nonce(24) || ct+tag
//! ```
//!
//! `VaultHeader` is gervasius's — a random 16-byte salt, the Argon2id costs it
//! was made with, and a DEK wrapped under the password-derived key. It sits in
//! the CLEAR because it reveals nothing without the password, and putting it
//! here is what makes a sealed file portable: carry the file to another machine
//! and the password alone opens it.
//!
//! This replaces a design where the salt was a PARAMETER, fetched from the
//! caller's strongbox row on the platform (`GET /vault/api/strongbox/`). That
//! bought cross-device key agreement, and it died with the cloud: the endpoint
//! is parked in `limbo/cloud/`, so the commands became uncallable — no salt, no
//! key. The alternatives were a device-local salt (one file whose loss orphans
//! every sealed document, needing backup UI and a place to keep it) or this.
//! Enigma reached the same conclusion for the same reason; see its
//! `local_lock.rs`, which this frame deliberately mirrors.
//!
//! Two tiers, not one: the password wraps a random DEK rather than encrypting
//! the bytes directly. It costs nothing here and it is what would let a
//! password change re-wrap the key instead of re-encrypting the file.
//!
//! A sealed file announces itself in its first nine bytes, so it can be shown
//! as sealed without asking for anything. The password is a parameter and is
//! never stored; a wrong one fails on the wrapped DEK's tag before a single
//! byte is written, so the file on disk is left exactly as it was.
//!
//! These commands take a PATH and use `std::fs` directly, so the fs plugin's
//! scope does not gate them — they will seal anything they are handed. The only
//! caller offers rows from the picked workspace; keep it that way.

use gervasius::{create_vault_with_params, gervazy, open, seal, KdfParams, VaultHeader};
use serde::Serialize;

// The frame itself — its marker, its shape, and the file I/O that must not lose
// data — is substrate's, because every app has to RECOGNISE a sealed file even
// when it cannot open one. What stays here is everything that needs a password.
use substrate::{
    atomic_write, is_current, name_of, read_capped, MAGIC, PREFIX_LEN, VERSION,
};

use crate::secrets;


/// What a file's ciphertext is bound to. A CONSTANT, never the file name, so a
/// sealed file survives being renamed or moved. It no longer matches the
/// platform's `sealed.VAULT_AAD`, and should not: this frame is zinnia's own.
const AAD: &[u8] = b"zinnia:file:v1";

#[derive(Debug, Serialize)]
pub struct LockedInfo {
    name: String,
    size: u64,
}

/// Split a frame into its header and its sealed body.
fn parse_frame(bytes: &[u8]) -> Result<(VaultHeader, &[u8]), String> {
    if !is_current(bytes) {
        return Err("not_locked: that file is not encrypted".into());
    }
    let len = u32::from_le_bytes([bytes[9], bytes[10], bytes[11], bytes[12]]) as usize;
    let start = PREFIX_LEN + len;
    // Checked against the ACTUAL length before slicing: the header length is
    // four bytes off a disk that may be truncated or hostile, and an unchecked
    // slice would panic the command rather than refuse the file.
    if len == 0 || start > bytes.len() {
        return Err("crypto: that encrypted file is damaged".into());
    }
    let header: VaultHeader = serde_json::from_slice(&bytes[PREFIX_LEN..start])
        .map_err(|_| "crypto: that encrypted file is damaged".to_string())?;
    Ok((header, &bytes[start..]))
}

/// The password to use: the one passed in, or the remembered one.
///
/// `None` means "use what is remembered", and the answer never leaves Rust —
/// that is the point of asking here rather than letting the frontend fetch it
/// and pass it back down.
fn password_for(given: Option<String>) -> Result<String, String> {
    match given {
        Some(p) if !p.is_empty() => Ok(p),
        _ => secrets::recall()
            .ok_or_else(|| "no_passphrase: no password was given and none is remembered".to_string()),
    }
}

/// Encrypt `path` in place.
///
/// `async`, and that is not decoration: Argon2id at 64 MiB and three passes is
/// most of a second of pure CPU, and a synchronous command runs it on the main
/// thread — the window stops repainting, so the dialog's own spinner freezes
/// while the work it describes is happening.
///
/// Refuses a file that is already sealed, in any format. Double-sealing would
/// need two passwords undone in the right order, which nobody ever means.
#[tauri::command(async)]
pub fn lock_file(path: String, password: Option<String>) -> Result<LockedInfo, String> {
    let password = password_for(password)?;
    let plain = read_capped(&path)?;
    if is_current(&plain) || gervazy::is_sealed(&plain) {
        return Err("already_locked: that file is already encrypted".into());
    }
    // A fresh salt and a fresh DEK for THIS file. Two files sealed under one
    // password share no key material, so opening one tells you nothing about
    // the other.
    let (header, dek) = create_vault_with_params(&password, KdfParams::default())
        .map_err(|e| format!("crypto: {e:?}"))?;
    let body = seal(&dek, AAD, &plain).map_err(|e| format!("crypto: {e:?}"))?;
    let header_json = serde_json::to_vec(&header).map_err(|e| format!("crypto: {e}"))?;

    let mut frame = Vec::with_capacity(PREFIX_LEN + header_json.len() + body.len());
    frame.extend_from_slice(MAGIC);
    frame.push(VERSION);
    frame.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    frame.extend_from_slice(&header_json);
    frame.extend_from_slice(&body);

    atomic_write(&path, &frame)?;
    Ok(LockedInfo { name: name_of(&path), size: plain.len() as u64 })
}

/// Decrypt in place.
///
/// A wrong password fails when the wrapped DEK's tag does not verify — before
/// `atomic_write` is reached, so the file on disk is provably untouched. The
/// error says only "wrong password or corrupt file": telling those two apart
/// would be telling an attacker which half they got right.
#[tauri::command(async)]
pub fn unlock_file(path: String, password: Option<String>) -> Result<LockedInfo, String> {
    let password = password_for(password)?;
    let bytes = read_capped(&path)?;
    // A file sealed by the platform, or by this app before 8/2026. Its salt
    // lived on the server's strongbox row, which is parked — so it cannot be
    // opened here at all, and saying which format it is beats "wrong password".
    if !is_current(&bytes) && gervazy::is_sealed(&bytes) {
        return Err("legacy_format: that file was encrypted by the platform".into());
    }
    let (header, body) = parse_frame(&bytes)?;
    let dek = gervasius::unlock(&header, &password)
        .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
    let plain = open(&dek, AAD, body)
        .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
    atomic_write(&path, &plain)?;
    Ok(LockedInfo { name: name_of(&path), size: plain.len() as u64 })
}

/// Cheap sniff, so a listing can badge sealed files without asking for
/// anything.
///
/// The command shim stays here while this app registers it; the answer comes
/// from substrate, because DETECTION is what every app needs and sealing is
/// what only some do. An app that offers no sealing registers this and nothing
/// else — it can draw a padlock without ever being able to open one.
#[tauri::command]
pub fn is_file_locked(path: String) -> Result<bool, String> {
    Ok(substrate::is_sealed_file(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, bytes: &[u8]) -> String {
        let path = std::env::temp_dir().join(format!("zinnia-lock-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// The whole point of the frame: seal, and open again with nothing but the
    /// password. No salt is passed in either direction.
    #[test]
    fn a_sealed_file_opens_with_only_the_password() {
        let path = tmp("roundtrip", b"some local bytes");
        lock_file(path.clone(), Some("pw".into())).unwrap();

        let sealed = std::fs::read(&path).unwrap();
        assert!(is_current(&sealed), "not this build's frame");
        assert!(is_file_locked(path.clone()).unwrap());
        assert_ne!(sealed, b"some local bytes", "the bytes must actually change");

        let info = unlock_file(path.clone(), Some("pw".into())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"some local bytes");
        assert_eq!(info.size, "some local bytes".len() as u64);
        std::fs::remove_file(&path).ok();
    }

    /// Every seal draws its own salt and its own DEK, so two files sealed under
    /// one password share no key material and no ciphertext.
    #[test]
    fn two_files_under_one_password_share_no_key_material() {
        let a = tmp("uniq-a", b"identical");
        let b = tmp("uniq-b", b"identical");
        lock_file(a.clone(), Some("pw".into())).unwrap();
        lock_file(b.clone(), Some("pw".into())).unwrap();
        assert_ne!(std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());

        let (ha, _) = parse_frame(&std::fs::read(&a).unwrap()).unwrap();
        let (hb, _) = parse_frame(&std::fs::read(&b).unwrap()).unwrap();
        assert_ne!(ha.salt, hb.salt, "each file gets a fresh salt");
        assert_eq!(ha.salt.len(), 16);
        std::fs::remove_file(&a).ok();
        std::fs::remove_file(&b).ok();
    }

    /// The header travels in the file, so the file travels. A rename must not
    /// break it — which is why the AAD is a constant and never the name.
    #[test]
    fn a_sealed_file_survives_being_renamed() {
        let path = tmp("rename-from", b"portable");
        lock_file(path.clone(), Some("pw".into())).unwrap();
        let moved = format!("{path}-moved");
        std::fs::rename(&path, &moved).unwrap();

        unlock_file(moved.clone(), Some("pw".into())).unwrap();
        assert_eq!(std::fs::read(&moved).unwrap(), b"portable");
        std::fs::remove_file(&moved).ok();
    }

    /// Fail-closed. The wrapped DEK's tag rejects the password before
    /// `atomic_write` is reached, so the ciphertext on disk is byte-identical.
    #[test]
    fn a_wrong_password_leaves_the_file_untouched() {
        let path = tmp("wrongpw", b"precious");
        lock_file(path.clone(), Some("right".into())).unwrap();
        let sealed = std::fs::read(&path).unwrap();

        let err = unlock_file(path.clone(), Some("wrong".into())).unwrap_err();
        assert!(err.starts_with("wrong_password"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), sealed, "file must be untouched");
        std::fs::remove_file(&path).ok();
    }

    /// The remembered passphrase, reached the way the commands reach it —
    /// inside Rust. Nothing in this flow hands it to a caller.
    #[test]
    fn falls_back_to_the_remembered_passphrase() {
        let path = tmp("remembered", b"quiet");
        crate::secrets::secret_forget().unwrap();
        // With nothing remembered and nothing given, it refuses rather than
        // sealing under an empty password.
        assert!(lock_file(path.clone(), None).unwrap_err().starts_with("no_passphrase"));

        crate::secrets::secret_remember("hunter2".into()).unwrap();
        lock_file(path.clone(), None).unwrap();
        // …and the file it produced is an ordinary one: the same passphrase
        // opens it when typed, because the frame never knew where it came from.
        unlock_file(path.clone(), Some("hunter2".into())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"quiet");

        crate::secrets::secret_forget().unwrap();
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn refuses_to_seal_twice_or_open_plaintext() {
        let path = tmp("double", b"plain");
        assert!(unlock_file(path.clone(), Some("x".into())).unwrap_err().starts_with("not_locked"));
        lock_file(path.clone(), Some("pw".into())).unwrap();
        assert!(lock_file(path.clone(), Some("pw".into())).unwrap_err().starts_with("already_locked"));
        std::fs::remove_file(&path).ok();
    }

    /// A file the platform sealed is still SEEN as sealed — the listing must
    /// never hand it to an editor as ciphertext — but it cannot be opened here,
    /// because its salt lived on a strongbox row that is parked. Saying which
    /// format it is beats reporting a wrong password.
    #[test]
    fn a_platform_sealed_file_is_seen_but_refused() {
        let fernet = tmp("legacy-fernet", b"gAAAAAxyz-not-really-a-token");
        assert!(is_file_locked(fernet.clone()).unwrap(), "must still be badged");
        let err = unlock_file(fernet.clone(), Some("pw".into())).unwrap_err();
        assert!(err.starts_with("legacy_format"), "{err}");
        std::fs::remove_file(&fernet).ok();
    }

    #[test]
    fn detection_answers_for_plaintext_and_for_nothing_at_all() {
        let plain = tmp("det-plain", b"hello");
        assert!(!is_file_locked(plain.clone()).unwrap());
        // A file it cannot open reads as "not sealed" — indistinguishable from
        // a permissions failure, which is why nothing treats this as proof.
        assert!(!is_file_locked("/does/not/exist".into()).unwrap());
        std::fs::remove_file(&plain).ok();
    }

    /// Four bytes of length off a disk that may be truncated or hostile. An
    /// unchecked slice would panic the command instead of refusing the file.
    #[test]
    fn a_damaged_frame_is_refused_rather_than_panicking() {
        let path = tmp("truncated", b"x");
        lock_file(path.clone(), Some("pw".into())).unwrap();
        let mut sealed = std::fs::read(&path).unwrap();
        sealed.truncate(PREFIX_LEN + 4);
        std::fs::write(&path, &sealed).unwrap();

        let err = unlock_file(path.clone(), Some("pw".into())).unwrap_err();
        assert!(err.starts_with("crypto"), "{err}");
        std::fs::remove_file(&path).ok();
    }
}
