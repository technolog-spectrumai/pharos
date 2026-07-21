//! Protasius — Enigma's centralized, per-profile, encryption-at-rest data store.
//!
//! One `fjall` keyspace per profile holds ALL app state (profile settings, room
//! list, MLS blobs, identity keys) as **sealed values** (`gervasius` AEAD). Keys
//! are plaintext so namespace prefix scans still work; only values are encrypted,
//! each bound by AAD to its exact key so a sealed value can't be relocated.
//!
//! Layout (partition `data`):
//!   - kv passthrough (frontend `kv_*`): key `ns\0scope\0k`  (identical to the old
//!     `kv.rs`, so the room list stays under ns `p2p:rooms`).
//!   - internal: key `ns\0<key>` — e.g. `profile\0state`, `mls\0{room}\0{identity}`,
//!     `keys\0iroh_gossip`, `keys\0tor_peer_id`, `keys\0tor_keystore`.
//!
//! Vault: passphrase → gervasius UKEK → wraps a random DEK; the header lives in a
//! plaintext `<profile_dir>/vault.json` (safe in the clear). The DEK lives in
//! memory only while unlocked (zeroized on lock/drop). Tauri-agnostic — the host
//! app wires the commands and supplies migration paths.
//!
//! `vault.json` holds **two** key slots (v2): slot 0 is the real passphrase, slot 1
//! is the optional PANIC CODE — a duress passphrase whose only effect is to tell
//! the host to destroy everything (`unlock` returns `UnlockOutcome::Panic` and the
//! store stays locked). When no panic code is set, slot 1 is random filler of the
//! exact same shape, so nobody inspecting the file on disk can tell whether a panic
//! code exists. Whether one is set is recorded *inside* the encrypted store
//! (`vault/panic_set`), readable only once unlocked.

use std::path::{Path, PathBuf};

use fjall::{Config, Keyspace, PartitionCreateOptions, PartitionHandle, PersistMode};
use gervasius::{Dek, VaultHeader};
pub use gervasius::KdfParams;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

/// AAD prefix binding every sealed value to its (versioned) store + key.
const AAD_PREFIX: &[u8] = b"protasius:v1:";
/// Keyspace tags: internal (`get/put`) vs kv passthrough (`kv_*`) live in the same
/// partition, so a leading tag byte keeps them disjoint — a frontend kv namespace
/// can never collide with the reserved internal `profile`/`mls`/`keys`.
const TAG_INTERNAL: u8 = 0x01;
const TAG_KV: u8 = 0x02;

pub struct Protasius {
    profile_dir: PathBuf,
    keyspace: Keyspace,
    data: PartitionHandle,
    file: Option<VaultFile>,
    dek: Option<Dek>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultStatus {
    /// A vault has been set up (vault.json present).
    pub exists: bool,
    /// Currently unlocked (DEK held in memory).
    pub unlocked: bool,
}

/// What a passphrase turned out to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnlockOutcome {
    /// The real passphrase — the DEK is now in memory.
    Unlocked,
    /// The PANIC CODE. The store is left LOCKED; the host is expected to destroy
    /// the data and start a fresh vault (see `Protasius::wipe`).
    Panic,
}

/// On-disk `vault.json` (v2): always exactly `SLOT_COUNT` key slots — slot 0 real,
/// slot 1 panic-or-filler. v1 files (a bare `VaultHeader`) are read transparently
/// and lifted into this shape; see `read_vault_file`.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct VaultFile {
    version: u16,
    slots: Vec<VaultHeader>,
}

const VAULT_FILE_VERSION: u16 = 2;
const SLOT_REAL: usize = 0;
const SLOT_PANIC: usize = 1;
const SLOT_COUNT: usize = 2;

/// Internal ns/key of the "a panic code is set" marker. Lives inside the encrypted
/// store on purpose: the UI can answer "is one configured?" while unlocked, and the
/// on-disk vault.json stays identical either way.
const PANIC_NS: &str = "vault";
const PANIC_KEY: &str = "panic_set";

/// Byte-copyable legacy sources to fold into the encrypted store on first setup
/// (and to sweep on later unlocks if a crash left them behind). MLS `.bin` blobs
/// are migrated by the host app (they need parsing) — not listed here.
#[derive(Default, Clone)]
pub struct MigrationPlan {
    pub profile_state_json: Option<PathBuf>,
    pub iroh_key: Option<PathBuf>,
    pub tor_peer_id: Option<PathBuf>,
    pub legacy_kvstore_dir: Option<PathBuf>,
}

