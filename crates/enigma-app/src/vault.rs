//! The profile vault: protasius (fjall + gervasius) per profile, the same layout as the
//! Tauri app (`apps/enigma/src-tauri/src/vault.rs`), so a Tauri profile opens here as is.
//!
//! On disk: `<base>/profiles/<profile>/vault.json` (the two key slots: passphrase and
//! panic-or-filler) and `<base>/profiles/<profile>/protasius/` (sealed values). `<base>`
//! defaults to the Tauri app's data dir (`com.spectrumaipl.enigma27`, see [`default_base`]).
//!
//! What lives where (identical to the Tauri app unless noted):
//! - internal `keys/device_ed25519`: the device key (32-byte Ed25519 seed, `device.rs`);
//! - internal `mls/<room>\0<identity>`: MLS sessions (`VaultMls`);
//! - internal `profile/state`: the Tauri profile JSON (nickname = `offline_profile.display_name`);
//! - kv `p2p:rooms`/`default`/``: saved rooms (the engine's `Kv`, `ns`/`key` → `ns`/`key`/``);
//! - kv `chat:log`, `chat:admitted`, `chat:mailbox`: the engine's timeline, admitted flags,
//!   mailbox place (Slint layout: one JSON per room; the Tauri app kept segmented logs
//!   under `chat:log`/<slug>/`seg-N`, which are not read here);
//! - kv `friends`/`default`/`list`: friends (`stores/friends.ts`, same JSON);
//! - kv `beacon`/`default`/`mine`: Your Beacon (`stores/beacon.ts`, same JSON `{onion, name}`);
//! - kv `p2p:settings`/`default`/*: settings (`idle_lock_mins` as in Tauri; the Slint app
//!   adds `lock_on_hide`, `lang`, `theme`, ...);
//! - internal `keys/beacon_node`, `keys/beacon_queue`: the in-process Beacon's node seed and
//!   queue key (new; the Tauri app had no Beacon).
//!
//! The PIN is memory only (as in Tauri): the passphrase sealed under a PIN-derived key,
//! dropped after [`PIN_MAX_FAILURES`] wrong PINs, on profile switch and on restart.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use protasius::{KdfParams, MigrationPlan, Protasius, ProtasiusError, UnlockOutcome};
use rand_core::{OsRng, RngCore};

/// Wrong PINs before the PIN is forgotten.
pub const PIN_MAX_FAILURES: u8 = 5;
/// PIN length bounds (Tauri build_config `pin_digits`).
pub const PIN_DIGITS: (usize, usize) = (4, 12);
const PIN_AAD: &[u8] = b"enigma/vault/pin/v1";

/// The Tauri app's identifier: its data dir is where profiles are found.
pub const APP_ID: &str = "com.spectrumaipl.enigma27";

/// Where profiles live: `$ENIGMA_DATA_DIR`, else the Tauri app's data dir for this OS.
#[must_use]
pub fn default_base() -> PathBuf {
    if let Some(d) = std::env::var_os("ENIGMA_DATA_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "windows") {
        if let Some(a) = std::env::var_os("APPDATA") {
            return PathBuf::from(a).join(APP_ID);
        }
    }
    if cfg!(target_os = "macos") {
        return home.join("Library/Application Support").join(APP_ID);
    }
    std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join(APP_ID)
}

