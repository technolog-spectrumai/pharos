use std::collections::HashMap;
use std::sync::Mutex;

use enigma_core::EnigmaSession;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

// ── App config ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub profile: String,
    pub identity: String,
}

// ── In-process session registry ───────────────────────────────────────────────

type Sessions = Mutex<HashMap<String, EnigmaSession>>;

fn session_key(room: &str, identity: &str) -> String {
    format!("{}:{}", room, identity)
}

// ── Small helpers ─────────────────────────────────────────────────────────────

fn safe_filename_component(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
}

// ── Persistence helpers ───────────────────────────────────────────────────────

fn state_path(
    app: &AppHandle,
    config: &AppConfig,
    room: &str,
    identity: &str,
) -> std::path::PathBuf {
    let base_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let profile = safe_filename_component(&config.profile);
    let room = safe_filename_component(room);
    let identity = safe_filename_component(identity);

    let dir = base_dir.join("profiles").join(profile);
    let _ = std::fs::create_dir_all(&dir);

    dir.join(format!("mls_{}_{}.bin", room, identity))
}

fn persist(
    app: &AppHandle,
    config: &AppConfig,
    session: &EnigmaSession,
    room: &str,
    identity: &str,
) {
    if let Ok(mut bytes) = session.export_state() {
        let _ = std::fs::write(state_path(app, config, room, identity), &bytes);
        bytes.zeroize();
    }
}

fn restore(
    app: &AppHandle,
    config: &AppConfig,
    room: &str,
    identity: &str,
) -> Option<EnigmaSession> {
    let mut bytes = std::fs::read(state_path(app, config, room, identity)).ok()?;
    let result = EnigmaSession::import_state(&bytes).ok();
    bytes.zeroize();
    result
}

fn wipe_file(app: &AppHandle, config: &AppConfig, room: &str, identity: &str) {
    let path = state_path(app, config, room, identity);

    // Best-effort overwrite before delete.
    if let Ok(meta) = std::fs::metadata(&path) {
        let mut zeros = vec![0u8; meta.len() as usize];
        let _ = std::fs::write(&path, &zeros);
        zeros.zeroize();
    }

    let _ = std::fs::remove_file(path);
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn current_profile(config: State<AppConfig>) -> String {
    config.profile.clone()
}

#[tauri::command]
fn current_identity(config: State<AppConfig>) -> String {
    config.identity.clone()
}

/// Initialise or restore an MLS session.
///
/// Returns:
/// - `true` if a previous session was restored or already existed in memory
/// - `false` if a fresh group was created
#[tauri::command]
fn mls_init_session(
    app: AppHandle,
    config: State<AppConfig>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) -> Result<bool, String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;

    if map.contains_key(&key) {
        return Ok(true);
    }

    if let Some(session) = restore(&app, &config, &room, &identity) {
        map.insert(key, session);
        return Ok(true);
    }

    let mut session = EnigmaSession::new(room.clone(), identity.clone())?;
    session.create_group()?;

    persist(&app, &config, &session, &room, &identity);
    map.insert(key, session);

    Ok(false)
}

/// Generate a fresh key package for this session.
#[tauri::command]
fn mls_key_package(
    app: AppHandle,
    config: State<AppConfig>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) -> Result<Vec<u8>, String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;

    let session = map
        .get_mut(&key)
        .ok_or_else(|| "session not initialised".to_string())?;

    let kp = session.key_package()?;

    persist(&app, &config, session, &room, &identity);

    Ok(kp)
}

/// Add a remote peer using their key package bytes.
///
/// Returns:
/// - `welcome_bytes`
/// - `commit_bytes`
#[tauri::command]
fn mls_add_member(
    app: AppHandle,
    config: State<AppConfig>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    key_package: Vec<u8>,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;

    let session = map
        .get_mut(&key)
        .ok_or_else(|| "session not initialised".to_string())?;

    let result = session.add_member(&key_package)?;

    persist(&app, &config, session, &room, &identity);

    Ok(result)
}

/// Join a group using a Welcome message received from the group creator.
#[tauri::command]
fn mls_join_from_welcome(
    app: AppHandle,
    config: State<AppConfig>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    welcome: Vec<u8>,
) -> Result<(), String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;

    let session = map
        .get_mut(&key)
        .ok_or_else(|| "session not initialised".to_string())?;

    session.join_from_welcome(&welcome)?;

    persist(&app, &config, session, &room, &identity);

    Ok(())
}

/// Process an opaque MLS message: commit, proposal, or application message.
///
/// Returns:
/// - `Some(plaintext)` for application messages
/// - `None` for commits/proposals/control messages
#[tauri::command]
fn mls_process_message(
    app: AppHandle,
    config: State<AppConfig>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    bytes: Vec<u8>,
) -> Result<Option<Vec<u8>>, String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;

    let session = map
        .get_mut(&key)
        .ok_or_else(|| "session not initialised".to_string())?;

    let plaintext = session.process_message(&bytes)?;

    persist(&app, &config, session, &room, &identity);

    Ok(plaintext)
}

/// Encrypt a plaintext application message.
///
/// The plaintext is zeroized in Rust memory immediately after encryption.
#[tauri::command]
fn mls_encrypt(
    app: AppHandle,
    config: State<AppConfig>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    mut plaintext: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let key = session_key(&room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;

    let session = map
        .get_mut(&key)
        .ok_or_else(|| "session not initialised".to_string())?;

    let ciphertext = session.encrypt_app(&plaintext)?;

    plaintext.zeroize();

    persist(&app, &config, session, &room, &identity);

    Ok(ciphertext)
}

/// Remove a session from memory and wipe its on-disk state.
#[tauri::command]
fn mls_clear_state(
    app: AppHandle,
    config: State<AppConfig>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) {
    let key = session_key(&room, &identity);

    if let Ok(mut map) = sessions.lock() {
        map.remove(&key);
    }

    wipe_file(&app, &config, &room, &identity);
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(config: AppConfig) {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(config)
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            current_profile,
            current_identity,
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