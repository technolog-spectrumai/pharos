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
//! Vault: passphrase → gervasius UKEK → wraps a random DEK; the `VaultHeader` is a
//! plaintext `<profile_dir>/vault.json` (safe in the clear). The DEK lives in
//! memory only while unlocked (zeroized on lock/drop). Tauri-agnostic — the host
//! app wires the commands and supplies migration paths.

use std::path::{Path, PathBuf};

use fjall::{Config, Keyspace, PartitionCreateOptions, PartitionHandle, PersistMode};
use gervasius::{Dek, VaultHeader};
use serde::Serialize;

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
    header: Option<VaultHeader>,
    dek: Option<Dek>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultStatus {
    /// A vault has been set up (vault.json present).
    pub exists: bool,
    /// Currently unlocked (DEK held in memory).
    pub unlocked: bool,
}

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
        let header = read_header(&profile_dir)?;
        Ok(Protasius { profile_dir, keyspace, data, header, dek: None })
    }

    pub fn status(&self) -> VaultStatus {
        VaultStatus { exists: self.header.is_some(), unlocked: self.dek.is_some() }
    }

    /// First-run: create the vault (random DEK wrapped by the passphrase), commit
    /// `vault.json`, then fold in any legacy plaintext (`plan`). Leaves unlocked.
    pub fn setup(&mut self, passphrase: &str, plan: &MigrationPlan) -> Result<(), ProtasiusError> {
        if self.header.is_some() {
            return Err(ProtasiusError::VaultExists);
        }
        let (header, dek) = gervasius::create_vault(passphrase)?;
        self.dek = Some(dek); // enable seals during migration
        self.write_header(&header)?; // durable commit point — the vault now exists
        self.header = Some(header);
        // Best-effort: the vault is created + unlocked regardless. A migration that
        // errors mid-way is idempotent and completes on the next unlock's sweep, so
        // don't strand a just-created vault by returning Err here.
        let _ = self.migrate(plan);
        Ok(())
    }

    /// Unlock with a passphrase. Wrong passphrase fails closed (the wrapped-DEK tag).
    pub fn unlock(&mut self, passphrase: &str) -> Result<(), ProtasiusError> {
        let header = self.header.as_ref().ok_or(ProtasiusError::NoVault)?;
        let dek = gervasius::unlock(header, passphrase).map_err(|_| ProtasiusError::WrongPassphrase)?;
        self.dek = Some(dek);
        Ok(())
    }

    /// Drop the in-memory DEK (zeroized). The store stays open but data ops error.
    pub fn lock(&mut self) {
        self.dek = None;
    }

    /// Change the passphrase: verify `current`, re-wrap the SAME DEK under `new`.
    /// Data is untouched (O(1)). Stays unlocked.
    pub fn change_passphrase(&mut self, current: &str, new: &str) -> Result<(), ProtasiusError> {
        let header = self.header.as_ref().ok_or(ProtasiusError::NoVault)?;
        let dek = gervasius::unlock(header, current).map_err(|_| ProtasiusError::WrongPassphrase)?;
        let new_header = gervasius::rewrap(header, &dek, new)?;
        self.write_header(&new_header)?;
        self.header = Some(new_header);
        self.dek = Some(dek);
        Ok(())
    }

    /// Destroy everything for this profile (forgot-passphrase flow): drop keys,
    /// clear all entries, delete `vault.json`. The store is reusable (back to setup).
    pub fn wipe(&mut self) -> Result<(), ProtasiusError> {
        self.dek = None;
        self.header = None;
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

    fn write_header(&self, header: &VaultHeader) -> Result<(), ProtasiusError> {
        let path = vault_path(&self.profile_dir);
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(header)?;
        std::fs::write(&tmp, &bytes).map_err(io_err)?;
        std::fs::rename(&tmp, &path).map_err(io_err)?; // atomic commit
        Ok(())
    }
}

fn vault_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("vault.json")
}

fn read_header(profile_dir: &Path) -> Result<Option<VaultHeader>, ProtasiusError> {
    match std::fs::read(vault_path(profile_dir)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err(e)),
    }
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
