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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use protasius::{MigrationPlan, Protasius, ProtasiusError, UnlockOutcome, VaultStatus};
#[cfg(feature = "pin_unlock")]
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{active_config, profile_dir, AppConfig, AppConfigState, Sessions};

/// Managed state: the active profile's encrypted store.
pub struct ProtasiusState(pub Mutex<Protasius>);

// ── PIN unlock (convenience layer, MEMORY ONLY) ────────────────────────────────
// The PIN never protects data at rest. At enrolment we prove the user knows the
// passphrase, then seal a copy of it under a PIN-derived key and keep that blob
// in PROCESS MEMORY. An idle lock zeroizes the DEK as always but leaves the blob,
// so the PIN can re-open the session; a restart takes the blob with it and the
// passphrase is required again. Nothing PIN-derived ever reaches disk, so
// vault.json is unchanged and a 6-digit secret adds no offline attack surface.
//
// Caveat worth knowing (technology.md §7): someone who dumps the RAM of an
// idle-locked process could brute-force this blob. That is strictly weaker than
// scraping an UNLOCKED process, which is already total compromise.

#[cfg(feature = "pin_unlock")]
/// Wrong PINs tolerated before the blob is dropped and the passphrase is
/// required. Meaningful precisely because the state is in memory: an attacker
/// cannot copy it aside and retry, and the fallback costs the user one
/// passphrase entry rather than any data.
const PIN_MAX_FAILURES: u8 = 5;

#[cfg(feature = "pin_unlock")]
/// AAD ties the sealed passphrase to this use, so the blob is meaningless if it
/// ever turned up anywhere else.
const PIN_AAD: &[u8] = b"vesper/vault/pin/v1";

#[cfg(feature = "pin_unlock")]
struct PinBox {
    /// Envelope wrapping a random key under the PIN (gervasius vault header).
    header: gervasius::VaultHeader,
    /// The vault passphrase, sealed under that key.
    sealed: Vec<u8>,
    /// Panic code sealed under the PANIC pin, when one was enrolled.
    panic: Option<(gervasius::VaultHeader, Vec<u8>)>,
    digits: u8,
    failures: u8,
}

#[cfg(feature = "pin_unlock")]
/// The field is private on purpose: `PinBox` holds the sealed passphrase, so
/// every path that can reach it lives in this module (the `vault_pin_*`
/// commands and `pin_forget`). Elsewhere this is an opaque managed state.
#[derive(Default)]
pub struct PinState(Mutex<Option<PinBox>>);

#[cfg(feature = "pin_unlock")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinStatus {
    pub enrolled: bool,
    pub digits: u32,
    pub attempts_left: u32,
}

#[cfg(feature = "pin_unlock")]
/// Digits only, and exactly as many as the build's clamp allows.
fn valid_pin(pin: &str) -> Result<(), String> {
    use crate::build_config::settings as s;
    let len = pin.chars().count() as u64;
    if !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("a PIN must be digits only".to_string());
    }
    if !(s::PIN_DIGITS_MIN..=s::PIN_DIGITS_MAX).contains(&len) {
        return Err(format!(
            "a PIN must be {}..={} digits",
            s::PIN_DIGITS_MIN,
            s::PIN_DIGITS_MAX
        ));
    }
    Ok(())
}

#[cfg(feature = "pin_unlock")]
/// How many positions two equal-length PINs differ in. A single mistyped digit
/// must never land on the panic PIN — with six digits that is a realistic slip,
/// and the consequence is an irreversible wipe of every profile.
fn pin_distance(a: &str, b: &str) -> usize {
    if a.chars().count() != b.chars().count() {
        return usize::MAX;
    }
    a.chars().zip(b.chars()).filter(|(x, y)| x != y).count()
}

#[cfg(feature = "pin_unlock")]
/// Seal `secret` under `pin`, returning the envelope. Costs one Argon2id
/// derivation at the build's configured params — the same cost as an unlock.
fn seal_under_pin(pin: &str, secret: &str) -> Result<(gervasius::VaultHeader, Vec<u8>), String> {
    let (header, key) =
        gervasius::create_vault_with_params(pin, crate::kdf_params()).map_err(|e| e.to_string())?;
    let sealed = gervasius::seal(&key, PIN_AAD, secret.as_bytes()).map_err(|e| e.to_string())?;
    Ok((header, sealed))
}

