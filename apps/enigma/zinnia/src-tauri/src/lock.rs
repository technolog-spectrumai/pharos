//! Locking a file in place, the platform's way.
//!
//! This is deliberately NOT gervasius. The construction is zenobia's file
//! vault, byte for byte — `Argon2id(password, server_salt) → base64url →
//! Fernet` — because the requirement is that a file locked on this machine
//! unlocks on the platform and a platform-encrypted file unlocks here. Two
//! compatible implementations of one scheme, not two schemes.
//!
//! The salt and Argon2 costs come from the caller's strongbox on the server
//! (`GET /vault/api/strongbox/`), which is also what makes the same password
//! derive the same key on every device. They are parameters here rather than
//! constants: the server owns them, and a file must keep opening after the
//! server raises its defaults for new users.
//!
//! What a locked file looks like: a Fernet token — base64url text beginning
//! `gAAAAA`. That prefix is also the detector, exactly as the platform's own
//! `is_encrypted` flag corresponds to Fernet bytes in storage. The password is
//! a parameter and is never stored; a wrong password fails on the HMAC and the
//! file is not touched.

use std::path::Path;

use base64::Engine;
use gervasius::gervazy;
use serde::Serialize;


/// Refuse to slurp something enormous into memory; the platform's own editable
/// ceiling is 2 MB, and a locked binary can be bigger but not unbounded.
const MAX_LOCK_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct LockedInfo {
    name: String,
    size: u64,
}


/// Decode the server's salt once, so every call site validates it the same way.
fn salt_of(salt_b64: &str) -> Result<Vec<u8>, String> {
    let salt = base64::engine::general_purpose::STANDARD
        .decode(salt_b64)
        .map_err(|_| "bad_salt: the server's salt did not decode".to_string())?;
    if salt.len() != 16 {
        return Err("bad_salt: expected 16 bytes".into());
    }
    Ok(salt)
}