#[derive(Debug)]
pub enum ProtasiusError {
    /// A data op was attempted while locked (no DEK).
    Locked,
    /// No vault has been set up yet.
    NoVault,
    /// setup() called but a vault already exists.
    VaultExists,
    /// unlock()/change_passphrase() with the wrong current passphrase.
    WrongPassphrase,
    /// set_panic_passphrase() with a code that already opens the real slot — it
    /// would never fire (slot 0 is tried first) and would lock the user out of
    /// their own duress switch.
    PanicSameAsPassphrase,
    Crypto(gervasius::CryptoError),
    Store(String),
    Io(String),
    Serde(String),
}

impl std::fmt::Display for ProtasiusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtasiusError::Locked => write!(f, "vault is locked"),
            ProtasiusError::NoVault => write!(f, "no vault has been set up"),
            ProtasiusError::VaultExists => write!(f, "a vault already exists"),
            ProtasiusError::WrongPassphrase => write!(f, "wrong passphrase"),
            ProtasiusError::PanicSameAsPassphrase => {
                write!(f, "the panic code must differ from the passphrase")
            }
            ProtasiusError::Crypto(e) => write!(f, "{e}"),
            ProtasiusError::Store(e) => write!(f, "store error: {e}"),
            ProtasiusError::Io(e) => write!(f, "io error: {e}"),
            ProtasiusError::Serde(e) => write!(f, "serialization error: {e}"),
        }
    }
}
impl std::error::Error for ProtasiusError {}
impl From<gervasius::CryptoError> for ProtasiusError {
    fn from(e: gervasius::CryptoError) -> Self {
        ProtasiusError::Crypto(e)
    }
}
impl From<serde_json::Error> for ProtasiusError {
    fn from(e: serde_json::Error) -> Self {
        ProtasiusError::Serde(e.to_string())
    }
}

fn store_err<E: std::fmt::Display>(e: E) -> ProtasiusError {
    ProtasiusError::Store(e.to_string())
}
fn io_err<E: std::fmt::Display>(e: E) -> ProtasiusError {
    ProtasiusError::Io(e.to_string())
}

impl Protasius {
    /// Open (or create) the store at `<profile_dir>/protasius` and load the vault
    /// header if one exists. The store starts LOCKED (no DEK).
    pub fn open(profile_dir: PathBuf) -> Result<Self, ProtasiusError> {
        let store_dir = profile_dir.join("protasius");
        std::fs::create_dir_all(&store_dir).ok();
        let keyspace = Config::new(&store_dir).open().map_err(store_err)?;
        let data = keyspace
            .open_partition("data", PartitionCreateOptions::default())
            .map_err(store_err)?;
        let file = read_vault_file(&profile_dir)?;
        Ok(Protasius { profile_dir, keyspace, data, file, dek: None })
    }

    pub fn status(&self) -> VaultStatus {
        VaultStatus { exists: self.file.is_some(), unlocked: self.dek.is_some() }
    }

    /// First-run: create the vault (random DEK wrapped by the passphrase), commit
    /// `vault.json`, then fold in any legacy plaintext (`plan`). Leaves unlocked.
    pub fn setup(&mut self, passphrase: &str, plan: &MigrationPlan) -> Result<(), ProtasiusError> {
        self.setup_with_kdf(passphrase, KdfParams::default(), plan)
    }

    /// `setup` with caller-chosen Argon2id costs (e.g. the app's build config).
    /// The costs are recorded in the vault header, so unlocking never needs them.
    pub fn setup_with_kdf(
        &mut self,
        passphrase: &str,
        kdf: KdfParams,
        plan: &MigrationPlan,
    ) -> Result<(), ProtasiusError> {
        if self.file.is_some() {
            return Err(ProtasiusError::VaultExists);
        }
        let (header, dek) = gervasius::create_vault_with_params(passphrase, kdf.clone())?;
        self.dek = Some(dek); // enable seals during migration
        // Slot 1 starts as filler: a fresh vault is byte-shaped exactly like one
        // with a panic code set.
        let file = VaultFile {
            version: VAULT_FILE_VERSION,
            slots: vec![header, filler_slot(kdf)],
        };
        self.write_vault_file(&file)?; // durable commit point — the vault now exists
        self.file = Some(file);
        // Best-effort: the vault is created + unlocked regardless. A migration that
        // errors mid-way is idempotent and completes on the next unlock's sweep, so
        // don't strand a just-created vault by returning Err here.
        let _ = self.migrate(plan);
        Ok(())
    }