#[cfg(feature = "pin_unlock")]
fn open_with_pin(header: &gervasius::VaultHeader, sealed: &[u8], pin: &str) -> Option<String> {
    let key = gervasius::unlock(header, pin).ok()?;
    let plain = gervasius::open(&key, PIN_AAD, sealed).ok()?;
    String::from_utf8(plain).ok()
}

/// Forget the PIN. Called on profile switch and after a panic wipe — anywhere
/// the sealed passphrase would no longer belong to the live profile.
///
/// A build without `pin_unlock` has no PIN to forget: the commands that enrol
/// one are not compiled, and neither is the state that would hold it.
pub fn pin_forget(app: &AppHandle) {
    #[cfg(feature = "pin_unlock")]
    if let Ok(mut guard) = app.state::<PinState>().0.lock() {
        *guard = None;
    }
    #[cfg(not(feature = "pin_unlock"))]
    let _ = app;
}

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
    Ok(())
}

// ── PIN commands ───────────────────────────────────────────────────────────────

/// Safe to call while locked — that is the whole point: the gate asks this to
/// decide whether to draw a keypad or the passphrase field.
#[cfg(feature = "pin_unlock")]
#[tauri::command]
pub fn vault_pin_status(pin: State<PinState>) -> Result<PinStatus, String> {
    let guard = pin.0.lock().map_err(|e| e.to_string())?;
    Ok(match guard.as_ref() {
        Some(b) => PinStatus {
            enrolled: true,
            digits: b.digits as u32,
            attempts_left: (PIN_MAX_FAILURES - b.failures) as u32,
        },
        None => PinStatus {
            enrolled: false,
            digits: crate::build_config::settings::PIN_DIGITS_DEFAULT as u32,
            attempts_left: PIN_MAX_FAILURES as u32,
        },
    })
}

/// Enrol a PIN for this session. Requires the real passphrase — the PIN seals a
/// copy of it, so proving knowledge first is what stops an attacker at an
/// already-unlocked machine from minting themselves a 6-digit key.
#[cfg(feature = "pin_unlock")]
#[tauri::command]
pub fn vault_pin_enroll(
    vault: State<ProtasiusState>,
    pin_state: State<PinState>,
    passphrase: String,
    pin: String,
    panic_pin: Option<String>,
    panic_code: Option<String>,
) -> Result<(), String> {
    valid_pin(&pin)?;
    if !vault.0.lock().map_err(|e| e.to_string())?.verify_passphrase(&passphrase).map_err(e)? {
        return Err(ProtasiusError::WrongPassphrase.to_string());
    }

    let panic = match (panic_pin.as_deref(), panic_code.as_deref()) {
        (Some(pp), Some(code)) => {
            valid_pin(pp)?;
            // A single mistyped digit must not trigger an irreversible wipe.
            if pin_distance(&pin, pp) < 2 {
                return Err("the panic PIN must differ from your PIN in at least two digits"
                    .to_string());
            }
            Some(seal_under_pin(pp, code)?)
        }
        _ => None,
    };

    let (header, sealed) = seal_under_pin(&pin, &passphrase)?;
    *pin_state.0.lock().map_err(|e| e.to_string())? = Some(PinBox {
        header,
        sealed,
        panic,
        digits: pin.chars().count() as u8,
        failures: 0,
    });
    Ok(())
}

