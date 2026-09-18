//! Editing an encrypted file without decrypting the disk.
//!
//! `sealed_open` decrypts a workspace file INTO MEMORY and keeps its key here,
//! in a session the page only ever sees as a number. `sealed_write` re-seals
//! the edited text under that key and writes it atomically; `sealed_close`
//! drops the key. The file on disk is ciphertext before, during and after —
//! no temporary plaintext copy exists anywhere, and the passphrase is checked
//! once by padova and never retained. Pictures are decrypted to bytes with no
//! session at all: the viewer is read-only, so there is nothing to re-seal.
//!
//! The work is padova's (`SealSession`, the same envelope enigma's
//! `local_note_read`/`local_note_write` use); what is decided here is the
//! boundary — every path resolves against the open workspace first — and the
//! session table.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;

use crate::workspace::{self, WorkspaceState, MAX_READ_BYTES};
use crate::LOCKER;

/// The open sessions. A token is a counter, not a secret: it only names an
/// entry in a table the page cannot read, and a stale token simply misses.
pub struct SealSessions {
    next: AtomicU64,
    map: Mutex<HashMap<u64, padova::SealSession>>,
}

impl SealSessions {
    pub fn new() -> Self {
        Self { next: AtomicU64::new(1), map: Mutex::new(HashMap::new()) }
    }

    fn insert(&self, session: padova::SealSession) -> u64 {
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut map) = self.map.lock() {
            map.insert(token, session);
        }
        token
    }

    fn close(&self, token: u64) {
        if let Ok(mut map) = self.map.lock() {
            map.remove(&token);
        }
    }

    fn with<T>(&self, token: u64, f: impl FnOnce(&mut padova::SealSession) -> Result<T, String>) -> Result<T, String> {
        let mut map = self.map.lock().map_err(|_| "no_session: the session table is poisoned".to_string())?;
        let session = map
            .get_mut(&token)
            .ok_or_else(|| "no_session: that file is no longer open for editing".to_string())?;
        f(session)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.lock().map(|m| m.len()).unwrap_or(0)
    }
}

#[derive(Debug, Serialize)]
pub struct SealedOpen {
    pub token: u64,
    pub name: String,
    /// Plaintext length in bytes.
    pub size: u64,
    pub text: String,
}

/// The pure core: open, keep the session, hand back the text.
pub fn open_text(
    sessions: &SealSessions,
    root: &std::path::Path,
    given: &str,
    password: Option<String>,
) -> Result<SealedOpen, String> {
    let path = workspace::resolve(root, given, false)?;
    let path_str = path.to_string_lossy().into_owned();
    let (session, plain) = LOCKER.open_sealed(&path_str, password)?;
    if plain.len() as u64 > MAX_READ_BYTES {
        return Err("too_large: that file is too big to open here".into());
    }
    let size = plain.len() as u64;
    let text = String::from_utf8(plain).map_err(|_| "not_text: that file is not a text file".to_string())?;
    Ok(SealedOpen { token: sessions.insert(session), name: substrate::name_of(&path_str), size, text })
}

/// Decrypt a picture to bytes. No session: the viewer never writes.
pub fn open_bytes(root: &std::path::Path, given: &str, password: Option<String>) -> Result<Vec<u8>, String> {
    let path = workspace::resolve(root, given, false)?;
    let (_session, plain) = LOCKER.open_sealed(&path.to_string_lossy(), password)?;
    if plain.len() as u64 > MAX_READ_BYTES {
        return Err("too_large: that file is too big to open here".into());
    }
    Ok(plain)
}

/// Re-seal `text` under the session's key and write it inside the workspace.
pub fn write_text(
    sessions: &SealSessions,
    root: &std::path::Path,
    token: u64,
    given: &str,
    text: &str,
) -> Result<(), String> {
    let path = workspace::resolve(root, given, true)?;
    sessions.with(token, |session| session.write(&path.to_string_lossy(), text.as_bytes()).map(|_| ()))
}

// ── the commands ────────────────────────────────────────────────────────────

/// `async`: the password check is Argon2id, most of a second of CPU.
#[tauri::command(async)]
pub fn sealed_open(
    ws: tauri::State<'_, WorkspaceState>,
    sessions: tauri::State<'_, SealSessions>,
    path: String,
    password: Option<String>,
) -> Result<SealedOpen, String> {
    open_text(&sessions, &ws.root()?, &path, password)
}

#[tauri::command(async)]
pub fn sealed_open_bytes(
    ws: tauri::State<'_, WorkspaceState>,
    path: String,
    password: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(open_bytes(&ws.root()?, &path, password)?))
}

#[tauri::command(async)]
pub fn sealed_write(
    ws: tauri::State<'_, WorkspaceState>,
    sessions: tauri::State<'_, SealSessions>,
    token: u64,
    path: String,
    text: String,
) -> Result<(), String> {
    write_text(&sessions, &ws.root()?, token, &path, &text)
}