    /// Unlock with a passphrase. Wrong passphrase fails closed (the wrapped-DEK tag).
    ///
    /// The real slot is tried first, so a correct passphrase costs exactly one
    /// Argon2id derivation as before. Only a *failed* one pays for the second
    /// (panic-slot) derivation — which doubles the cost of a wrong guess, i.e. it
    /// also mildly slows brute force. A match on the panic slot does NOT unlock:
    /// it returns `Panic` and leaves the store locked for the host to destroy.
    pub fn unlock(&mut self, passphrase: &str) -> Result<UnlockOutcome, ProtasiusError> {
        let (mut file, real) = self.real_slot()?;
        if let Ok(dek) = gervasius::unlock(&real, passphrase) {
            self.dek = Some(dek);
            // Converge v1 files onto the two-slot layout now that we know the
            // passphrase was right (the lift already happened in memory on open).
            if file.version != VAULT_FILE_VERSION {
                file.version = VAULT_FILE_VERSION;
                self.write_vault_file(&file)?;
                self.file = Some(file);
            }
            return Ok(UnlockOutcome::Unlocked);
        }
        let panic_slot = file.slots.get(SLOT_PANIC).ok_or(ProtasiusError::WrongPassphrase)?;
        match gervasius::unlock(panic_slot, passphrase) {
            // Filler never opens, so this only happens for a real panic code.
            Ok(_) => Ok(UnlockOutcome::Panic),
            Err(_) => Err(ProtasiusError::WrongPassphrase),
        }
    }

    /// Drop the in-memory DEK (zeroized). The store stays open but data ops error.
    pub fn lock(&mut self) {
        self.dek = None;
    }

    /// Change the passphrase: verify `current`, re-wrap the SAME DEK under `new`.
    /// Data is untouched (O(1)). Stays unlocked. The panic slot is left as-is, so a
    /// configured panic code survives a passphrase change.
    pub fn change_passphrase(&mut self, current: &str, new: &str) -> Result<(), ProtasiusError> {
        let (mut file, real) = self.real_slot()?;
        let dek = gervasius::unlock(&real, current).map_err(|_| ProtasiusError::WrongPassphrase)?;
        file.slots[SLOT_REAL] = gervasius::rewrap(&real, &dek, new)?;
        self.write_vault_file(&file)?;
        self.file = Some(file);
        self.dek = Some(dek);
        Ok(())
    }

    // ── panic code (duress passphrase) ──────────────────────────────────────────

    /// Arm the panic code: verify `current` (the real passphrase), then wrap a
    /// throwaway key under `panic` into slot 1. The wrapped key is never used —
    /// only the fact that it opens matters (see `unlock`).
    pub fn set_panic_passphrase(&mut self, current: &str, panic: &str) -> Result<(), ProtasiusError> {
        let (mut file, real) = self.real_slot()?;
        let dek = gervasius::unlock(&real, current).map_err(|_| ProtasiusError::WrongPassphrase)?;
        if gervasius::unlock(&real, panic).is_ok() {
            return Err(ProtasiusError::PanicSameAsPassphrase);
        }
        let (panic_header, _throwaway) =
            gervasius::create_vault_with_params(panic, real.kdf.clone())?;
        file.slots[SLOT_PANIC] = panic_header;
        self.write_vault_file(&file)?;
        self.file = Some(file);
        self.dek = Some(dek); // `current` verified above ⇒ stay/become unlocked
        self.put(PANIC_NS, PANIC_KEY, b"1")
    }

    /// Disarm the panic code: verify `current`, overwrite slot 1 with fresh filler.
    /// The old code becomes an ordinary wrong passphrase.
    pub fn clear_panic_passphrase(&mut self, current: &str) -> Result<(), ProtasiusError> {
        let (mut file, real) = self.real_slot()?;
        let dek = gervasius::unlock(&real, current).map_err(|_| ProtasiusError::WrongPassphrase)?;
        file.slots[SLOT_PANIC] = filler_slot(real.kdf.clone());
        self.write_vault_file(&file)?;
        self.file = Some(file);
        self.dek = Some(dek);
        self.delete(PANIC_NS, PANIC_KEY)
    }

