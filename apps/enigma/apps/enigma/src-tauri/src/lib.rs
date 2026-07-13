use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rotor_core::RotorSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

mod p2p_iroh;
mod p2p_tor;
mod realtime;
// Encryption-at-rest: the centralized encrypted store integration (protasius).
// Replaces the old plaintext kv.rs + per-file persistence.
mod vault;
// Outbound Arti client plumbing, reused by the peer-hosted onion transport in
// p2p_tor.rs (see the TODO(onion-p2p) note at the top of tor.rs).
mod tor;
mod fs_local;

// ── App config ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub profile: String,
    pub identity: String,
}

pub(crate) type AppConfigState = Mutex<AppConfig>;

#[derive(Debug, Clone, Serialize)]
pub struct AppRuntimeConfig {
    pub profile: String,
    pub identity: String,
    pub profile_state_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineProfile {
    pub display_name: String,
    pub email: String,
    pub phone: String,
    pub bio: String,
    pub date_of_birth: String,
}

impl Default for OfflineProfile {
    fn default() -> Self {
        Self {
            display_name: String::new(),
            email: String::new(),
            phone: String::new(),
            bio: String::new(),
            date_of_birth: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OfflineProfileOption {
    pub id: String,
    pub label: String,
    pub profile: OfflineProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppProfileState {
    #[serde(default)]
    pub offline_profile: OfflineProfile,
    #[serde(default)]
    pub offline_profiles: Vec<OfflineProfileOption>,
    #[serde(default)]
    pub selected_offline_profile_id: String,
    // offline — airplane mode: block ALL network (the app is serverless, so this
    // means every P2P connection).
    #[serde(default)]
    pub offline: bool,
    // use_tor — route rendezvous + chat over the peer-hosted Tor onion transport
    // (p2p_tor.rs) instead of iroh. Exclusive: when on, iroh is not used.
    #[serde(default)]
    pub use_tor: bool,
    // stable_onion — keep the Tor onion address stable across restarts. When on,
    // the hidden-service key is kept (encrypted at rest, materialized only while
    // unlocked); when off, the onion is ephemeral and regenerates each session.
    #[serde(default)]
    pub stable_onion: bool,
}

/// Airplane mode — blocks every network connection (all P2P).
pub(crate) fn is_offline(state: &AppProfileState) -> bool {
    state.offline
}

/// True when this profile routes over the Tor onion transport instead of iroh.
pub(crate) fn is_use_tor(state: &AppProfileState) -> bool {
    state.use_tor
}

/// True when the Tor onion address should persist across restarts.
pub(crate) fn is_stable_onion(state: &AppProfileState) -> bool {
    state.stable_onion
}

// ── In-process session registry ───────────────────────────────────────────────

pub(crate) type Sessions = Mutex<HashMap<String, RotorSession>>;

fn session_key(profile: &str, room: &str, identity: &str) -> String {
    format!("{}:{}:{}", profile, room, identity)
}

// ── Small helpers ─────────────────────────────────────────────────────────────

pub(crate) fn safe_filename_component(s: &str) -> String {
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

pub(crate) fn active_config(config: &State<AppConfigState>) -> Result<AppConfig, String> {
    config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())
}

fn runtime_config(app: &AppHandle, config: &AppConfig) -> AppRuntimeConfig {
    AppRuntimeConfig {
        profile: config.profile.clone(),
        identity: config.identity.clone(),
        profile_state_path: profile_state_path(app, config).display().to_string(),
    }
}

// ── Persistence helpers ───────────────────────────────────────────────────────

pub(crate) fn profile_dir(app: &AppHandle, config: &AppConfig) -> std::path::PathBuf {
    let base_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let profile = safe_filename_component(&config.profile);
    let dir = base_dir.join("profiles").join(profile);

    let _ = std::fs::create_dir_all(&dir);

    dir
}

fn profile_state_path(app: &AppHandle, config: &AppConfig) -> std::path::PathBuf {
    profile_dir(app, config).join("profile_state.json")
}

pub(crate) fn load_profile_state(app: &AppHandle, config: &AppConfig) -> AppProfileState {
    // Encrypted at rest via protasius (`profile/state`).
    let decoded = match vault::get(app, "profile", "state") {
        Ok(Some(bytes)) => serde_json::from_slice::<AppProfileState>(&bytes).unwrap_or_default(),
        // Genuinely absent (first run): a fresh default.
        Ok(None) => AppProfileState::default(),
        // Locked (behind the gate — shouldn't happen) or a decrypt failure. Surface
        // it rather than silently proceeding as if empty; callers that then save
        // only overwrite already-undecryptable data (a locked save errors instead).
        Err(err) => {
            eprintln!("profile state load failed: {err}");
            AppProfileState::default()
        }
    };
    normalize_profile_state(decoded, config)
}

fn save_profile_state(
    app: &AppHandle,
    config: &AppConfig,
    state: &AppProfileState,
) -> Result<(), String> {
    let state = normalize_profile_state(state.clone(), config);
    let bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
    vault::put(app, "profile", "state", &bytes)
}

fn default_offline_profile_option(
    config: &AppConfig,
    profile: OfflineProfile,
) -> OfflineProfileOption {
    let label = if config.identity.trim().is_empty() {
        config.profile.trim()
    } else {
        config.identity.trim()
    };
    let label = if label.is_empty() { "Default" } else { label };

    let id = safe_filename_component(label);
    let id = if id.is_empty() {
        "default".to_string()
    } else {
        id
    };

    OfflineProfileOption {
        id,
        label: label.to_string(),
        profile,
    }
}

fn normalize_profile_state(mut state: AppProfileState, config: &AppConfig) -> AppProfileState {
    if state.offline_profiles.is_empty() {
        let default_profile = default_offline_profile_option(config, state.offline_profile.clone());
        state.selected_offline_profile_id = default_profile.id.clone();
        state.offline_profiles.push(default_profile);
    } else if state.offline_profiles.len() == 1
        && state.offline_profiles[0].id == "default"
        && state.offline_profiles[0].label == "Default"
    {
        let default_profile =
            default_offline_profile_option(config, state.offline_profiles[0].profile.clone());
        state.selected_offline_profile_id = default_profile.id.clone();
        state.offline_profiles[0] = default_profile;
    }

    if state.selected_offline_profile_id.is_empty() {
        state.selected_offline_profile_id = state
            .offline_profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_else(|| "default".to_string());
    }

    if !state
        .offline_profiles
        .iter()
        .any(|profile| profile.id == state.selected_offline_profile_id)
    {
        state.selected_offline_profile_id = state
            .offline_profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_else(|| "default".to_string());
    }

    if let Some(selected) = state
        .offline_profiles
        .iter()
        .find(|profile| profile.id == state.selected_offline_profile_id)
    {
        state.offline_profile = selected.profile.clone();
    }

    state
}

/// MLS session key within protasius' `mls` namespace: `room\0identity` (raw, so it
/// matches the `room_slug`/`identity` fields the migration reads from a legacy blob).
fn mls_key(room: &str, identity: &str) -> String {
    format!("{room}\0{identity}")
}

fn persist(
    app: &AppHandle,
    _config: &AppConfig,
    session: &RotorSession,
    room: &str,
    identity: &str,
) {
    if let Ok(mut bytes) = session.export_state() {
        let _ = vault::put(app, "mls", &mls_key(room, identity), &bytes);
        bytes.zeroize();
    }
}

fn restore(
    app: &AppHandle,
    _config: &AppConfig,
    room: &str,
    identity: &str,
) -> Option<RotorSession> {
    let mut bytes = vault::get(app, "mls", &mls_key(room, identity)).ok()??;
    let result = RotorSession::import_state(&bytes).ok();
    bytes.zeroize();
    result
}

fn wipe_file(app: &AppHandle, _config: &AppConfig, room: &str, identity: &str) {
    let _ = vault::delete(app, "mls", &mls_key(room, identity));
}

/// Minimal view of a legacy `mls_*.bin` (a serde_json `ExportedRotorState`) — just
/// the two fields needed to key the record. Extra fields are ignored.
#[derive(Deserialize)]
struct MlsMeta {
    room_slug: String,
    identity: String,
}

/// Migrate any legacy plaintext `mls_*.bin` blobs in the profile dir into the
/// encrypted store, then securely delete them. Idempotent (safe to re-run as a
/// post-unlock sweep). Runs here (not in protasius) because it must parse the blob.
pub(crate) fn migrate_mls(app: &AppHandle, config: &AppConfig) {
    let dir = profile_dir(app, config);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if !(name.starts_with("mls_") && name.ends_with(".bin")) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(meta) = serde_json::from_slice::<MlsMeta>(&bytes) else { continue };
        if vault::put(app, "mls", &mls_key(&meta.room_slug, &meta.identity), &bytes).is_ok() {
            if let Ok(m) = std::fs::metadata(&path) {
                let _ = std::fs::write(&path, vec![0u8; m.len() as usize]);
            }
            let _ = std::fs::remove_file(&path);
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn current_profile(config: State<AppConfigState>) -> Result<String, String> {
    Ok(active_config(&config)?.profile)
}

#[tauri::command]
fn current_identity(config: State<AppConfigState>) -> Result<String, String> {
    Ok(active_config(&config)?.identity)
}

#[tauri::command]
fn app_get_runtime_config(
    app: AppHandle,
    config: State<AppConfigState>,
) -> Result<AppRuntimeConfig, String> {
    Ok(runtime_config(&app, &active_config(&config)?))
}

#[tauri::command]
async fn app_set_active_profile(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    sessions: State<'_, Sessions>,
    vault: State<'_, vault::ProtasiusState>,
    p2p: State<'_, p2p_iroh::P2pState>,
    tor: State<'_, p2p_tor::TorP2pState>,
    profile: String,
    identity: Option<String>,
) -> Result<AppRuntimeConfig, String> {
    let profile = profile.trim();
    if profile.is_empty() {
        return Err("profile is required".to_string());
    }

    let identity = identity
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| profile.to_string());

    let next_config = AppConfig {
        profile: profile.to_string(),
        identity,
    };

    // Tear down the OLD profile's transports FIRST, while its vault is still
    // unlocked and active — so p2p_tor::shutdown seals the stable-onion keystore
    // into the correct (old) profile's store before we swap it out.
    p2p_iroh::shutdown(&app, &p2p).await;
    p2p_tor::shutdown(&app, &tor).await;

    {
        let mut guard = config.lock().map_err(|e| e.to_string())?;
        *guard = next_config.clone();
    }

    if let Ok(mut sessions) = sessions.lock() {
        sessions.clear();
    }

    // Re-open the store for the new profile, LOCKED — each profile has its own
    // vault/passphrase. The frontend re-runs the gate (status → setup/unlock).
    {
        let mut store = vault.0.lock().map_err(|e| e.to_string())?;
        *store = vault::open(profile_dir(&app, &next_config))?;
    }

    Ok(runtime_config(&app, &next_config))
}

#[tauri::command]
fn app_get_profile_state(
    app: AppHandle,
    config: State<AppConfigState>,
) -> Result<AppProfileState, String> {
    let config = active_config(&config)?;
    Ok(load_profile_state(&app, &config))
}

#[tauri::command]
fn app_get_offline(app: AppHandle, config: State<AppConfigState>) -> Result<bool, String> {
    let config = active_config(&config)?;
    Ok(load_profile_state(&app, &config).offline)
}

#[tauri::command]
async fn app_set_offline(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, p2p_iroh::P2pState>,
    tor: State<'_, p2p_tor::TorP2pState>,
    offline: bool,
) -> Result<(), String> {
    let config = active_config(&config)?;
    let mut state = load_profile_state(&app, &config);
    state.offline = offline;
    save_profile_state(&app, &config, &state)?;
    // Airplane mode is "block ALL network": persisting the flag only gates NEW
    // commands, so also tear down whichever transport(s) are live.
    if offline {
        p2p_iroh::shutdown(&app, &p2p).await;
        p2p_tor::shutdown(&app, &tor).await;
    }
    Ok(())
}

#[tauri::command]
fn app_get_use_tor(app: AppHandle, config: State<AppConfigState>) -> Result<bool, String> {
    let config = active_config(&config)?;
    Ok(load_profile_state(&app, &config).use_tor)
}

#[tauri::command]
async fn app_set_use_tor(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, p2p_iroh::P2pState>,
    tor: State<'_, p2p_tor::TorP2pState>,
    use_tor: bool,
) -> Result<(), String> {
    let config = active_config(&config)?;
    let mut state = load_profile_state(&app, &config);
    state.use_tor = use_tor;
    save_profile_state(&app, &config, &state)?;
    // Tor is exclusive: tear down the transport we're leaving so the next room
    // command lazily re-binds on the chosen one.
    if use_tor {
        p2p_iroh::shutdown(&app, &p2p).await;
    } else {
        p2p_tor::shutdown(&app, &tor).await;
    }
    Ok(())
}

#[tauri::command]
fn app_get_stable_onion(app: AppHandle, config: State<AppConfigState>) -> Result<bool, String> {
    let config = active_config(&config)?;
    Ok(load_profile_state(&app, &config).stable_onion)
}

#[tauri::command]
async fn app_set_stable_onion(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    tor: State<'_, p2p_tor::TorP2pState>,
    stable_onion: bool,
) -> Result<(), String> {
    let config = active_config(&config)?;
    let mut state = load_profile_state(&app, &config);
    state.stable_onion = stable_onion;
    save_profile_state(&app, &config, &state)?;
    // Tear the Tor node down so the next room command re-evaluates persistent vs
    // ephemeral keystore for the new setting.
    p2p_tor::shutdown(&app, &tor).await;
    Ok(())
}

#[tauri::command]
fn app_clear_profile_state(
    app: AppHandle,
    config: State<AppConfigState>,
) -> Result<AppProfileState, String> {
    let config = active_config(&config)?;
    let state = normalize_profile_state(AppProfileState::default(), &config);
    save_profile_state(&app, &config, &state)?;
    Ok(state)
}

#[tauri::command]
fn app_get_offline_profile(
    app: AppHandle,
    config: State<AppConfigState>,
) -> Result<OfflineProfile, String> {
    let config = active_config(&config)?;
    Ok(load_profile_state(&app, &config).offline_profile)
}

#[tauri::command]
fn app_set_offline_profile(
    app: AppHandle,
    config: State<AppConfigState>,
    offline_profile: OfflineProfile,
) -> Result<(), String> {
    let config = active_config(&config)?;
    let mut state = load_profile_state(&app, &config);
    if let Some(selected) = state
        .offline_profiles
        .iter_mut()
        .find(|profile| profile.id == state.selected_offline_profile_id)
    {
        selected.profile = offline_profile.clone();
    }
    state.offline_profile = offline_profile;
    save_profile_state(&app, &config, &state)
}

#[tauri::command]
fn app_clear_offline_profile(
    app: AppHandle,
    config: State<AppConfigState>,
) -> Result<AppProfileState, String> {
    let config = active_config(&config)?;
    let mut state = load_profile_state(&app, &config);
    let empty_profile = OfflineProfile::default();

    if let Some(selected) = state
        .offline_profiles
        .iter_mut()
        .find(|profile| profile.id == state.selected_offline_profile_id)
    {
        selected.profile = empty_profile.clone();
    }

    state.offline_profile = empty_profile;
    state = normalize_profile_state(state, &config);
    save_profile_state(&app, &config, &state)?;

    Ok(state)
}

#[tauri::command]
fn app_set_selected_offline_profile(
    app: AppHandle,
    config: State<AppConfigState>,
    selected_offline_profile_id: String,
) -> Result<AppProfileState, String> {
    let config = active_config(&config)?;
    let mut state = load_profile_state(&app, &config);

    if !state
        .offline_profiles
        .iter()
        .any(|profile| profile.id == selected_offline_profile_id)
    {
        return Err("offline profile not found".to_string());
    }

    state.selected_offline_profile_id = selected_offline_profile_id;
    state = normalize_profile_state(state, &config);
    save_profile_state(&app, &config, &state)?;

    Ok(state)
}

#[tauri::command]
fn app_load_offline_profile(
    app: AppHandle,
    config: State<AppConfigState>,
    label: String,
) -> Result<AppProfileState, String> {
    let config = active_config(&config)?;
    let mut state = load_profile_state(&app, &config);
    let label = label.trim().to_string();

    if label.is_empty() {
        return Err("offline profile name is required".to_string());
    }

    let offline_profile_id = safe_filename_component(&label);
    if offline_profile_id.is_empty() {
        return Err("offline profile name must contain at least one safe character".to_string());
    }

    if let Some(existing) = state
        .offline_profiles
        .iter()
        .find(|profile| profile.id == offline_profile_id || profile.label == label)
    {
        state.selected_offline_profile_id = existing.id.clone();
    } else {
        state.offline_profiles.push(OfflineProfileOption {
            id: offline_profile_id.clone(),
            label,
            profile: OfflineProfile::default(),
        });
        state.selected_offline_profile_id = offline_profile_id;
    }

    state = normalize_profile_state(state, &config);
    save_profile_state(&app, &config, &state)?;

    Ok(state)
}

#[tauri::command]
fn app_upsert_offline_profile(
    app: AppHandle,
    config: State<AppConfigState>,
    offline_profile_id: String,
    label: String,
    offline_profile: OfflineProfile,
) -> Result<AppProfileState, String> {
    let config = active_config(&config)?;
    let mut state = load_profile_state(&app, &config);
    let offline_profile_id = safe_filename_component(&offline_profile_id);
    let label = label.trim().to_string();

    if offline_profile_id.is_empty() {
        return Err("offline profile id is required".to_string());
    }

    if label.is_empty() {
        return Err("offline profile label is required".to_string());
    }

    if let Some(existing) = state
        .offline_profiles
        .iter_mut()
        .find(|profile| profile.id == offline_profile_id)
    {
        existing.label = label;
        existing.profile = offline_profile.clone();
    } else {
        state.offline_profiles.push(OfflineProfileOption {
            id: offline_profile_id.clone(),
            label,
            profile: offline_profile.clone(),
        });
    }

    state.selected_offline_profile_id = offline_profile_id;
    state.offline_profile = offline_profile;
    state = normalize_profile_state(state, &config);
    save_profile_state(&app, &config, &state)?;

    Ok(state)
}

/// Initialise or restore an MLS session.
///
/// Returns:
/// - `true` if a previous session was restored or already existed in memory
/// - `false` if a fresh group was created
#[tauri::command]
fn mls_init_session(
    app: AppHandle,
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) -> Result<bool, String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;

    if map.contains_key(&key) {
        return Ok(true);
    }

    if let Some(session) = restore(&app, &config, &room, &identity) {
        map.insert(key, session);
        return Ok(true);
    }

    let mut session = RotorSession::new(room.clone(), identity.clone())?;
    session.create_group()?;

    persist(&app, &config, &session, &room, &identity);
    map.insert(key, session);

    Ok(false)
}

/// Generate a fresh key package for this session.
#[tauri::command]
fn mls_key_package(
    app: AppHandle,
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) -> Result<Vec<u8>, String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);
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
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    key_package: Vec<u8>,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);
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
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    welcome: Vec<u8>,
) -> Result<(), String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);
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
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    bytes: Vec<u8>,
) -> Result<Option<Vec<u8>>, String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);
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
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    mut plaintext: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);
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
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) -> Result<(), String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);

    if let Ok(mut map) = sessions.lock() {
        map.remove(&key);
    }

    wipe_file(&app, &config, &room, &identity);
    Ok(())
}

