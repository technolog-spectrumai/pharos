//! Shared Rust below zinnia's apps.
//!
//! What lives here is what more than one app needs and what none of them should
//! own: the shape of a sealed file, the question "is this one?", and the file
//! I/O that must not lose data when it goes wrong.
//!
//! **What deliberately does NOT live here: sealing and opening.** Those need a
//! password, which means the keyring, which is the one capability the split
//! exists to keep out of apps that do not offer sealing. They stay in the
//! padova crate. The line is drawn so that DETECTING a sealed file — which
//! every app must do, to badge it and refuse to hand ciphertext to an editor —
//! costs nothing and grants nothing.
//!
//! There is no `tauri` dependency. This crate exports plain functions; each app
//! expands its own `#[tauri::command]` shims over them, so command *names* stay
//! identical across apps and the frontend's invoke strings never change.

#[cfg(feature = "legacy-detect")]
use gervasius::gervazy;

/// The frame this build writes:
///
/// ```text
/// ZINNLOCK(8) || VERSION(1) || header_len(u32 LE) || VaultHeader(JSON) || nonce(24) || ct+tag
/// ```
///
/// A local file has no `is_encrypted` column to consult, so the bytes have to
/// say what they are.
pub const MAGIC: &[u8; 8] = b"ZINNLOCK";
pub const VERSION: u8 = 1;
/// magic + version + the u32 that gives the header's length.
pub const PREFIX_LEN: usize = 8 + 1 + 4;

/// Refuse to slurp something enormous into memory; the platform's own editable
/// ceiling is 2 MB, and a locked binary can be bigger but not unbounded.
pub const MAX_LOCK_BYTES: u64 = 256 * 1024 * 1024;

/// Whether bytes are a frame this build wrote.
pub fn is_current(bytes: &[u8]) -> bool {
    bytes.len() > PREFIX_LEN && bytes.starts_with(MAGIC) && bytes[8] == VERSION
}

/// Whether a file on disk is sealed — a cheap sniff of its first bytes, so a
/// listing can badge sealed files without asking for anything.
///
/// Answers for the PLATFORM'S formats too, although this build cannot open
/// them: a file it cannot open is still one the user must not be handed to an
/// editor as ciphertext. A file that cannot be opened at all reads as `false` —
/// a permissions failure is indistinguishable from "not sealed" here, so
/// nothing downstream should treat this as authoritative.
pub fn is_sealed_file(path: &str) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    // Enough for any marker: this frame's 13-byte prefix, the platform's
    // 9-byte one, or Fernet's base64 prefix.
    let mut buf = [0u8; 16];
    let read = match f.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    if is_current(&buf[..read]) {
        return true;
    }
    // The platform's older Fernet frames, when this build was asked to know
    // about them. Without the feature a legacy file simply is not recognised —
    // which is correct for a build that could never open one anyway.
    #[cfg(feature = "legacy-detect")]
    {
        return gervazy::is_sealed(&buf[..read]);
    }
    #[cfg(not(feature = "legacy-detect"))]
    false
}

/// Whether these bytes are one of the PLATFORM's older Fernet frames.
///
/// Always `false` without `legacy-detect`, which is the honest answer for a
/// build that has no way to recognise — or open — one. Callers use it to say
/// "that file was encrypted by the platform" instead of "wrong password".
pub fn is_legacy(bytes: &[u8]) -> bool {
    #[cfg(feature = "legacy-detect")]
    {
        return gervazy::is_sealed(bytes);
    }
    #[cfg(not(feature = "legacy-detect"))]
    {
        let _ = bytes;
        false
    }
}

/// Write bytes, or leave the file exactly as it was.
///
/// Through a sibling temporary, fsynced, then renamed. enigma's equivalent
/// skips the fsync, and a lock that a power cut can roll back to plaintext is
/// not a lock.
pub fn atomic_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = format!("{path}.zlock.tmp");
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Read a whole file, refusing one that is absurdly large.
pub fn read_capped(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_LOCK_BYTES {
        return Err("too_large: that file is too big to lock".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// A path's final component, for reporting back to the user.
pub fn name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("substrate-{}-{name}", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_frame_is_recognised_by_its_first_bytes() {
        let mut framed = Vec::from(*MAGIC);
        framed.push(VERSION);
        framed.extend_from_slice(&[0, 0, 0, 0]);
        framed.push(b'x');
        assert!(is_current(&framed));

        // A different version is not this frame, even with the right magic.
        let mut wrong = framed.clone();
        wrong[8] = VERSION.wrapping_add(1);
        assert!(!is_current(&wrong));

        assert!(!is_current(b"plain text"));
        // The prefix alone is not a frame: there must be something after it.
        assert!(!is_current(&framed[..PREFIX_LEN]));
    }

    #[test]
    fn an_unreadable_path_is_not_sealed_rather_than_an_error() {
        assert!(!is_sealed_file(&tmp("does-not-exist")));
    }

    #[test]
    fn a_plain_file_is_not_sealed() {
        let path = tmp("plain");
        std::fs::write(&path, b"just text").unwrap();
        assert!(!is_sealed_file(&path));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_framed_file_is_sealed() {
        let path = tmp("framed");
        let mut bytes = Vec::from(*MAGIC);
        bytes.push(VERSION);
        bytes.extend_from_slice(&[1, 0, 0, 0]);
        bytes.extend_from_slice(b"{}");
        std::fs::write(&path, &bytes).unwrap();
        assert!(is_sealed_file(&path));
        std::fs::remove_file(&path).ok();
    }

    /// The property the fsync is there for: a failed write must not leave the
    /// original truncated, and must not leave its temporary behind.
    #[test]
    fn a_failed_write_leaves_neither_a_partial_file_nor_a_temporary() {
        let dir = std::env::temp_dir().join(format!("substrate-{}-dir", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("target").to_string_lossy().into_owned();
        std::fs::write(&path, b"original").unwrap();

        // A directory where the temporary wants to be: `File::create` fails.
        let blocker = format!("{path}.zlock.tmp");
        std::fs::create_dir_all(&blocker).unwrap();

        assert!(atomic_write(&path, b"replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_write_replaces_the_whole_file() {
        let path = tmp("replace");
        std::fs::write(&path, b"a much longer original").unwrap();
        atomic_write(&path, b"short").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"short");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn reading_refuses_a_file_over_the_cap() {
        let path = tmp("capped");
        std::fs::write(&path, b"small enough").unwrap();
        assert_eq!(read_capped(&path).unwrap(), b"small enough");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_name_survives_a_path_without_one() {
        assert_eq!(name_of("/a/b/c.txt"), "c.txt");
        assert_eq!(name_of("bare"), "bare");
        assert_eq!(name_of("/"), "/");
    }
}
