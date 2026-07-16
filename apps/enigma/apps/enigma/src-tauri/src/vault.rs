// Vault integration — wires `protasius` (the centralized encrypted store) into the
// Tauri app. ALL app data persists through here: the persistence sites in lib.rs /
// p2p_iroh.rs / p2p_tor.rs call `vault::get/put/delete`, which seal/open every
// value under a passphrase-derived key. Locked ⇒ data ops error (the frontend gate
// keeps them from firing before unlock).
//
// The `Protasius` store is opened per active profile and held in managed state.
// `vault_*` commands drive the lifecycle (setup / unlock / lock / change / wipe).

use std::sync::Mutex;

use protasius::{MigrationPlan, Protasius, ProtasiusError, VaultStatus};
use tauri::{AppHandle, Manager, State};

use crate::{active_config, profile_dir, AppConfig, AppConfigState, Sessions};

/// Managed state: the active profile's encrypted store.
pub struct ProtasiusState(pub Mutex<Protasius>);

fn e(err: ProtasiusError) -> String {
    err.to_string()
}

fn store(app: &AppHandle) -> Result<State<'_, ProtasiusState>, String> {
    app.try_state::<ProtasiusState>()
        .ok_or_else(|| "vault not initialized".to_string())
}

// ── helpers used by the persistence sites (lib.rs, p2p_iroh, p2p_tor) ───────────