    /// Whether a panic code is armed. Requires unlock — the answer lives inside the
    /// encrypted store precisely so that `vault.json` gives nothing away.
    pub fn has_panic_passphrase(&self) -> Result<bool, ProtasiusError> {
        Ok(self.get(PANIC_NS, PANIC_KEY)?.is_some())
    }

    /// Destroy everything for this profile (forgot-passphrase flow): drop keys,
    /// clear all entries, delete `vault.json`. The store is reusable (back to setup).
    pub fn wipe(&mut self) -> Result<(), ProtasiusError> {
        self.dek = None;
        self.file = None;
        let keys: Vec<Vec<u8>> = self
            .data
            .iter()
            .map(|e| e.map(|(k, _)| k.as_ref().to_vec()))
            .collect::<Result<_, _>>()
            .map_err(store_err)?;
        for k in keys {
            self.data.remove(k).map_err(store_err)?;
        }
        self.persist()?;
        let _ = std::fs::remove_file(vault_path(&self.profile_dir));
        Ok(())
    }

    // ── data API (internal, generic ns/key) ─────────────────────────────────────

    pub fn get(&self, ns: &str, key: &str) -> Result<Option<Vec<u8>>, ProtasiusError> {
        let ek = enc(ns, key);
        self.get_enc(&ek)
    }
    pub fn put(&self, ns: &str, key: &str, val: &[u8]) -> Result<(), ProtasiusError> {
        let ek = enc(ns, key);
        self.put_enc(&ek, val)
    }
    pub fn delete(&self, ns: &str, key: &str) -> Result<(), ProtasiusError> {
        self.dek()?;
        self.data.remove(enc(ns, key)).map_err(store_err)?;
        self.persist()
    }

    // ── kv passthrough (frontend-shaped: ns\0scope\0k) ──────────────────────────

    pub fn kv_get(&self, ns: &str, scope: &str, k: &str) -> Result<Option<String>, ProtasiusError> {
        let ek = enc_kv(ns, scope, k);
        match self.get_enc(&ek)? {
            Some(pt) => Ok(Some(String::from_utf8_lossy(&pt).into_owned())),
            None => Ok(None),
        }
    }
    pub fn kv_put(&self, ns: &str, scope: &str, k: &str, v: &str) -> Result<(), ProtasiusError> {
        let ek = enc_kv(ns, scope, k);
        self.put_enc(&ek, v.as_bytes())
    }
    pub fn kv_delete(&self, ns: &str, scope: &str, k: &str) -> Result<(), ProtasiusError> {
        self.dek()?;
        self.data.remove(enc_kv(ns, scope, k)).map_err(store_err)?;
        self.persist()
    }
    pub fn kv_clear_namespace(&self, ns: &str, scope: Option<&str>) -> Result<(), ProtasiusError> {
        self.dek()?;
        let keys: Vec<Vec<u8>> = self
            .data
            .prefix(enc_prefix(ns, scope))
            .map(|e| e.map(|(k, _)| k.as_ref().to_vec()))
            .collect::<Result<_, _>>()
            .map_err(store_err)?;
        for k in keys {
            self.data.remove(k).map_err(store_err)?;
        }
        self.persist()
    }
    pub fn kv_count(&self, ns: &str, scope: Option<&str>) -> Result<u64, ProtasiusError> {
        self.dek()?;
        let mut n = 0u64;
        for e in self.data.prefix(enc_prefix(ns, scope)) {
            e.map_err(store_err)?;
            n += 1;
        }
        Ok(n)
    }