/// Authenticated roster: the device identities of all current MLS group members.
#[tauri::command]
fn mls_members(
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
) -> Result<Vec<String>, String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);
    let map = sessions.lock().map_err(|e| e.to_string())?;
    let session = map
        .get(&key)
        .ok_or_else(|| "session not initialised".to_string())?;
    session.members()
}

/// Remove a member (admin). Returns the remove-commit bytes to broadcast.
#[tauri::command]
fn mls_remove_member(
    app: AppHandle,
    config: State<AppConfigState>,
    sessions: State<Sessions>,
    room: String,
    identity: String,
    target: String,
) -> Result<Vec<u8>, String> {
    let config = active_config(&config)?;
    let key = session_key(&config.profile, &room, &identity);
    let mut map = sessions.lock().map_err(|e| e.to_string())?;
    let session = map
        .get_mut(&key)
        .ok_or_else(|| "session not initialised".to_string())?;
    let commit = session.remove_member(&target)?;
    persist(&app, &config, session, &room, &identity);
    Ok(commit)
}

// ── Native audio recording ────────────────────────────────────────────────────
//
// cpal::Stream is !Send on Linux (ALSA), so it cannot live in Tauri managed state.
// Instead we keep the stream on a dedicated recording thread and communicate via
// an AtomicBool stop-flag. The state struct only holds Send+Sync Arc<…> fields.