/// Atomic rewrite: sibling temp, fsync, rename. The fsync is deliberate —
/// enigma's equivalent skips it, and a lock that a power cut can roll back to
/// plaintext is not a lock.
fn atomic_write(path: &str, bytes: &[u8]) -> Result<(), String> {
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

fn read_capped(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_LOCK_BYTES {
        return Err("too_large: that file is too big to lock".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

fn name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Encrypt `path` in place. Refuses a file that is already a Fernet token —
/// double-locking would need two passwords to undo in the right order, which
/// nobody ever means.
#[tauri::command]
pub fn lock_file(
    path: String,
    password: String,
    salt_b64: String,
    memory_cost: u32,
    iterations: u32,
    lanes: u32,
) -> Result<LockedInfo, String> {
    let plain = read_capped(&path)?;
    if gervazy::is_sealed(&plain) {
        return Err("already_locked: that file is already encrypted".into());
    }
    let salt = salt_of(&salt_b64)?;
    let token = gervazy::seal(&password, &salt, memory_cost, iterations, lanes, &plain)
        .map_err(|e| format!("crypto: {e}"))?;
    atomic_write(&path, token.as_bytes())?;
    Ok(LockedInfo { name: name_of(&path), size: plain.len() as u64 })
}

/// Decrypt in place. A wrong password fails on the token's HMAC before any
/// write happens, so the file on disk is untouched.
#[tauri::command]
pub fn unlock_file(
    path: String,
    password: String,
    salt_b64: String,
    memory_cost: u32,
    iterations: u32,
    lanes: u32,
) -> Result<LockedInfo, String> {
    let bytes = read_capped(&path)?;
    if !gervazy::is_sealed(&bytes) {
        return Err("not_locked: that file is not encrypted".into());
    }
    let token = std::str::from_utf8(&bytes).map_err(|_| "corrupt: not a valid token".to_string())?;
    let salt = salt_of(&salt_b64)?;
    let plain = gervazy::open(&password, &salt, memory_cost, iterations, lanes, token)
        .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
    atomic_write(&path, &plain)?;
    Ok(LockedInfo { name: name_of(&path), size: plain.len() as u64 })
}

/// Cheap sniff, so the listing can badge locked files without a password.
#[tauri::command]
pub fn is_file_locked(path: String) -> Result<bool, String> {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(&path) else { return Ok(false) };
    let mut buf = [0u8; 6];
    Ok(matches!(f.read_exact(&mut buf), Ok(())) && gervazy::is_sealed(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/fernet_fixture.json"
            ))
            .expect("fixture present"),
        )
        .unwrap()
    }

    fn tmp(name: &str, bytes: &[u8]) -> String {
        let path = std::env::temp_dir().join(format!("zinnia-lock-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// Fixture generated by the PLATFORM's own code path — cryptography's
    /// Argon2id + Fernet, run in the zenobia venv — not by this code. This is
    /// the interop proof: if this passes, a zenobia-encrypted file opens here,
    /// because this IS one.
    #[test]
    fn decrypts_what_the_platform_encrypted() {
        let fx = fixture();
        let path = tmp("interop", fx["token"].as_str().unwrap().as_bytes());
        let info = unlock_file(
            path.clone(),
            fx["password"].as_str().unwrap().to_string(),
            fx["salt_b64"].as_str().unwrap().to_string(),
            fx["memory_cost"].as_u64().unwrap() as u32,
            fx["iterations"].as_u64().unwrap() as u32,
            fx["lanes"].as_u64().unwrap() as u32,
        )
        .expect("platform token must open");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            fx["plaintext"].as_str().unwrap(),
        );
        assert_eq!(info.size as usize, fx["plaintext"].as_str().unwrap().len());
        std::fs::remove_file(&path).ok();
    }

    /// The other direction: what we lock must be a well-formed platform token
    /// under the same derivation, so the platform's decrypt opens it.
    #[test]
    fn locks_to_a_platform_shaped_token() {
        let fx = fixture();
        let salt = fx["salt_b64"].as_str().unwrap();

        let path = tmp("roundtrip", b"some local bytes");
        lock_file(path.clone(), "pw".into(), salt.into(), 19456, 2, 1).unwrap();
        let locked = std::fs::read(&path).unwrap();
        assert!(gervazy::is_sealed(&locked), "not a Fernet token");

        unlock_file(path.clone(), "pw".into(), salt.into(), 19456, 2, 1).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"some local bytes");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_wrong_password_leaves_the_file_untouched() {
        let fx = fixture();
        let salt = fx["salt_b64"].as_str().unwrap();

        let path = tmp("wrongpw", b"precious");
        lock_file(path.clone(), "right".into(), salt.into(), 19456, 2, 1).unwrap();
        let locked = std::fs::read(&path).unwrap();

        let err = unlock_file(path.clone(), "wrong".into(), salt.into(), 19456, 2, 1).unwrap_err();
        assert!(err.starts_with("wrong_password"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), locked, "file must be untouched");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn refuses_to_lock_twice_or_unlock_plaintext() {
        let fx = fixture();
        let salt = fx["salt_b64"].as_str().unwrap();

        let path = tmp("double", b"plain");
        assert!(unlock_file(path.clone(), "x".into(), salt.into(), 19456, 2, 1)
            .unwrap_err()
            .starts_with("not_locked"));
        lock_file(path.clone(), "pw".into(), salt.into(), 19456, 2, 1).unwrap();
        assert!(lock_file(path.clone(), "pw".into(), salt.into(), 19456, 2, 1)
            .unwrap_err()
            .starts_with("already_locked"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn detection_is_the_token_prefix_and_nothing_else() {
        let locked = tmp("det1", b"gAAAAAxyz");
        let plain = tmp("det2", b"hello");
        assert!(is_file_locked(locked.clone()).unwrap());
        assert!(!is_file_locked(plain.clone()).unwrap());
        assert!(!is_file_locked("/does/not/exist".into()).unwrap());
        std::fs::remove_file(&locked).ok();
        std::fs::remove_file(&plain).ok();
    }
}

#[cfg(test)]
mod interop_artifact {
    //! `cargo test --ignored emit_token` writes a Rust-made token for the
    //! platform side to verify with its own cryptography — the other half of
    //! the interop proof, which cannot run inside this process.
    use super::*;

    #[test]
    #[ignore]
    fn emit_token_for_python_verification() {
        let fx: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/fernet_fixture.json"
            ))
            .unwrap(),
        )
        .unwrap();
        let out = std::env::var("INTEROP_OUT").expect("INTEROP_OUT");
        std::fs::write(&out, b"rust made these bytes\n").unwrap();
        lock_file(
            out.clone(),
            fx["password"].as_str().unwrap().into(),
            fx["salt_b64"].as_str().unwrap().into(),
            fx["memory_cost"].as_u64().unwrap() as u32,
            fx["iterations"].as_u64().unwrap() as u32,
            fx["lanes"].as_u64().unwrap() as u32,
        )
        .unwrap();
    }
}