    /// Fold byte-copyable legacy plaintext into the encrypted store, then securely
    /// remove the originals. Idempotent (safe to re-run as a post-unlock sweep):
    /// each source is imported (durably) before its original is deleted, so a crash
    /// never loses data. Requires unlock.
    pub fn migrate(&self, plan: &MigrationPlan) -> Result<(), ProtasiusError> {
        self.dek()?;
        if let Some(p) = &plan.profile_state_json {
            if let Ok(bytes) = std::fs::read(p) {
                self.put("profile", "state", &bytes)?;
                wipe_and_remove(p);
            }
        }
        if let Some(p) = &plan.iroh_key {
            if let Ok(bytes) = std::fs::read(p) {
                self.put("keys", "iroh_gossip", &bytes)?;
                wipe_and_remove(p);
            }
        }
        if let Some(p) = &plan.tor_peer_id {
            if let Ok(bytes) = std::fs::read(p) {
                self.put("keys", "tor_peer_id", &bytes)?;
                wipe_and_remove(p);
            }
        }
        if let Some(dir) = &plan.legacy_kvstore_dir {
            if dir.exists() {
                self.import_legacy_kvstore(dir)?;
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        Ok(())
    }

    // ── internals ───────────────────────────────────────────────────────────────

    fn dek(&self) -> Result<&Dek, ProtasiusError> {
        self.dek.as_ref().ok_or(ProtasiusError::Locked)
    }

    /// The current vault file plus its real slot, both cloned so callers can edit a
    /// slot and write the result back without fighting the borrow checker.
    fn real_slot(&self) -> Result<(VaultFile, VaultHeader), ProtasiusError> {
        let file = self.file.clone().ok_or(ProtasiusError::NoVault)?;
        let real = file.slots.get(SLOT_REAL).cloned().ok_or(ProtasiusError::NoVault)?;
        Ok((file, real))
    }

    fn get_enc(&self, ek: &[u8]) -> Result<Option<Vec<u8>>, ProtasiusError> {
        let dek = self.dek()?;
        match self.data.get(ek).map_err(store_err)? {
            Some(v) => Ok(Some(gervasius::open(dek, &aad(ek), v.as_ref())?)),
            None => Ok(None),
        }
    }
    fn put_enc(&self, ek: &[u8], val: &[u8]) -> Result<(), ProtasiusError> {
        let dek = self.dek()?;
        let sealed = gervasius::seal(dek, &aad(ek), val)?;
        self.data.insert(ek, sealed).map_err(store_err)?;
        self.persist()
    }

    fn import_legacy_kvstore(&self, dir: &Path) -> Result<(), ProtasiusError> {
        // Old kvstore keys are already `ns\0scope\0k`, matching our kv layout.
        let ks = Config::new(dir).open().map_err(store_err)?;
        let kv = ks
            .open_partition("kv", PartitionCreateOptions::default())
            .map_err(store_err)?;
        let dek = self.dek()?;
        for entry in kv.iter() {
            let (k, v) = entry.map_err(store_err)?;
            // Legacy keys are `ns\0scope\0k`; re-tag as kv so they match `enc_kv`.
            let mut nk = vec![TAG_KV];
            nk.extend_from_slice(k.as_ref());
            let sealed = gervasius::seal(dek, &aad(&nk), v.as_ref())?;
            self.data.insert(&nk, sealed).map_err(store_err)?;
        }
        self.persist()
    }

    fn persist(&self) -> Result<(), ProtasiusError> {
        self.keyspace.persist(PersistMode::SyncAll).map_err(store_err)
    }

    fn write_vault_file(&self, file: &VaultFile) -> Result<(), ProtasiusError> {
        let path = vault_path(&self.profile_dir);
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(file)?;
        std::fs::write(&tmp, &bytes).map_err(io_err)?;
        std::fs::rename(&tmp, &path).map_err(io_err)?; // atomic commit
        Ok(())
    }
}

fn vault_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("vault.json")
}

/// A slot that opens for nobody, shaped exactly like a real one: random salt and a
/// random `wrapped_dek` of the exact ciphertext length gervasius produces
/// (`24-byte nonce || 32-byte key || 16-byte tag`). No KDF work — the bytes only
/// have to be indistinguishable, not derived.
fn filler_slot(kdf: KdfParams) -> VaultHeader {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut wrapped_dek = vec![0u8; 24 + 32 + 16];
    OsRng.fill_bytes(&mut wrapped_dek);
    VaultHeader { version: 1, kdf, salt, wrapped_dek }
}

/// Read `vault.json`. v2 files parse directly; a v1 file (a bare `VaultHeader`,
/// written before panic codes existed) is lifted to the two-slot shape with filler
/// in the panic slot — `unlock` persists that upgrade once the passphrase checks
/// out, so an old vault silently gains the layout without a migration pass.
fn read_vault_file(profile_dir: &Path) -> Result<Option<VaultFile>, ProtasiusError> {
    let bytes = match std::fs::read(vault_path(profile_dir)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(e)),
    };
    if let Ok(file) = serde_json::from_slice::<VaultFile>(&bytes) {
        if file.slots.len() == SLOT_COUNT {
            return Ok(Some(file));
        }
    }
    let legacy: VaultHeader = serde_json::from_slice(&bytes)?;
    let filler = filler_slot(legacy.kdf.clone());
    // version 1 marks "not yet rewritten"; unlock() converges it.
    Ok(Some(VaultFile { version: 1, slots: vec![legacy, filler] }))
}