/// Re-open the session with the PIN. Wrong PINs are counted; exhausting them
/// drops the blob so the gate falls back to the passphrase — no wipe, no
/// lockout, nothing lost but one passphrase entry.
///
/// Like `vault_unlock`, the panic path returns `Ok(())` indistinguishably.
#[cfg(feature = "pin_unlock")]
#[tauri::command]
pub fn vault_pin_unlock(
    app: AppHandle,
    config: State<AppConfigState>,
    vault: State<ProtasiusState>,
    sessions: State<Sessions>,
    pin_state: State<PinState>,
    pin: String,
) -> Result<(), String> {
    let cfg = active_config(&config)?;

    // Pull the secret out under the lock, then release it before unlocking.
    let secret = {
        let mut guard = pin_state.0.lock().map_err(|e| e.to_string())?;
        let Some(b) = guard.as_mut() else {
            return Err(ProtasiusError::WrongPassphrase.to_string());
        };
        let found = open_with_pin(&b.header, &b.sealed, &pin).or_else(|| {
            b.panic.as_ref().and_then(|(h, s)| open_with_pin(h, s, &pin))
        });
        match found {
            Some(secret) => {
                b.failures = 0;
                secret
            }
            None => {
                b.failures += 1;
                if b.failures >= PIN_MAX_FAILURES {
                    *guard = None; // fall back to the passphrase
                }
                // Same error whether the PIN was wrong or the blob just expired.
                return Err(ProtasiusError::WrongPassphrase.to_string());
            }
        }
    };

    // The recovered secret is the passphrase (or the panic code) — hand it to
    // the ordinary path so the panic branch behaves exactly as it always does.
    let outcome = {
        let mut p = vault.0.lock().map_err(|e| e.to_string())?;
        p.unlock(&secret).map_err(e)?
    };
    if outcome == UnlockOutcome::Panic {
        return panic_wipe(&app, &cfg, &vault, &sessions, &secret);
    }
    crate::migrate_mls(&app, &cfg);
    Ok(())
}