/// A profile name made safe for a folder (Tauri's `safe_filename_component`).
#[must_use]
pub fn safe_name(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// The profiles on this device (folders under `<base>/profiles`) and the active one
/// (`<base>/enigma-slint.json`, plaintext: names only).
#[derive(Clone, Debug)]
pub struct Profiles {
    /// The data dir.
    pub base: PathBuf,
}

impl Profiles {
    /// At `base`.
    #[must_use]
    pub fn new(base: PathBuf) -> Self {
        Self { base }
    }
    /// Folder of a profile.
    #[must_use]
    pub fn dir(&self, name: &str) -> PathBuf {
        self.base.join("profiles").join(safe_name(name))
    }
    /// Every profile folder (sorted); "default" when there is none.
    #[must_use]
    pub fn list(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.base.join("profiles"))
            .map(|r| r.filter_map(Result::ok).filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        v.sort();
        if v.is_empty() {
            v.push("default".into());
        }
        v
    }
    /// The active profile.
    #[must_use]
    pub fn active(&self) -> String {
        std::fs::read_to_string(self.base.join("enigma-slint.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v["active"].as_str().map(str::to_string))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.list().into_iter().next().unwrap_or_else(|| "default".into()))
    }
    /// Make `name` active (creates its folder).
    ///
    /// # Errors
    /// IO.
    pub fn set_active(&self, name: &str) -> Result<(), String> {
        let n = safe_name(name.trim());
        if n.is_empty() {
            return Err("a profile needs a name".into());
        }
        std::fs::create_dir_all(self.dir(&n)).map_err(|e| e.to_string())?;
        std::fs::write(self.base.join("enigma-slint.json"), serde_json::json!({ "active": n }).to_string()).map_err(|e| e.to_string())
    }
}

/// PIN state for the lock screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PinStatus {
    /// A PIN is enrolled (this run).
    pub enrolled: bool,
    /// Its length.
    pub digits: usize,
    /// Tries left.
    pub attempts_left: u8,
}

struct PinBox {
    header: gervasius::VaultHeader,
    sealed: Vec<u8>,
    panic: Option<(gervasius::VaultHeader, Vec<u8>)>,
    digits: usize,
    failures: u8,
}

/// What an unlock did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opened {
    /// The real passphrase.
    Unlocked,
    /// The panic code: every profile was wiped and a fresh vault keyed by the code opened.
    /// The UI must not show anything different from [`Opened::Unlocked`].
    Wiped,
}

fn e(err: ProtasiusError) -> String {
    err.to_string()
}

/// One profile's vault (cheap to clone; the store is shared with the engine's Kv/Store).
#[derive(Clone)]
pub struct Vault {
    store: Arc<Mutex<Protasius>>,
    pin: Arc<Mutex<Option<PinBox>>>,
    profiles: Profiles,
    profile: String,
    kdf: KdfParams,
}

impl Vault {
    /// Opens `profile` under `profiles` (locked). `kdf`: costs for a NEW vault.
    ///
    /// # Errors
    /// The store's.
    pub fn open(profiles: &Profiles, profile: &str, kdf: KdfParams) -> Result<Self, String> {
        let dir = profiles.dir(profile);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let p = Protasius::open(dir).map_err(e)?;
        Ok(Self { store: Arc::new(Mutex::new(p)), pin: Arc::new(Mutex::new(None)), profiles: profiles.clone(), profile: safe_name(profile), kdf })
    }

    fn lock_store(&self) -> MutexGuard<'_, Protasius> {
        self.store.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn lock_pin(&self) -> MutexGuard<'_, Option<PinBox>> {
        self.pin.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// This profile's name.
    #[must_use]
    pub fn profile(&self) -> &str {
        &self.profile
    }
    /// This profile's folder.
    #[must_use]
    pub fn dir(&self) -> PathBuf {
        self.profiles.dir(&self.profile)
    }
    /// A vault exists (vault.json).
    #[must_use]
    pub fn exists(&self) -> bool {
        self.lock_store().status().exists
    }
    /// Unlocked now.
    #[must_use]
    pub fn is_unlocked(&self) -> bool {
        self.lock_store().status().unlocked
    }

    /// First run: create the vault with `passphrase` (unlocked afterwards).
    ///
    /// # Errors
    /// Empty passphrase, or the store's.
    pub fn create(&self, passphrase: &str) -> Result<(), String> {
        if passphrase.chars().count() < 1 {
            return Err("empty passphrase".into());
        }
        let plan = MigrationPlan { profile_state_json: Some(self.dir().join("profile_state.json")), ..MigrationPlan::default() };
        self.lock_store().setup_with_kdf(passphrase, self.kdf.clone(), &plan).map_err(e)
    }

    /// Unlock; the panic code wipes every profile and opens a fresh vault keyed by it.
    ///
    /// # Errors
    /// "wrong passphrase" and the store's.
    pub fn unlock(&self, passphrase: &str) -> Result<Opened, String> {
        let out = self.lock_store().unlock(passphrase).map_err(e)?;
        match out {
            UnlockOutcome::Unlocked => Ok(Opened::Unlocked),
            UnlockOutcome::Panic => {
                self.panic_wipe(passphrase)?;
                Ok(Opened::Wiped)
            }
        }
    }

    /// Duress: erase every profile on this device, then a fresh vault for this profile
    /// keyed by the panic code (so it keeps working as the passphrase).
    fn panic_wipe(&self, code: &str) -> Result<(), String> {
        *self.lock_pin() = None;
        let mut st = self.lock_store();
        let _ = st.wipe();
        // Swap the live store for a scratch one so its files close before we delete them.
        let scratch = std::env::temp_dir().join(format!("enigma-wipe-{}", rand_hex(8)));
        *st = Protasius::open(scratch.clone()).map_err(e)?;
        let _ = std::fs::remove_dir_all(self.profiles.base.join("profiles"));
        let dir = self.dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        *st = Protasius::open(dir).map_err(e)?;
        st.setup_with_kdf(code, self.kdf.clone(), &MigrationPlan::default()).map_err(e)?;
        let _ = std::fs::remove_dir_all(scratch);
        Ok(())
    }

    /// Lock (the PIN, if enrolled, stays for a quick re-unlock).
    pub fn lock(&self) {
        self.lock_store().lock();
    }

    /// Change the passphrase (the PIN is forgotten: it sealed the old one).
    ///
    /// # Errors
    /// Wrong current passphrase, empty new one.
    pub fn change_passphrase(&self, current: &str, new: &str) -> Result<(), String> {
        if new.is_empty() {
            return Err("empty passphrase".into());
        }
        self.lock_store().change_passphrase(current, new).map_err(e)?;
        *self.lock_pin() = None;
        Ok(())
    }

    /// Arm the panic code.
    ///
    /// # Errors
    /// Wrong passphrase, or the code equals it.
    pub fn set_panic_code(&self, current: &str, code: &str) -> Result<(), String> {
        if code.is_empty() {
            return Err("empty panic code".into());
        }
        self.lock_store().set_panic_passphrase(current, code).map_err(e)
    }
    /// Disarm the panic code.
    ///
    /// # Errors
    /// Wrong passphrase.
    pub fn clear_panic_code(&self, current: &str) -> Result<(), String> {
        self.lock_store().clear_panic_passphrase(current).map_err(e)
    }
    /// Whether one is armed (unlocked only).
    #[must_use]
    pub fn has_panic_code(&self) -> bool {
        self.lock_store().has_panic_passphrase().unwrap_or(false)
    }

    /// Erase this profile (danger zone): back to "create a passphrase".
    ///
    /// # Errors
    /// The store's.
    pub fn erase(&self) -> Result<(), String> {
        *self.lock_pin() = None;
        self.lock_store().wipe().map_err(e)
    }

    // ── PIN ────────────────────────────────────────────────────────────────────

    /// PIN state (callable while locked).
    #[must_use]
    pub fn pin_status(&self) -> PinStatus {
        match self.lock_pin().as_ref() {
            Some(b) => PinStatus { enrolled: true, digits: b.digits, attempts_left: PIN_MAX_FAILURES - b.failures },
            None => PinStatus { enrolled: false, digits: 6, attempts_left: PIN_MAX_FAILURES },
        }
    }

    /// Enrol a PIN (proves the passphrase first). Optional panic PIN + panic code: that
    /// PIN unlocks with the panic code (wipe); it must differ from the PIN in 2+ digits.
    ///
    /// # Errors
    /// A bad PIN, a wrong passphrase, a panic PIN too close.
    pub fn pin_enroll(&self, passphrase: &str, pin: &str, panic: Option<(&str, &str)>) -> Result<(), String> {
        valid_pin(pin)?;
        if !self.lock_store().verify_passphrase(passphrase).map_err(e)? {
            return Err(ProtasiusError::WrongPassphrase.to_string());
        }
        let panic = match panic {
            Some((pp, code)) => {
                valid_pin(pp)?;
                if pin_distance(pin, pp) < 2 {
                    return Err("the panic PIN must differ from your PIN in at least two digits".into());
                }
                Some(seal_under_pin(pp, code, &self.kdf)?)
            }
            None => None,
        };
        let (header, sealed) = seal_under_pin(pin, passphrase, &self.kdf)?;
        *self.lock_pin() = Some(PinBox { header, sealed, panic, digits: pin.chars().count(), failures: 0 });
        Ok(())
    }

    /// Unlock with the PIN. Wrong PINs count; at [`PIN_MAX_FAILURES`] the PIN is dropped.
    ///
    /// # Errors
    /// "wrong passphrase" (also when no PIN is enrolled).
    pub fn pin_unlock(&self, pin: &str) -> Result<Opened, String> {
        let secret = {
            let mut g = self.lock_pin();
            let Some(b) = g.as_mut() else { return Err(ProtasiusError::WrongPassphrase.to_string()) };
            let found = open_with_pin(&b.header, &b.sealed, pin).or_else(|| b.panic.as_ref().and_then(|(h, s)| open_with_pin(h, s, pin)));
            match found {
                Some(s) => {
                    b.failures = 0;
                    s
                }
                None => {
                    b.failures += 1;
                    if b.failures >= PIN_MAX_FAILURES {
                        *g = None;
                    }
                    return Err(ProtasiusError::WrongPassphrase.to_string());
                }
            }
        };
        self.unlock(&secret)
    }

    /// Forget the PIN.
    pub fn pin_clear(&self) {
        *self.lock_pin() = None;
    }

    // ── data ───────────────────────────────────────────────────────────────────

    /// Internal value.
    #[must_use]
    pub fn get(&self, ns: &str, key: &str) -> Option<Vec<u8>> {
        self.lock_store().get(ns, key).ok().flatten()
    }
    /// Internal value.
    ///
    /// # Errors
    /// Locked.
    pub fn put(&self, ns: &str, key: &str, v: &[u8]) -> Result<(), String> {
        self.lock_store().put(ns, key, v).map_err(e)
    }
    /// Internal value.
    pub fn delete(&self, ns: &str, key: &str) {
        let _ = self.lock_store().delete(ns, key);
    }
    /// kv (`ns`, `scope`, `k`).
    #[must_use]
    pub fn kv_get(&self, ns: &str, scope: &str, k: &str) -> Option<String> {
        self.lock_store().kv_get(ns, scope, k).ok().flatten()
    }
    /// kv.
    pub fn kv_put(&self, ns: &str, scope: &str, k: &str, v: &str) {
        let _ = self.lock_store().kv_put(ns, scope, k, v);
    }
    /// kv.
    pub fn kv_delete(&self, ns: &str, scope: &str, k: &str) {
        let _ = self.lock_store().kv_delete(ns, scope, k);
    }
    /// A setting (`p2p:settings`/`default`/`k`).
    #[must_use]
    pub fn setting(&self, k: &str) -> Option<String> {
        self.kv_get("p2p:settings", "default", k).filter(|s| !s.is_empty())
    }
    /// Save a setting.
    pub fn set_setting(&self, k: &str, v: &str) {
        self.kv_put("p2p:settings", "default", k, v);
    }

    /// A 32-byte secret kept at internal `keys/<name>`, made on first use.
    ///
    /// # Errors
    /// Locked.
    pub fn secret32(&self, name: &str) -> Result<[u8; 32], String> {
        if let Some(b) = self.get("keys", name) {
            if let Ok(s) = <[u8; 32]>::try_from(b.as_slice()) {
                return Ok(s);
            }
        }
        let mut s = [0u8; 32];
        OsRng.fill_bytes(&mut s);
        self.put("keys", name, &s)?;
        Ok(s)
    }

    /// The device key's seed (`keys/device_ed25519`, as `device.rs`).
    ///
    /// # Errors
    /// Locked.
    pub fn device_seed(&self) -> Result<[u8; 32], String> {
        self.secret32("device_ed25519")
    }

    /// The Tauri profile's nickname, if this profile came from there.
    #[must_use]
    pub fn tauri_nickname(&self) -> Option<String> {
        let b = self.get("profile", "state")?;
        let v: serde_json::Value = serde_json::from_slice(&b).ok()?;
        v["offline_profile"]["display_name"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    }

    /// The engine's `Kv` on this vault.
    #[must_use]
    pub fn engine_kv(&self) -> VaultKv {
        VaultKv(self.clone())
    }
    /// The engine's MLS store on this vault.
    #[must_use]
    pub fn mls_store(&self) -> VaultMls {
        VaultMls(self.clone())
    }
}

/// `enigma_core::Kv` on the vault: (`ns`, `key`) → kv (`ns`, `key`, ``), so the room list
/// (`p2p:rooms`, `default`) is exactly where the Tauri app kept it.
pub struct VaultKv(Vault);

impl enigma_core::Kv for VaultKv {
    fn get(&self, ns: &str, key: &str) -> Option<String> {
        self.0.kv_get(ns, key, "")
    }
    fn put(&self, ns: &str, key: &str, value: &str) {
        self.0.kv_put(ns, key, "", value);
    }
    fn delete(&self, ns: &str, key: &str) {
        self.0.kv_delete(ns, key, "");
    }
}

/// MLS sessions in the vault's `mls` namespace (`room\0identity`, as `VaultMls` in Tauri).
pub struct VaultMls(Vault);

impl enigmatite::mls::Store for VaultMls {
    fn get(&self, room: &str, identity: &str) -> Option<Vec<u8>> {
        self.0.get("mls", &format!("{room}\0{identity}"))
    }
    fn put(&self, room: &str, identity: &str, state: &[u8]) {
        let _ = self.0.put("mls", &format!("{room}\0{identity}"), state);
    }
    fn delete(&self, room: &str, identity: &str) {
        self.0.delete("mls", &format!("{room}\0{identity}"));
    }
}

fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Digits only, 4..=12.
///
/// # Errors
/// What is wrong.
pub fn valid_pin(pin: &str) -> Result<(), String> {
    let n = pin.chars().count();
    if !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("a PIN must be digits only".into());
    }
    if !(PIN_DIGITS.0..=PIN_DIGITS.1).contains(&n) {
        return Err(format!("a PIN must be {}..={} digits", PIN_DIGITS.0, PIN_DIGITS.1));
    }
    Ok(())
}

/// Positions in which two equal-length PINs differ (`usize::MAX` for other lengths).
#[must_use]
pub fn pin_distance(a: &str, b: &str) -> usize {
    if a.chars().count() != b.chars().count() {
        return usize::MAX;
    }
    a.chars().zip(b.chars()).filter(|(x, y)| x != y).count()
}

fn seal_under_pin(pin: &str, secret: &str, kdf: &KdfParams) -> Result<(gervasius::VaultHeader, Vec<u8>), String> {
    let (header, key) = gervasius::create_vault_with_params(pin, kdf.clone()).map_err(|e| e.to_string())?;
    let sealed = gervasius::seal(&key, PIN_AAD, secret.as_bytes()).map_err(|e| e.to_string())?;
    Ok((header, sealed))
}

fn open_with_pin(header: &gervasius::VaultHeader, sealed: &[u8], pin: &str) -> Option<String> {
    let key = gervasius::unlock(header, pin).ok()?;
    String::from_utf8(gervasius::open(&key, PIN_AAD, sealed).ok()?).ok()
}

/// Cheap Argon2 costs for tests.
#[must_use]
pub fn test_kdf() -> KdfParams {
    KdfParams { m_cost_kib: 64, t_cost: 1, p_cost: 1, out_len: 32 }
}

/// Is `p` an existing vault folder (has vault.json)?
#[must_use]
pub fn has_vault(p: &Path) -> bool {
    p.join("vault.json").exists()
}

// ── idle lock ───────────────────────────────────────────────────────────────

/// Where the idle countdown is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Idle {
    /// Nothing to show.
    Active,
    /// Warn: locks in this many seconds.
    Warn(u64),
    /// Lock now.
    Lock,
}

