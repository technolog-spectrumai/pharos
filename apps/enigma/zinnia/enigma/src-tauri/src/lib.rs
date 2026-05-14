use std::collections::HashMap;
use std::sync::Mutex;

use enigma_core::EnigmaSession;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

// ── In-process session registry ───────────────────────────────────────────────

type Sessions = Mutex<HashMap<String, EnigmaSession>>;

fn session_key(room: &str, identity: &str) -> String {
    format!("{}:{}", room, identity)
}

// ── Persistence helpers ───────────────────────────────────────────────────────

fn state_path(app: &AppHandle, room: &str, identity: &str) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    // Sanitize room/identity so they are safe as filename components.
    let safe = |s: &str| s.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).collect::<String>();
    dir.join(format!("mls_{}_{}.bin", safe(room), safe(identity)))
}

fn persist(app: &AppHandle, session: &EnigmaSession, room: &str, identity: &str) {
    if let Ok(mut bytes) = session.export_state() {
        let _ = std::fs::write(state_path(app, room, identity), &bytes);
        bytes.zeroize(); // clear exported state from memory after writing
    }
}

fn restore(app: &AppHandle, room: &str, identity: &str) -> Option<EnigmaSession> {
    let mut bytes = std::fs::read(state_path(app, room, identity)).ok()?;
    let result = EnigmaSession::import_state(&bytes).ok();
    bytes.zeroize();
    result
}

fn wipe_file(app: &AppHandle, room: &str, identity: &str) {
    let path = state_path(app, room, identity);
    // Overwrite with zeros before deleting so OS doesn't retain plaintext.
    if let Ok(meta) = std::fs::metadata(&path) {
        let zeros = vec![0u8; meta.len() as usize];
        let _ = std::fs::write(&path, &zeros);
    }
    let _ = std::fs::remove_file(path);
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Initialise or restore an MLS session.  Returns `true` if a previous
/// session was restored from disk, `false` if a fresh group was created.
#[tauri::command]
fn mls_init_session(
    app: AppHandle,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) -> Result<bool, String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;

    if map.contains_key(&key) {
        return Ok(true); // already live in memory
    }

    // Try to restore from disk.
    if let Some(session) = restore(&app, &room, &identity) {
        map.insert(key, session);
        return Ok(true);
    }

    // Create a fresh session (includes create_group).
    let mut session = EnigmaSession::new(room.clone(), identity.clone())?;
    session.create_group()?;
    persist(&app, &session, &room, &identity);
    map.insert(key, session);
    Ok(false)
}

/// Generate a fresh key package for this session.
#[tauri::command]
fn mls_key_package(
    app: AppHandle,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) -> Result<Vec<u8>, String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;
    let session = map.get_mut(&key).ok_or("session not initialised")?;
    let kp = session.key_package()?;
    persist(&app, session, &room, &identity);
    Ok(kp)
}

/// Add a remote peer (their key package bytes) to this group.
/// Returns `[welcome_bytes, commit_bytes]`.
#[tauri::command]
fn mls_add_member(
    app: AppHandle,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    key_package: Vec<u8>,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;
    let session = map.get_mut(&key).ok_or("session not initialised")?;
    let (welcome, commit) = session.add_member(&key_package)?;
    persist(&app, session, &room, &identity);
    Ok((welcome, commit))
}

/// Join a group using a Welcome message received from the group creator.
#[tauri::command]
fn mls_join_from_welcome(
    app: AppHandle,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    welcome: Vec<u8>,
) -> Result<(), String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;
    let session = map.get_mut(&key).ok_or("session not initialised")?;
    session.join_from_welcome(&welcome)?;
    persist(&app, session, &room, &identity);
    Ok(())
}

/// Process an opaque MLS message (commit or application message).
/// Returns the decrypted plaintext for application messages, `null` for commits/proposals.
#[tauri::command]
fn mls_process_message(
    app: AppHandle,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    bytes: Vec<u8>,
) -> Result<Option<Vec<u8>>, String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;
    let session = map.get_mut(&key).ok_or("session not initialised")?;
    let plaintext = session.process_message(&bytes)?;
    persist(&app, session, &room, &identity);
    Ok(plaintext)
}

/// Encrypt a plaintext application message.  The plaintext is zeroized
/// in Rust memory immediately after encryption.
#[tauri::command]
fn mls_encrypt(
    app: AppHandle,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    mut plaintext: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;
    let session = map.get_mut(&key).ok_or("session not initialised")?;
    let ct = session.encrypt_app(&plaintext)?;
    plaintext.zeroize(); // wipe plaintext from Rust heap immediately
    persist(&app, session, &room, &identity);
    Ok(ct)
}

/// Remove a session from memory and securely wipe its on-disk state.
#[tauri::command]
fn mls_clear_state(
    app: AppHandle,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) {
    let key = session_key(&room, &identity);
    if let Ok(mut map) = sessions.lock() {
        map.remove(&key);
    }
    wipe_file(&app, &room, &identity);
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            mls_init_session,
            mls_key_package,
            mls_add_member,
            mls_join_from_welcome,
            mls_process_message,
            mls_encrypt,
            mls_clear_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