/// Forget the PIN; the passphrase is required from now on.
#[cfg(feature = "pin_unlock")]
#[tauri::command]
pub fn vault_pin_clear(app: AppHandle) -> Result<(), String> {
    pin_forget(&app);
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
/// What survives, deliberately: arti's consensus cache (no
/// identity material), the webview's localStorage (in the desktop app that is the
/// UI locale — all real data goes through `kv_*` into protasius). Files are
/// unlinked, not shredded: without `vault.json`'s wrapped DEK the remaining
/// ciphertext is unopenable anyway.
fn panic_wipe(
    app: &AppHandle,
    cfg: &AppConfig,
    vault: &State<ProtasiusState>,
    sessions: &State<Sessions>,
    panic_pass: &str,
) -> Result<(), String> {
    // Whatever opened this session must not survive it.
    pin_forget(app);
    if let Ok(mut s) = sessions.lock() {
        s.clear();
    }

    let base = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let tag = uuid::Uuid::new_v4().simple().to_string();

    let mut store = vault.0.lock().map_err(|e| e.to_string())?;

    // Point the managed store at an empty scratch keyspace FIRST. That drops the
    // live `Protasius` (zeroizing the DEK and closing fjall's file handles), which
    // is what makes deleting the directory underneath it safe on every platform.
    // Nothing is ever written to the scratch store. Falls back inside app-data if
    // the system temp dir isn't writable (some Android configurations) — that path
    // is not one of the three we delete below, so it survives long enough to be
    // swapped out and removed at the end.
    let (scratch, scratch_store) = [
        std::env::temp_dir().join(format!("vesper-{tag}")),
        base.join(format!(".wipe-{tag}")),
    ]
    .into_iter()
    .find_map(|dir| open(dir.clone()).ok().map(|s| (dir, s)))
    .ok_or_else(|| "no writable scratch location".to_string())?;
    *store = scratch_store;

    // Everything Vesper owns: all profiles (protasius stores, vault.json headers,
    // tor/ onion keystores, and the maps/ folder a build with the old Map tab
    // left behind) plus the pre-vault legacy plaintext.
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

/// Lock a LIVE session (Settings → "Lock now", the idle auto-lock in
/// `src/idleLock.ts`, and the Rust-side `lock_watchdog` below). Every data op
/// goes through the vault, so a transport left running against a locked store
/// would just error on each persist — tear the whole session down first, in the
/// same order as a profile switch. In particular `p2p_tor::shutdown` seals the
/// stable-onion keystore INTO the vault, so it has to run while the DEK is still
/// in memory.
///
/// The frontend reloads the webview afterwards, which is what actually drops the
/// decrypted values from JS memory; this side drops the DEK and the in-memory MLS
/// sessions. Every shutdown helper is `Option::take`-based, so a concurrent
/// second lock (JS and watchdog racing after a suspend wake) is harmless.
pub async fn lock_inner(app: &AppHandle) -> Result<(), String> {
    let tor = app.state::<crate::p2p_tor::TorP2pState>();
    crate::p2p_tor::shutdown(app, &tor).await;
    crate::pharos::stop(app).await;

    if let Ok(mut s) = app.state::<Sessions>().lock() {
        s.clear(); // in-memory MLS material
    }
    store(app)?.0.lock().map_err(|e| e.to_string())?.lock();
    Ok(())
}

#[tauri::command]
pub async fn vault_lock(app: AppHandle) -> Result<(), String> {
    lock_inner(&app).await
}

// ── Rust-side lock watchdog ─────────────────────────────────────────────────────
// Defense in depth behind `src/idleLock.ts`: the JS watcher is the normal path
// (clean lock + webview reload), but it lives in the webview — killed, frozen, or
// backgrounded (Android) it never fires, and the DEK would stay live forever.
// The watchdog re-locks from Rust when the heartbeat goes quiet.

/// Managed state: wall-clock millis (UNIX epoch) of the last sign of webview
/// life — user activity or a busy-hold — fed by the `vault_touch` heartbeat.
/// Starts at "now", not zero: an unlock inside the watchdog's first tick must
/// see a fresh baseline, not an instantly-expired one.
pub struct ActivityState(pub AtomicU64);

impl Default for ActivityState {
    fn default() -> Self {
        Self(AtomicU64::new(now_ms()))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Throttled heartbeat from the JS idle watcher: fired on user activity and while
/// a call/transfer holds its countdown, so Rust's deadline trails JS's.
#[tauri::command]
pub fn vault_touch(activity: State<ActivityState>) {
    activity.0.store(now_ms(), Ordering::Relaxed);
}

/// The auto-lock setting, read fresh at use like every Settings value
/// (technology.md §15) — a Settings edit reaches the watchdog within one tick.
fn idle_lock_mins(app: &AppHandle) -> u64 {
    use crate::build_config::settings as s;
    kv_get_raw(app, "p2p:settings", "default", "idle_lock_mins")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(s::IDLE_LOCK_MIN_MINS, s::IDLE_LOCK_MAX_MINS))
        .unwrap_or(s::IDLE_LOCK_DEFAULT_MINS)
}

/// How far the Rust deadline trails the JS one: the 30 s heartbeat throttle can
/// swallow that much trailing activity, the JS tick lags up to 10 s, and the
/// webview needs the head start to win with its clean lock + reload.
const WATCHDOG_MARGIN_SECS: u64 = 90;
const WATCHDOG_TICK_SECS: u64 = 10;

/// Due when `last` sits at least `mins*60s + margin` behind `now`. Saturating:
/// a backwards clock jump restarts the countdown, never fires it.
fn watchdog_due(now_ms: u64, last_ms: u64, mins: u64) -> bool {
    now_ms.saturating_sub(last_ms) >= mins * 60_000 + WATCHDOG_MARGIN_SECS * 1_000
}

/// Spawned once at setup and never cancelled. While the vault is locked or
/// auto-lock is off it just refreshes the baseline ("parks") — which is the whole
/// lifecycle story: JS lock, watchdog lock, profile switch, panic wipe, and
/// re-unlock all reduce to the tick seeing the right state. Wall-clock comparison
/// per tick mirrors the JS watcher: a machine suspended past its deadline locks
/// on the first tick after wake.
pub async fn lock_watchdog(app: AppHandle) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(WATCHDOG_TICK_SECS)).await;
        let activity = app.state::<ActivityState>();
        let unlocked = app
            .try_state::<ProtasiusState>()
            .and_then(|st| st.0.lock().ok().map(|p| p.status().unlocked))
            .unwrap_or(false);
        if !unlocked || idle_lock_mins(&app) == 0 {
            activity.0.store(now_ms(), Ordering::Relaxed);
            continue;
        }
        if !watchdog_due(now_ms(), activity.0.load(Ordering::Relaxed), idle_lock_mins(&app)) {
            continue;
        }
        let _ = lock_inner(&app).await;
        // A live webview reloads onto the gate; a dead one has nobody listening.
        let _ = app.emit("vault://locked", serde_json::json!({}));
        // The next tick sees a locked vault and parks — at most one fire per unlock.
    }
}

