// Vault integration — wires `protasius` (the centralized encrypted store) into the
// Tauri app. ALL app data persists through here: the persistence sites in lib.rs /
// p2p_iroh.rs / p2p_tor.rs call `vault::get/put/delete`, which seal/open every
// value under a passphrase-derived key. Locked ⇒ data ops error (the frontend gate
// keeps them from firing before unlock).
//
// The `Protasius` store is opened per active profile and held in managed state.
// `vault_*` commands drive the lifecycle (setup / unlock / lock / change / wipe),
// including the PANIC CODE: a second passphrase that, typed at the unlock gate,
// destroys every profile on the device and silently opens a fresh empty one
// (`panic_wipe` below).

use std::sync::Mutex;

use protasius::{MigrationPlan, Protasius, ProtasiusError, UnlockOutcome, VaultStatus};
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
    vault
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .setup_with_kdf(&passphrase, crate::kdf_params(), &plan)
        .map_err(e)?;
    // MLS `.bin` blobs need parsing to key them, so migrate them here (after the
    // vault is committed + unlocked).
    crate::migrate_mls(&app, &cfg);
    Ok(())
}

/// Unlock the vault — or, if the passphrase is the PANIC CODE, destroy everything
/// and hand back a clean profile.
///
/// The panic path deliberately returns `Ok(())` exactly like a normal unlock: the
/// frontend proceeds into a working (empty) app and nothing in the UI, the return
/// value, or the logs distinguishes the two. Whoever is watching over the user's
/// shoulder sees an ordinary login.
#[tauri::command]
pub fn vault_unlock(
    app: AppHandle,
    config: State<AppConfigState>,
    vault: State<ProtasiusState>,
    sessions: State<Sessions>,
    passphrase: String,
) -> Result<(), String> {
    let cfg = active_config(&config)?;
    {
        let mut p = vault.0.lock().map_err(|e| e.to_string())?;
        if p.unlock(&passphrase).map_err(e)? == UnlockOutcome::Panic {
            drop(p); // panic_wipe re-takes the lock (and replaces the store)
            return panic_wipe(&app, &cfg, &vault, &sessions, &passphrase);
        }
        // Sweep any legacy plaintext a prior crash left behind (idempotent).
        let _ = p.migrate(&migration_plan(&app, &cfg));
    }
    crate::migrate_mls(&app, &cfg);
    // Self-heal the panic-targets sidecar in case a crash landed between a
    // locked-files index edit and its resync last session.
    resync_panic_targets(&app);
    Ok(())
}