fn aad(enc_key: &[u8]) -> Vec<u8> {
    let mut a = Vec::with_capacity(AAD_PREFIX.len() + enc_key.len());
    a.extend_from_slice(AAD_PREFIX);
    a.extend_from_slice(enc_key);
    a
}

fn enc(ns: &str, key: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(ns.len() + key.len() + 2);
    v.push(TAG_INTERNAL);
    v.extend_from_slice(ns.as_bytes());
    v.push(0);
    v.extend_from_slice(key.as_bytes());
    v
}

fn enc_kv(ns: &str, scope: &str, k: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(ns.len() + scope.len() + k.len() + 3);
    v.push(TAG_KV);
    v.extend_from_slice(ns.as_bytes());
    v.push(0);
    v.extend_from_slice(scope.as_bytes());
    v.push(0);
    v.extend_from_slice(k.as_bytes());
    v
}

fn enc_prefix(ns: &str, scope: Option<&str>) -> Vec<u8> {
    let mut p = vec![TAG_KV];
    p.extend_from_slice(ns.as_bytes());
    p.push(0);
    if let Some(s) = scope {
        p.extend_from_slice(s.as_bytes());
        p.push(0);
    }
    p
}

/// Best-effort secure delete: overwrite the file with zeros, then remove it.
fn wipe_and_remove(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::write(path, vec![0u8; meta.len() as usize]);
    }
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("protasius-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn setup_unlock_and_persist() {
        let dir = temp_dir();
        {
            let mut p = Protasius::open(dir.clone()).unwrap();
            assert_eq!(p.status(), VaultStatus { exists: false, unlocked: false });
            p.setup("pw", &MigrationPlan::default()).unwrap();
            assert_eq!(p.status(), VaultStatus { exists: true, unlocked: true });
            p.put("profile", "state", b"{\"x\":1}").unwrap();
        }
        // Reopen: exists but locked; data ops error until unlock.
        let mut p = Protasius::open(dir.clone()).unwrap();
        assert_eq!(p.status(), VaultStatus { exists: true, unlocked: false });
        assert!(matches!(p.get("profile", "state"), Err(ProtasiusError::Locked)));
        p.unlock("pw").unwrap();
        assert_eq!(p.get("profile", "state").unwrap().as_deref(), Some(&b"{\"x\":1}"[..]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn wrong_passphrase_fails() {
        let dir = temp_dir();
        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("right", &MigrationPlan::default()).unwrap();
        p.lock();
        assert!(matches!(p.unlock("wrong"), Err(ProtasiusError::WrongPassphrase)));
        assert!(!p.status().unlocked);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn values_are_sealed_keys_are_plaintext() {
        let dir = temp_dir();
        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("pw", &MigrationPlan::default()).unwrap();
        p.put("keys", "iroh_gossip", b"SUPERSECRETKEYBYTES").unwrap();
        // Raw stored value must be ciphertext (not the plaintext); key is plaintext.
        let raw = p.data.get(enc("keys", "iroh_gossip")).unwrap().unwrap();
        assert!(!raw.as_ref().windows(9).any(|w| w == b"SUPERSECR"));
        assert!(raw.as_ref().len() > 24); // at least a nonce + tag
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn change_passphrase_keeps_data() {
        let dir = temp_dir();
        {
            let mut p = Protasius::open(dir.clone()).unwrap();
            p.setup("old", &MigrationPlan::default()).unwrap();
            p.put("profile", "state", b"payload").unwrap();
            p.change_passphrase("old", "new").unwrap();
        }
        let mut p = Protasius::open(dir.clone()).unwrap();
        assert!(matches!(p.unlock("old"), Err(ProtasiusError::WrongPassphrase)));
        p.unlock("new").unwrap();
        assert_eq!(p.get("profile", "state").unwrap().as_deref(), Some(&b"payload"[..]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn kv_passthrough_roundtrip_and_scans() {
        let dir = temp_dir();
        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("pw", &MigrationPlan::default()).unwrap();
        p.kv_put("p2p:rooms", "default", "", "[]").unwrap();
        p.kv_put("cache", "a", "k", "1").unwrap();
        p.kv_put("cache", "b", "k", "2").unwrap();
        assert_eq!(p.kv_get("p2p:rooms", "default", "").unwrap().as_deref(), Some("[]"));
        assert_eq!(p.kv_count("cache", None).unwrap(), 2);
        assert_eq!(p.kv_count("cache", Some("a")).unwrap(), 1);
        p.kv_clear_namespace("cache", Some("a")).unwrap();
        assert_eq!(p.kv_count("cache", None).unwrap(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn migration_imports_and_deletes_originals() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        // Seed legacy plaintext.
        let profile_json = dir.join("profile_state.json");
        std::fs::write(&profile_json, b"{\"offline\":false}").unwrap();
        let iroh = dir.join("iroh_gossip.key");
        std::fs::write(&iroh, [9u8; 32]).unwrap();
        let peer = dir.join("peer.id");
        std::fs::write(&peer, b"abc123").unwrap();
        // Seed a legacy kvstore holding p2p:rooms.
        let legacy_kv = dir.join("kvstore");
        {
            let ks = Config::new(&legacy_kv).open().unwrap();
            let kv = ks.open_partition("kv", PartitionCreateOptions::default()).unwrap();
            // Legacy (pre-encryption) key layout: raw `ns\0scope\0k`, no tag byte.
            let mut legacy_key = b"p2p:rooms".to_vec();
            legacy_key.push(0);
            legacy_key.extend_from_slice(b"default");
            legacy_key.push(0);
            kv.insert(legacy_key, b"[{\"room\":\"r\"}]").unwrap();
            ks.persist(PersistMode::SyncAll).unwrap();
        }

        let plan = MigrationPlan {
            profile_state_json: Some(profile_json.clone()),
            iroh_key: Some(iroh.clone()),
            tor_peer_id: Some(peer.clone()),
            legacy_kvstore_dir: Some(legacy_kv.clone()),
        };

        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("pw", &plan).unwrap();

        assert_eq!(p.get("profile", "state").unwrap().as_deref(), Some(&b"{\"offline\":false}"[..]));
        assert_eq!(p.get("keys", "iroh_gossip").unwrap().unwrap(), vec![9u8; 32]);
        assert_eq!(p.get("keys", "tor_peer_id").unwrap().as_deref(), Some(&b"abc123"[..]));
        assert_eq!(p.kv_get("p2p:rooms", "default", "").unwrap().as_deref(), Some("[{\"room\":\"r\"}]"));
        // Originals gone.
        assert!(!profile_json.exists());
        assert!(!iroh.exists());
        assert!(!peer.exists());
        assert!(!legacy_kv.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── panic code ──────────────────────────────────────────────────────────────

    #[test]
    fn panic_code_reports_panic_and_leaves_store_locked() {
        let dir = temp_dir();
        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("real", &MigrationPlan::default()).unwrap();
        p.set_panic_passphrase("real", "burn").unwrap();
        assert!(p.has_panic_passphrase().unwrap());
        p.lock();

        assert_eq!(p.unlock("burn").unwrap(), UnlockOutcome::Panic);
        assert!(!p.status().unlocked, "panic must NOT open the vault");
        // The real passphrase still works, and anything else is still just wrong.
        assert!(matches!(p.unlock("nope"), Err(ProtasiusError::WrongPassphrase)));
        assert_eq!(p.unlock("real").unwrap(), UnlockOutcome::Unlocked);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn panic_code_must_differ_from_passphrase() {
        let dir = temp_dir();
        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("real", &MigrationPlan::default()).unwrap();
        assert!(matches!(
            p.set_panic_passphrase("real", "real"),
            Err(ProtasiusError::PanicSameAsPassphrase)
        ));
        assert!(matches!(
            p.set_panic_passphrase("wrong", "burn"),
            Err(ProtasiusError::WrongPassphrase)
        ));
        assert!(!p.has_panic_passphrase().unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cleared_panic_code_is_just_a_wrong_passphrase() {
        let dir = temp_dir();
        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("real", &MigrationPlan::default()).unwrap();
        p.set_panic_passphrase("real", "burn").unwrap();
        p.clear_panic_passphrase("real").unwrap();
        assert!(!p.has_panic_passphrase().unwrap());
        p.lock();
        assert!(matches!(p.unlock("burn"), Err(ProtasiusError::WrongPassphrase)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn panic_code_survives_a_passphrase_change() {
        let dir = temp_dir();
        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("old", &MigrationPlan::default()).unwrap();
        p.set_panic_passphrase("old", "burn").unwrap();
        p.change_passphrase("old", "new").unwrap();
        p.lock();
        assert_eq!(p.unlock("burn").unwrap(), UnlockOutcome::Panic);
        assert_eq!(p.unlock("new").unwrap(), UnlockOutcome::Unlocked);
        assert!(p.has_panic_passphrase().unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The whole point of the filler slot: vault.json must look the same whether or
    /// not a panic code is armed (same slot count, same field shapes, same lengths).
    #[test]
    fn vault_file_shape_is_identical_with_and_without_a_panic_code() {
        let shape = |dir: &PathBuf| -> (usize, Vec<usize>) {
            let bytes = std::fs::read(vault_path(dir)).unwrap();
            let file: VaultFile = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(file.version, VAULT_FILE_VERSION);
            (file.slots.len(), file.slots.iter().map(|s| s.wrapped_dek.len()).collect())
        };

        let bare = temp_dir();
        let mut p = Protasius::open(bare.clone()).unwrap();
        p.setup("real", &MigrationPlan::default()).unwrap();

        let armed = temp_dir();
        let mut q = Protasius::open(armed.clone()).unwrap();
        q.setup("real", &MigrationPlan::default()).unwrap();
        q.set_panic_passphrase("real", "burn").unwrap();

        assert_eq!(shape(&bare), shape(&armed));
        assert_eq!(shape(&bare), (SLOT_COUNT, vec![24 + 32 + 16; SLOT_COUNT]));
        let _ = std::fs::remove_dir_all(bare);
        let _ = std::fs::remove_dir_all(armed);
    }

    /// A vault.json written before panic codes existed (a bare VaultHeader) must
    /// still unlock, and gets upgraded to the two-slot layout in place.
    #[test]
    fn legacy_v1_vault_file_unlocks_and_upgrades() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let (header, _dek) = gervasius::create_vault("pw").unwrap();
        std::fs::write(vault_path(&dir), serde_json::to_vec_pretty(&header).unwrap()).unwrap();

        let mut p = Protasius::open(dir.clone()).unwrap();
        assert!(p.status().exists);
        assert_eq!(p.unlock("pw").unwrap(), UnlockOutcome::Unlocked);

        // Rewritten as v2, and a panic code can now be armed on it.
        let bytes = std::fs::read(vault_path(&dir)).unwrap();
        let file: VaultFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(file.version, VAULT_FILE_VERSION);
        assert_eq!(file.slots.len(), SLOT_COUNT);
        p.set_panic_passphrase("pw", "burn").unwrap();
        p.lock();
        assert_eq!(p.unlock("burn").unwrap(), UnlockOutcome::Panic);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The panic wipe (host side) works by swapping the live store for one on a
    /// scratch dir — dropping the old `Protasius` so fjall releases its handles —
    /// and only then deleting the profile directory. Pin that sequence down here.
    #[test]
    fn profile_dir_can_be_deleted_once_the_store_is_dropped() {
        let dir = temp_dir();
        let scratch = temp_dir();
        let mut store = Protasius::open(dir.clone()).unwrap();
        store.setup("pw", &MigrationPlan::default()).unwrap();
        store.put("profile", "state", b"secrets").unwrap();

        // Same move the host makes: replace the live store, drop the old one.
        drop(std::mem::replace(&mut store, Protasius::open(scratch.clone()).unwrap()));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());

        // Re-open at the same path and set up fresh: nothing survives.
        store = Protasius::open(dir.clone()).unwrap();
        assert!(!store.status().exists);
        store.setup("panic-code", &MigrationPlan::default()).unwrap();
        assert!(store.get("profile", "state").unwrap().is_none());
        assert!(!store.has_panic_passphrase().unwrap());
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(scratch);
    }

    #[test]
    fn wipe_clears_everything() {
        let dir = temp_dir();
        let mut p = Protasius::open(dir.clone()).unwrap();
        p.setup("pw", &MigrationPlan::default()).unwrap();
        p.put("profile", "state", b"data").unwrap();
        p.wipe().unwrap();
        assert_eq!(p.status(), VaultStatus { exists: false, unlocked: false });
        assert!(!vault_path(&dir).exists());
        // Store still usable: set up fresh.
        p.setup("pw2", &MigrationPlan::default()).unwrap();
        assert!(p.get("profile", "state").unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