#[cfg(test)]
mod watchdog_tests {
    use super::{watchdog_due, WATCHDOG_MARGIN_SECS};

    #[test]
    fn due_only_past_deadline_plus_margin() {
        let mins = 15u64;
        let deadline = mins * 60_000 + WATCHDOG_MARGIN_SECS * 1_000;
        assert!(!watchdog_due(deadline - 1, 0, mins));
        assert!(watchdog_due(deadline, 0, mins));
    }

    #[test]
    fn backwards_clock_jump_never_fires() {
        // `last` stamped "in the future" (clock set back) — countdown restarts.
        assert!(!watchdog_due(1_000, 5_000_000, 15));
    }
}

#[tauri::command]
pub fn vault_change_passphrase(
    app: AppHandle,
    vault: State<ProtasiusState>,
    current: String,
    new: String,
) -> Result<(), String> {
    vault
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .change_passphrase(&current, &new)
        .map_err(e)?;
    // Privacy HP credit, awarded only after the change actually succeeded.
    // Lengths only — whether it got longer is the entire question, and the
    // passphrases themselves go no further than the line above.
    crate::privacy_hp::award_passphrase_change(&app, current.chars().count(), new.chars().count());
    Ok(())
}

/// Arm the panic code (Settings → Lock). `current` is the real passphrase; `code`
/// is what wipes this device when typed at the unlock screen.
#[tauri::command]
pub fn vault_set_panic_code(
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
    Ok(())
}