/// The idle auto-lock (`idleLock.ts`): `mins` of no activity locks; the last
/// min(30 s, a third of the timeout) warn. 0 minutes = off.
#[derive(Clone, Copy, Debug)]
pub struct IdleLock {
    /// Minutes (0 = never).
    pub mins: u64,
    last_ms: u64,
}

impl IdleLock {
    /// Starting now.
    #[must_use]
    pub fn new(mins: u64, now_ms: u64) -> Self {
        Self { mins, last_ms: now_ms }
    }
    /// Activity: restart the countdown.
    pub fn touch(&mut self, now_ms: u64) {
        self.last_ms = now_ms;
    }
    /// The warning window for this timeout (ms).
    #[must_use]
    pub fn warn_window_ms(&self) -> u64 {
        (self.mins * 60_000 / 3).min(30_000)
    }
    /// Where we are at `now_ms` (a backwards clock restarts, never fires).
    #[must_use]
    pub fn state(&self, now_ms: u64) -> Idle {
        if self.mins == 0 {
            return Idle::Active;
        }
        let timeout = self.mins * 60_000;
        let idle = now_ms.saturating_sub(self.last_ms);
        if idle >= timeout {
            Idle::Lock
        } else if idle >= timeout - self.warn_window_ms() {
            Idle::Warn((timeout - idle).div_ceil(1000))
        } else {
            Idle::Active
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("enigma-app-test-{}", rand_hex(8)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn vault(base: &Path, name: &str) -> Vault {
        Vault::open(&Profiles::new(base.to_path_buf()), name, test_kdf()).unwrap()
    }

    #[test]
    fn create_lock_unlock_and_wrong_passphrase() {
        let base = tmp();
        let v = vault(&base, "default");
        assert!(!v.exists());
        v.create("correct horse").unwrap();
        assert!(v.is_unlocked());
        let seed = v.device_seed().unwrap();
        v.kv_put("friends", "default", "list", "[]");
        v.lock();
        assert!(!v.is_unlocked());
        assert!(v.device_seed().is_err(), "locked: no data");
        assert_eq!(v.unlock("wrong").unwrap_err(), "wrong passphrase");
        drop(v);
        let v = vault(&base, "default");
        assert!(v.exists());
        assert_eq!(v.unlock("correct horse").unwrap(), Opened::Unlocked);
        assert_eq!(v.device_seed().unwrap(), seed, "the device key survives");
        assert_eq!(v.kv_get("friends", "default", "list").as_deref(), Some("[]"));
        v.change_passphrase("correct horse", "battery").unwrap();
        v.lock();
        assert!(v.unlock("correct horse").is_err());
        assert_eq!(v.unlock("battery").unwrap(), Opened::Unlocked);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn pin_enrol_unlock_tries_and_clear() {
        let base = tmp();
        let v = vault(&base, "default");
        v.create("pass").unwrap();
        assert!(v.pin_enroll("nope", "123456", None).is_err());
        assert!(v.pin_enroll("pass", "12a4", None).is_err());
        v.pin_enroll("pass", "123456", None).unwrap();
        v.lock();
        assert!(v.pin_status().enrolled);
        assert!(v.pin_unlock("000000").is_err());
        assert_eq!(v.pin_status().attempts_left, PIN_MAX_FAILURES - 1);
        assert_eq!(v.pin_unlock("123456").unwrap(), Opened::Unlocked);
        assert_eq!(v.pin_status().attempts_left, PIN_MAX_FAILURES);
        v.lock();
        for _ in 0..PIN_MAX_FAILURES {
            assert!(v.pin_unlock("999999").is_err());
        }
        assert!(!v.pin_status().enrolled, "dropped after too many");
        assert_eq!(v.unlock("pass").unwrap(), Opened::Unlocked);
        v.pin_enroll("pass", "123456", None).unwrap();
        assert!(v.pin_enroll("pass", "123456", Some(("123457", "panic"))).is_err(), "too close");
        v.pin_clear();
        assert!(!v.pin_status().enrolled);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn panic_code_wipes_every_profile() {
        let base = tmp();
        let p = Profiles::new(base.clone());
        let other = vault(&base, "work");
        other.create("w").unwrap();
        other.kv_put("friends", "default", "list", "secret");
        drop(other);
        let v = vault(&base, "default");
        v.create("pass").unwrap();
        v.kv_put("friends", "default", "list", "secret");
        v.set_panic_code("pass", "duress").unwrap();
        assert!(v.has_panic_code());
        assert!(v.set_panic_code("pass", "pass").is_err());
        v.lock();
        assert_eq!(v.unlock("duress").unwrap(), Opened::Wiped);
        assert!(v.is_unlocked(), "opens like a normal unlock");
        assert_eq!(v.kv_get("friends", "default", "list"), None, "nothing left");
        assert!(!v.has_panic_code());
        assert!(!has_vault(&p.dir("work")), "other profiles gone too");
        v.lock();
        assert_eq!(v.unlock("duress").unwrap(), Opened::Unlocked, "the code is now the passphrase");
        assert!(v.unlock("pass").is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn panic_pin_wipes() {
        let base = tmp();
        let v = vault(&base, "default");
        v.create("pass").unwrap();
        v.set_panic_code("pass", "duress").unwrap();
        v.kv_put("x", "y", "z", "1");
        v.pin_enroll("pass", "1111", Some(("2222", "duress"))).unwrap();
        v.lock();
        assert_eq!(v.pin_unlock("2222").unwrap(), Opened::Wiped);
        assert_eq!(v.kv_get("x", "y", "z"), None);
        assert!(!v.pin_status().enrolled);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn profiles_create_switch_and_erase() {
        let base = tmp();
        let p = Profiles::new(base.clone());
        assert_eq!(p.list(), vec!["default".to_string()]);
        assert_eq!(p.active(), "default");
        p.set_active("Work stuff").unwrap();
        assert_eq!(p.active(), "Work_stuff");
        let v = vault(&base, &p.active());
        v.create("a").unwrap();
        v.kv_put("k", "s", "x", "1");
        assert!(p.list().contains(&"Work_stuff".to_string()));
        v.erase().unwrap();
        assert!(!v.exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_tauri_profile_opens_with_the_same_layout() {
        // What the Tauri app writes, written with protasius directly.
        let base = tmp();
        let p = Profiles::new(base.clone());
        {
            let mut s = Protasius::open(p.dir("default")).unwrap();
            s.setup_with_kdf("tauri", test_kdf(), &MigrationPlan::default()).unwrap();
            s.put("keys", "device_ed25519", &[7u8; 32]).unwrap();
            s.put("profile", "state", br#"{"offline_profile":{"display_name":"Ola"}}"#).unwrap();
            s.kv_put("p2p:rooms", "default", "", r#"[{"room":"topic-x","name":"X"}]"#).unwrap();
            s.kv_put("friends", "default", "list", "[]").unwrap();
            s.put("mls", "topic-x\0me", b"blob").unwrap();
        }
        let v = vault(&base, "default");
        assert_eq!(v.unlock("tauri").unwrap(), Opened::Unlocked);
        assert_eq!(v.device_seed().unwrap(), [7u8; 32]);
        assert_eq!(v.tauri_nickname().as_deref(), Some("Ola"));
        use enigma_core::Kv as _;
        assert!(v.engine_kv().get("p2p:rooms", "default").unwrap().contains("topic-x"));
        use enigmatite::mls::Store as _;
        assert_eq!(v.mls_store().get("topic-x", "me").as_deref(), Some(&b"blob"[..]));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn idle_lock_warns_then_locks() {
        let mut i = IdleLock::new(1, 1_000);
        assert_eq!(i.warn_window_ms(), 20_000, "a third of a minute");
        assert_eq!(i.state(1_000 + 39_000), Idle::Active);
        assert_eq!(i.state(1_000 + 41_000), Idle::Warn(19));
        assert_eq!(i.state(1_000 + 60_000), Idle::Lock);
        i.touch(61_000);
        assert_eq!(i.state(62_000), Idle::Active);
        assert_eq!(i.state(0), Idle::Active, "a backwards clock never fires");
        assert_eq!(IdleLock::new(15, 0).warn_window_ms(), 30_000);
        assert_eq!(IdleLock::new(0, 0).state(u64::MAX), Idle::Active, "off");
    }
}