pub fn get(app: &AppHandle, ns: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
    let st = store(app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.get(ns, key).map_err(e)
}

pub fn put(app: &AppHandle, ns: &str, key: &str, val: &[u8]) -> Result<(), String> {
    let st = store(app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.put(ns, key, val).map_err(e)
}

pub fn delete(app: &AppHandle, ns: &str, key: &str) -> Result<(), String> {
    let st = store(app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.delete(ns, key).map_err(e)
}

/// Read a frontend-namespaced kv value from Rust (same store the `kv_*` commands
/// serve). Lets backend code honor Settings-tab values (e.g. `p2p:settings/…`)
/// without threading flags through every command. Locked/missing ⇒ `None`.
pub fn kv_get_raw(app: &AppHandle, ns: &str, scope: &str, k: &str) -> Option<String> {
    let st = store(app).ok()?;
    let p = st.0.lock().ok()?;
    p.kv_get(ns, scope, k).ok().flatten()
}

/// Write counterpart of `kv_get_raw` — lets backend code persist values into a
/// frontend-visible kv namespace (e.g. cloud.rs storing the session under
/// `cloud:auth` so the frontend can read the username but Rust owns the token).
pub fn kv_put_raw(app: &AppHandle, ns: &str, scope: &str, k: &str, v: &str) -> Result<(), String> {
    let st = store(app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.kv_put(ns, scope, k, v).map_err(e)
}

/// Delete counterpart of `kv_get_raw` (see `kv_put_raw`).
pub fn kv_delete_raw(app: &AppHandle, ns: &str, scope: &str, k: &str) -> Result<(), String> {
    let st = store(app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.kv_delete(ns, scope, k).map_err(e)
}

/// Open the store for a profile directory (used at startup + on profile switch).
pub fn open(dir: std::path::PathBuf) -> Result<Protasius, String> {
    Protasius::open(dir).map_err(e)
}

/// Legacy plaintext sources to fold into the encrypted store on first setup. The
/// iroh key + old kvstore are GLOBAL today (app-data root); the rest are per-profile.
fn migration_plan(app: &AppHandle, cfg: &AppConfig) -> MigrationPlan {
    let dir = profile_dir(app, cfg);
    let base = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    MigrationPlan {
        profile_state_json: Some(dir.join("profile_state.json")),
        iroh_key: Some(base.join("iroh_gossip.key")),
        tor_peer_id: Some(dir.join("tor").join("peer.id")),
        legacy_kvstore_dir: Some(base.join("kvstore")),
    }
}

// ── lifecycle commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_status(vault: State<ProtasiusState>) -> Result<VaultStatus, String> {
    Ok(vault.0.lock().map_err(|e| e.to_string())?.status())
}

#[tauri::command]
pub fn vault_setup(
    app: AppHandle,
    config: State<AppConfigState>,
    vault: State<ProtasiusState>,
    passphrase: String,
) -> Result<(), String> {
    let cfg = active_config(&config)?;
    let plan = migration_plan(&app, &cfg);
    vault.0.lock().map_err(|e| e.to_string())?.setup(&passphrase, &plan).map_err(e)?;
    // MLS `.bin` blobs need parsing to key them, so migrate them here (after the
    // vault is committed + unlocked).
    crate::migrate_mls(&app, &cfg);
    Ok(())
}

#[tauri::command]
pub fn vault_unlock(
    app: AppHandle,
    config: State<AppConfigState>,
    vault: State<ProtasiusState>,
    passphrase: String,
) -> Result<(), String> {
    let cfg = active_config(&config)?;
    {
        let mut p = vault.0.lock().map_err(|e| e.to_string())?;
        p.unlock(&passphrase).map_err(e)?;
        // Sweep any legacy plaintext a prior crash left behind (idempotent).
        let _ = p.migrate(&migration_plan(&app, &cfg));
    }
    crate::migrate_mls(&app, &cfg);
    Ok(())
}

#[tauri::command]
pub fn vault_lock(vault: State<ProtasiusState>) -> Result<(), String> {
    vault.0.lock().map_err(|e| e.to_string())?.lock();
    Ok(())
}

#[tauri::command]
pub fn vault_change_passphrase(
    vault: State<ProtasiusState>,
    current: String,
    new: String,
) -> Result<(), String> {
    vault
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .change_passphrase(&current, &new)
        .map_err(e)
}

#[tauri::command]
pub fn vault_wipe(
    vault: State<ProtasiusState>,
    sessions: State<Sessions>,
) -> Result<(), String> {
    vault.0.lock().map_err(|e| e.to_string())?.wipe().map_err(e)?;
    if let Ok(mut s) = sessions.lock() {
        s.clear();
    }
    Ok(())
}

// ── kv passthrough commands (frontend `kv_*`, now protasius-backed) ─────────────

#[tauri::command]
pub fn kv_get(app: AppHandle, ns: String, scope: String, k: String) -> Result<Option<String>, String> {
    let st = store(&app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.kv_get(&ns, &scope, &k).map_err(e)
}

#[tauri::command]
pub fn kv_put(app: AppHandle, ns: String, scope: String, k: String, v: String) -> Result<(), String> {
    let st = store(&app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.kv_put(&ns, &scope, &k, &v).map_err(e)
}

#[tauri::command]
pub fn kv_delete(app: AppHandle, ns: String, scope: String, k: String) -> Result<(), String> {
    let st = store(&app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.kv_delete(&ns, &scope, &k).map_err(e)
}

#[tauri::command]
pub fn kv_clear_namespace(app: AppHandle, ns: String, scope: Option<String>) -> Result<(), String> {
    let st = store(&app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.kv_clear_namespace(&ns, scope.as_deref()).map_err(e)
}

#[tauri::command]
pub fn kv_count(app: AppHandle, ns: String, scope: Option<String>) -> Result<u64, String> {
    let st = store(&app)?;
    let p = st.0.lock().map_err(|e| e.to_string())?;
    p.kv_count(&ns, scope.as_deref()).map_err(e)
}

/// Reset the Tor onion keystore (identity): tear the node down, wipe the on-disk
/// keystore, and drop the sealed copy from protasius. Recovers from a stale
/// "resource already in use" lock; the next Tor room mints a fresh `.onion`.
#[tauri::command]
pub async fn tor_clean_keystore(
    app: AppHandle,
    tor: State<'_, crate::p2p_tor::TorP2pState>,
) -> Result<(), String> {
    crate::p2p_tor::clean_keystore(&app, &tor).await;
    Ok(())
}