struct AudioRecorder {
    stop_flag: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
}

impl Default for AudioRecorder {
    fn default() -> Self {
        Self {
            stop_flag: Arc::new(AtomicBool::new(false)),
            samples: Arc::new(Mutex::new(Vec::new())),
            sample_rate: Arc::new(Mutex::new(44100)),
        }
    }
}

fn encode_wav(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(v).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

#[tauri::command]
fn audio_start_recording(recorder: State<AudioRecorder>) -> Result<(), String> {
    recorder.stop_flag.store(false, Ordering::SeqCst);
    recorder.samples.lock().unwrap().clear();

    let stop_flag = recorder.stop_flag.clone();
    let samples = recorder.samples.clone();
    let sample_rate_out = recorder.sample_rate.clone();

    // Probe config on the calling thread (no Send needed here).
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("No input device available")?;
    let config = device.default_input_config().map_err(|e| e.to_string())?;
    let sr = config.sample_rate().0;
    let ch = config.channels() as usize;
    *sample_rate_out.lock().unwrap() = sr;

    // The stream is !Send, so it must be built AND lived on the same thread.
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => { eprintln!("[audio] no input device"); return; }
        };
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => { eprintln!("[audio] config error: {e}"); return; }
        };

        macro_rules! build_stream {
            ($T:ty, $convert:expr) => {
                device.build_input_stream(
                    &config.clone().into(),
                    {
                        let samples = samples.clone();
                        move |data: &[$T], _: &_| {
                            let mut buf = samples.lock().unwrap();
                            let floats: Vec<f32> = data.iter().map($convert).collect();
                            if ch == 1 {
                                buf.extend_from_slice(&floats);
                            } else {
                                buf.extend(floats.chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32));
                            }
                        }
                    },
                    |e| eprintln!("[audio] stream error: {e}"),
                    None,
                )
            };
        }

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => build_stream!(f32, |&s: &f32| s),
            cpal::SampleFormat::I16 => build_stream!(i16, |&s: &i16| s as f32 / i16::MAX as f32),
            cpal::SampleFormat::U16 => build_stream!(u16, |&s: &u16| (s as f32 / u16::MAX as f32) * 2.0 - 1.0),
            fmt => { eprintln!("[audio] unsupported format: {fmt:?}"); return; }
        };

        let stream = match stream {
            Ok(s) => s,
            Err(e) => { eprintln!("[audio] build_input_stream error: {e}"); return; }
        };

        if let Err(e) = stream.play() {
            eprintln!("[audio] play error: {e}");
            return;
        }

        // Keep the stream alive until stop is requested.
        while !stop_flag.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // stream dropped here → recording stops
    });

    Ok(())
}