/// Duress wipe: erase every profile on this device, then start a fresh vault keyed
/// by the panic code itself so the app opens clean.
///
/// INVARIANT: this only ever runs from the unlock gate, and nothing is live when
/// it does — at startup the gate blocks everything before the loaders run, and a
/// mid-session gate is only ever reached through `vault_lock`, which has already
/// torn every transport down. So, unlike a profile switch, nothing needs stopping
/// here. Any future path that locks the vault must keep that true.
///
/// What survives, deliberately: ENIGLOCK-locked files the user keeps elsewhere on
/// disk (only the index of them dies with the vault; each is still encrypted under
/// its own passphrase) — UNLESS the "Delete files on panic" knob (Settings → Lock)
/// is armed, in which case those marked files are deleted here too (see the
/// panic-targets sidecar below). Also untouched: arti's consensus cache (no
/// identity material), the webview's localStorage (in the desktop app that is the
/// UI locale — all real data goes through `kv_*` into protasius), and anything
/// already uploaded to Enigma Cloud (the local session token dies with the vault,
/// but nothing is deleted remotely). Files are unlinked, not shredded: without
/// `vault.json`'s wrapped DEK the remaining ciphertext is unopenable anyway.
fn panic_wipe(
    app: &AppHandle,
    cfg: &AppConfig,
    vault: &State<ProtasiusState>,
    sessions: &State<Sessions>,
    panic_pass: &str,
) -> Result<(), String> {
    if let Ok(mut s) = sessions.lock() {
        s.clear();
    }

    let base = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let tag = uuid::Uuid::new_v4().simple().to_string();

    let mut store = vault.0.lock().map_err(|e| e.to_string())?;

    // "Delete files on panic": read the sidecar the panic code seals (works while
    // locked — it re-derives the panic DEK from `panic_pass`) BEFORE swapping the
    // store away, then unlink each marked file that is still ENIGLOCK-locked. Filler
    // / knob-off yields no targets. Best-effort throughout — a failure to delete one
    // file must never abort the wipe of everything else.
    for path in store.read_panic_targets(panic_pass) {
        let p = std::path::Path::new(&path);
        if crate::local_lock::is_locked_path(p) {
            let _ = std::fs::remove_file(p);
        }
    }
    // Point the managed store at an empty scratch keyspace FIRST. That drops the
    // live `Protasius` (zeroizing the DEK and closing fjall's file handles), which
    // is what makes deleting the directory underneath it safe on every platform.
    // Nothing is ever written to the scratch store. Falls back inside app-data if
    // the system temp dir isn't writable (some Android configurations) — that path
    // is not one of the three we delete below, so it survives long enough to be
    // swapped out and removed at the end.
    let (scratch, scratch_store) = [
        std::env::temp_dir().join(format!("enigma-{tag}")),
        base.join(format!(".wipe-{tag}")),
    ]
    .into_iter()
    .find_map(|dir| open(dir.clone()).ok().map(|s| (dir, s)))
    .ok_or_else(|| "no writable scratch location".to_string())?;
    *store = scratch_store;

    // Everything Enigma owns: all profiles (protasius stores, vault.json headers,
    // maps/*.pmtiles, tor/ onion keystores) plus the pre-vault legacy plaintext.
    let _ = std::fs::remove_dir_all(base.join("profiles"));
    let _ = std::fs::remove_dir_all(base.join("kvstore"));
    let _ = std::fs::remove_file(base.join("iroh_gossip.key"));

    // A brand-new vault for the active profile, keyed by the panic code — so the
    // code the user just typed keeps working as their passphrase from here on (and
    // no panic code is armed on the fresh profile).
    *store = open(profile_dir(app, cfg))?;
    store
        .setup_with_kdf(panic_pass, crate::kdf_params(), &MigrationPlan::default())
        .map_err(e)?;

    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

/// Lock a LIVE session (Settings → "Lock now", and the idle auto-lock in
/// `src/idleLock.ts`). Every data op goes through the vault, so a transport left
/// running against a locked store would just error on each persist — tear the
/// whole session down first, in the same order as a profile switch. In
/// particular `p2p_tor::shutdown` seals the stable-onion keystore INTO the vault,
/// so it has to run while the DEK is still in memory.
///
/// The frontend reloads the webview afterwards, which is what actually drops the
/// decrypted values from JS memory; this side drops the DEK and the in-memory MLS
/// sessions.
// Every parameter past `passphrase` is Tauri-injected managed state, not a call
// site's burden — same shape as `app_set_active_profile`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn vault_lock(
    app: AppHandle,
    vault: State<'_, ProtasiusState>,
    sessions: State<'_, Sessions>,
    p2p: State<'_, crate::p2p_iroh::P2pState>,
    tor: State<'_, crate::p2p_tor::TorP2pState>,
    file: State<'_, crate::file_xfer::FileXferState>,
    vox: State<'_, crate::vox::VoxState>,
    devlink: State<'_, crate::device_link::DevLinkState>,
) -> Result<(), String> {
    crate::vox::shutdown(&app, &vox).await;
    crate::p2p_iroh::shutdown(&app, &p2p).await;
    crate::p2p_tor::shutdown(&app, &tor).await;
    crate::file_xfer::shutdown(&file).await;
    crate::device_link::shutdown(&devlink).await;
    crate::cloud::shutdown(&app).await;
    // Cached mmap readers point into the profile's maps dir — drop them so the
    // locked session holds no open handles into it.
    crate::maps::reset_readers(&app).await;

    if let Ok(mut s) = sessions.lock() {
        s.clear(); // in-memory MLS material
    }
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

/// Arm the panic code (Settings → Lock). `current` is the real passphrase; `code`
/// is what wipes this device when typed at the unlock screen.
#[tauri::command]
pub fn vault_set_panic_code(
    app: AppHandle,
    vault: State<ProtasiusState>,
    current: String,
    code: String,
) -> Result<(), String> {
    vault
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .set_panic_passphrase(&current, &code)
        .map_err(e)?;
    // A newly armed code stashes a fresh panic DEK; refresh the sidecar so the
    // delete-on-panic knob (if already on) seals the current locked-file list.
    resync_panic_targets(&app);
    Ok(())
}

/// Disarm the panic code; the old code becomes an ordinary wrong passphrase.
#[tauri::command]
pub fn vault_clear_panic_code(app: AppHandle, vault: State<ProtasiusState>, current: String) -> Result<(), String> {
    vault
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clear_panic_passphrase(&current)
        .map_err(e)?;
    resync_panic_targets(&app);
    Ok(())
}

/// Re-seal the panic-targets sidecar from the current knob + locked-files index.
/// Called whenever either changes (the `panic_targets_resync` command, invoked from
/// the frontend after an index edit or a knob toggle) and defensively after unlock.
///
/// All reads come from the encrypted store, so this only does anything while
/// unlocked; locked/absent ⇒ a no-op. Best-effort: the sidecar is a convenience for
/// the panic path, never a correctness dependency for normal operation.
fn resync_panic_targets(app: &AppHandle) {
    let enabled = kv_get_raw(app, "p2p:settings", "default", "delete_files_on_panic")
        .map(|v| v == "1" || v == "true" || v == "on")
        .unwrap_or(false);
    // The locked-files index is one JSON array of records; we only need each `path`.
    let paths: Vec<String> = kv_get_raw(app, "files:local", "default", "index")
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|rec| rec.get("path").and_then(|p| p.as_str()).map(str::to_string))
        .collect();
    if let Ok(st) = store(app) {
        if let Ok(p) = st.0.lock() {
            let _ = p.write_panic_targets(&paths, enabled);
        }
    }
}

/// Frontend hook (`resyncPanicTargets`): re-derive the panic-targets sidecar after
/// the locked-files index or the delete-on-panic knob changes.
#[tauri::command]
pub fn panic_targets_resync(app: AppHandle) -> Result<(), String> {
    resync_panic_targets(&app);
    Ok(())
}

/// Whether a panic code is armed (for the Settings card). Answered from *inside*
/// the encrypted store — `vault.json` looks identical either way.
#[tauri::command]
pub fn vault_has_panic_code(vault: State<ProtasiusState>) -> Result<bool, String> {
    vault
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .has_panic_passphrase()
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