#[tauri::command]
pub fn sealed_close(sessions: tauri::State<'_, SealSessions>, token: u64) -> Result<(), String> {
    sessions.close(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::tests::{put, scratch};

    #[test]
    fn opens_in_memory_writes_back_sealed_and_closes() {
        let root = scratch("sealed-edit");
        let sessions = SealSessions::new();
        put(&root, "n.md", b"# secret note");
        LOCKER.lock_file(&root.join("n.md").to_string_lossy(), Some("pw".into())).unwrap();
        let sealed_before = std::fs::read(root.join("n.md")).unwrap();

        let opened = open_text(&sessions, &root, "n.md", Some("pw".into())).unwrap();
        assert_eq!(opened.text, "# secret note");
        assert_eq!(opened.name, "n.md");
        assert_eq!(std::fs::read(root.join("n.md")).unwrap(), sealed_before, "opening wrote nothing");

        write_text(&sessions, &root, opened.token, "n.md", "# secret note, edited").unwrap();
        let on_disk = std::fs::read(root.join("n.md")).unwrap();
        assert!(substrate::is_known_frame(&on_disk));
        assert!(!on_disk.windows(6).any(|w| w == b"secret"), "plaintext on disk");
        // Nothing but the file itself was written: no temporary, no sidecar.
        let names: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "{names:?}");

        // Save As from the session: a sealed copy the same passphrase opens.
        write_text(&sessions, &root, opened.token, "copy.md", "a copy").unwrap();
        let copy = open_text(&sessions, &root, "copy.md", Some("pw".into())).unwrap();
        assert_eq!(copy.text, "a copy");

        sessions.close(opened.token);
        sessions.close(copy.token);
        assert_eq!(sessions.len(), 0);
        let err = write_text(&sessions, &root, opened.token, "n.md", "late").unwrap_err();
        assert!(err.starts_with("no_session"), "{err}");
    }

    #[test]
    fn a_wrong_passphrase_a_plain_file_and_a_damaged_file_are_refused() {
        let root = scratch("sealed-refuse");
        let sessions = SealSessions::new();
        put(&root, "n.md", b"x");
        LOCKER.lock_file(&root.join("n.md").to_string_lossy(), Some("pw".into())).unwrap();
        assert!(open_text(&sessions, &root, "n.md", Some("nope".into())).unwrap_err().starts_with("wrong_password"));
        put(&root, "plain.md", b"plain");
        assert!(open_text(&sessions, &root, "plain.md", Some("pw".into())).unwrap_err().starts_with("not_locked"));
        let mut damaged = std::fs::read(root.join("n.md")).unwrap();
        damaged.truncate(substrate::PREFIX_LEN + 3);
        put(&root, "damaged.md", &damaged);
        assert!(open_text(&sessions, &root, "damaged.md", Some("pw".into())).unwrap_err().starts_with("crypto"));
        assert_eq!(sessions.len(), 0, "a refusal keeps no session");
    }

    #[test]
    fn the_workspace_boundary_holds_for_sealed_files_too() {
        let root = scratch("sealed-boundary");
        let other = scratch("sealed-boundary-other");
        let sessions = SealSessions::new();
        put(&other, "s.md", b"elsewhere");
        LOCKER.lock_file(&other.join("s.md").to_string_lossy(), Some("pw".into())).unwrap();
        let err = open_text(&sessions, &root, &other.join("s.md").to_string_lossy(), Some("pw".into())).unwrap_err();
        assert!(err.starts_with("outside_workspace"), "{err}");
        assert!(open_bytes(&root, "../x.png", Some("pw".into())).unwrap_err().starts_with("outside_workspace"));

        put(&root, "n.md", b"inside");
        LOCKER.lock_file(&root.join("n.md").to_string_lossy(), Some("pw".into())).unwrap();
        let opened = open_text(&sessions, &root, "n.md", Some("pw".into())).unwrap();
        let err = write_text(&sessions, &root, opened.token, "../escape.md", "x").unwrap_err();
        assert!(err.starts_with("outside_workspace"), "{err}");
    }

    #[test]
    fn a_picture_is_decrypted_to_bytes_with_no_session() {
        let root = scratch("sealed-bytes");
        put(&root, "p.png", &[137, 80, 78, 71, 0, 1]);
        LOCKER.lock_file(&root.join("p.png").to_string_lossy(), Some("pw".into())).unwrap();
        assert_eq!(open_bytes(&root, "p.png", Some("pw".into())).unwrap(), vec![137, 80, 78, 71, 0, 1]);
        put(&root, "bin.md", &[0xff, 0xfe]);
        LOCKER.lock_file(&root.join("bin.md").to_string_lossy(), Some("pw".into())).unwrap();
        let sessions = SealSessions::new();
        assert!(open_text(&sessions, &root, "bin.md", Some("pw".into())).unwrap_err().starts_with("not_text"));
    }
}