#[tauri::command]
fn audio_stop_recording(recorder: State<AudioRecorder>) -> Result<Vec<u8>, String> {
    recorder.stop_flag.store(true, Ordering::SeqCst);
    // Give the recording thread ~40 ms to notice the flag and flush its last buffer.
    std::thread::sleep(std::time::Duration::from_millis(40));
    let samples = recorder.samples.lock().unwrap().clone();
    let sr = *recorder.sample_rate.lock().unwrap();
    encode_wav(&samples, sr)
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let profile = std::env::var("APP_PROFILE").unwrap_or_else(|_| "default".to_string());
    let identity = std::env::var("CHAT_USER").unwrap_or_else(|_| profile.clone());
    let config = AppConfig { profile, identity };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppConfigState::new(config))
        .manage(Sessions::default())
        .manage(AudioRecorder::default())
        .manage(p2p_iroh::P2pState::default())
        // Outbound Arti client (tor.rs) + the peer-hosted onion transport (p2p_tor.rs).
        .manage(tor::TorState::default())
        .manage(p2p_tor::TorP2pState::default())
        .setup(|app| {
            // Open the active profile's encrypted store (protasius). All app data
            // persists through it; it starts locked until the passphrase gate unlocks it.
            let cfg = app.state::<AppConfigState>().lock().unwrap().clone();
            let dir = profile_dir(app.handle(), &cfg);
            let store = vault::open(dir).expect("open protasius store");
            app.manage(vault::ProtasiusState(std::sync::Mutex::new(store)));

            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{PermissionRequestExt, WebViewExt};
                if let Some(webview) = app.get_webview_window("main") {
                    let _ = webview.with_webview(|wv| {
                        wv.inner().connect_permission_request(|_, request| {
                            request.allow();
                            true
                        });
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_profile,
            current_identity,
            app_get_runtime_config,
            app_set_active_profile,
            app_get_profile_state,
            app_get_offline,
            app_set_offline,
            app_get_use_tor,
            app_set_use_tor,
            app_get_stable_onion,
            app_set_stable_onion,
            vault::vault_status,
            vault::vault_setup,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_change_passphrase,
            vault::vault_wipe,
            app_clear_profile_state,
            app_get_offline_profile,
            app_set_offline_profile,
            app_clear_offline_profile,
            app_set_selected_offline_profile,
            app_load_offline_profile,
            app_upsert_offline_profile,
            mls_init_session,
            mls_key_package,
            mls_add_member,
            mls_join_from_welcome,
            mls_process_message,
            mls_encrypt,
            mls_clear_state,
            mls_members,
            mls_remove_member,
            audio_start_recording,
            audio_stop_recording,
            vault::kv_get,
            vault::kv_put,
            vault::kv_delete,
            vault::kv_clear_namespace,
            vault::kv_count,
            vault::tor_clean_keystore,
            realtime::realtime_send,
            realtime::realtime_create_room,
            realtime::realtime_join_room,
            realtime::realtime_join_room_by_node,
            realtime::realtime_leave_room,
            realtime::realtime_node_info,
            realtime::realtime_tor_set_captain,
            fs_local::fs_read_text_file,
            fs_local::fs_write_text_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // On exit, seal + wipe the Tor onion keystore (stable-onion mode) so no
            // plaintext HS key is left on disk when the app is closed.
            if let tauri::RunEvent::Exit = event {
                let tor = app_handle.state::<p2p_tor::TorP2pState>();
                tauri::async_runtime::block_on(p2p_tor::shutdown(app_handle, &tor));
            }
        });
}