/// Disarm the panic code; the old code becomes an ordinary wrong passphrase.
#[tauri::command]
pub fn vault_clear_panic_code(vault: State<ProtasiusState>, current: String) -> Result<(), String> {
    vault
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clear_panic_passphrase(&current)
        .map_err(e)?;
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
    app: AppHandle,
    vault: State<ProtasiusState>,
    sessions: State<Sessions>,
) -> Result<(), String> {
    vault.0.lock().map_err(|e| e.to_string())?.wipe().map_err(e)?;
    if let Ok(mut s) = sessions.lock() {
        s.clear();
    }
    // The sealed passphrase would outlive the vault it opens.
    pin_forget(&app);
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

#[cfg(test)]
mod pin_tests {
    // Every test here is about the PIN; without the feature the module is empty.
    #[cfg_attr(not(feature = "pin_unlock"), allow(unused_imports))]
    use super::*;

    // The PIN layer is deliberately pure crypto over in-memory state, so it is
    // testable without a Tauri AppHandle. What these pin down is the security
    // contract: a PIN opens only with the right digits, a wrong one is counted,
    // exhausting the count drops the secret entirely, and a panic PIN cannot sit
    // one keystroke away from the real one.

    #[cfg(feature = "pin_unlock")]
    #[test]
    fn a_sealed_secret_opens_only_with_its_pin() {
        let (header, sealed) = seal_under_pin("481920", "correct horse battery").unwrap();
        assert_eq!(
            open_with_pin(&header, &sealed, "481920").as_deref(),
            Some("correct horse battery"),
        );
        for wrong in ["481921", "481930", "000000", "48192", "4819200"] {
            assert!(open_with_pin(&header, &sealed, wrong).is_none(), "{wrong} must not open");
        }
    }

    #[cfg(feature = "pin_unlock")]
    #[test]
    fn the_sealed_blob_does_not_contain_the_secret() {
        let (_h, sealed) = seal_under_pin("123456", "my passphrase").unwrap();
        assert!(
            !sealed.windows(13).any(|w| w == b"my passphrase"),
            "the passphrase must not appear in the ciphertext",
        );
    }

    #[cfg(feature = "pin_unlock")]
    #[test]
    fn pin_validation_enforces_digits_and_the_build_clamp() {
        use crate::build_config::settings as s;
        let ok = "0".repeat(s::PIN_DIGITS_DEFAULT as usize);
        assert!(valid_pin(&ok).is_ok());

        assert!(valid_pin("12a456").is_err(), "letters rejected");
        assert!(valid_pin("12 456").is_err(), "spaces rejected");
        assert!(valid_pin("").is_err());
        assert!(valid_pin(&"0".repeat(s::PIN_DIGITS_MIN as usize - 1)).is_err());
        assert!(valid_pin(&"0".repeat(s::PIN_DIGITS_MAX as usize + 1)).is_err());
        // The clamp bounds themselves are legal.
        assert!(valid_pin(&"0".repeat(s::PIN_DIGITS_MIN as usize)).is_ok());
        assert!(valid_pin(&"0".repeat(s::PIN_DIGITS_MAX as usize)).is_ok());
    }

    #[cfg(feature = "pin_unlock")]
    #[test]
    fn panic_pin_must_differ_in_two_digits() {
        // The accident this rule exists to prevent: one slipped keystroke
        // wiping every profile on the device.
        assert_eq!(pin_distance("481920", "481921"), 1);
        assert_eq!(pin_distance("481920", "481920"), 0);
        assert_eq!(pin_distance("481920", "481931"), 2);
        assert_eq!(pin_distance("481920", "999999"), 5); // the 9s line up
        assert_eq!(pin_distance("111111", "222222"), 6);
        // Different lengths are never "close".
        assert_eq!(pin_distance("481920", "48192"), usize::MAX);
    }

    #[cfg(feature = "pin_unlock")]
    #[test]
    fn failures_accumulate_and_then_drop_the_secret() {
        // Mirrors what vault_pin_unlock does to the box, without needing an app.
        let (header, sealed) = seal_under_pin("111111", "pass").unwrap();
        let mut b = PinBox { header, sealed, panic: None, digits: 6, failures: 0 };

        for expected in 1..PIN_MAX_FAILURES {
            assert!(open_with_pin(&b.header, &b.sealed, "222222").is_none());
            b.failures += 1;
            assert_eq!(b.failures, expected);
            // Still enrolled, and the right PIN still works and clears the count.
            assert!(open_with_pin(&b.header, &b.sealed, "111111").is_some());
        }
        b.failures = PIN_MAX_FAILURES;
        assert!(b.failures >= PIN_MAX_FAILURES, "the caller drops the box at this point");
    }

    #[cfg(feature = "pin_unlock")]
    #[test]
    fn a_panic_pin_opens_the_panic_secret_not_the_real_one() {
        let real = seal_under_pin("481920", "real-passphrase").unwrap();
        let panic = seal_under_pin("735514", "panic-code").unwrap();
        // Each opens only its own secret — the unlock path tries real first,
        // then panic, and hands whichever it got to the ordinary vault unlock.
        assert_eq!(open_with_pin(&real.0, &real.1, "481920").as_deref(), Some("real-passphrase"));
        assert!(open_with_pin(&real.0, &real.1, "735514").is_none());
        assert_eq!(open_with_pin(&panic.0, &panic.1, "735514").as_deref(), Some("panic-code"));
        assert!(open_with_pin(&panic.0, &panic.1, "481920").is_none());
    }

    #[cfg(feature = "pin_unlock")]
    #[test]
    fn every_enrolment_uses_a_fresh_envelope() {
        // Two enrolments of the SAME pin+secret must not produce equal bytes,
        // or a blob would be replayable across sessions.
        let a = seal_under_pin("481920", "same").unwrap();
        let b = seal_under_pin("481920", "same").unwrap();
        assert_ne!(a.1, b.1);
        assert!(open_with_pin(&b.0, &b.1, "481920").is_some());
        // …and one envelope's key does not open the other's ciphertext.
        assert!(open_with_pin(&a.0, &b.1, "481920").is_none());
    }
}
