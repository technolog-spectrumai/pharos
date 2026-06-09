// Local key/value store backed by fjall (pure-Rust LSM — no C deps, Android-clean;
// same rationale as the y_store / flat-file HTTP cache). This replaces the previous
// SQLite (`tauri-plugin-sql`) backing for the JS local cache so the binary links
// only ONE sqlite (the one arti pulls in via tor-dirmgr/rusqlite), avoiding the
// `libsqlite3-sys` `links = "sqlite3"` collision that blocks embedding Tor.
//
// It is the single local backing store for (see services/localDb.ts):
//   - the offline response cache (api.ts), namespace "cache"
//   - the Notes snapshot + mutation queue, namespaces "notes:snapshot"/"notes:queue"
//   - the P2P room list (useChatChannel.ts), namespace "p2p:rooms"
//
// Entries are keyed by (ns, scope, k); the encoded key is `ns\0scope\0k`, so a
// prefix scan on `ns\0` or `ns\0scope\0` implements namespace/scope clear + count.
// ns/scope/k never contain NUL in practice (fixed namespaces + server-URL scopes).

use std::path::PathBuf;

use fjall::{Config, Keyspace, PartitionCreateOptions, PartitionHandle, PersistMode};
use tauri::{AppHandle, Manager, State};

pub struct KvStore {
    keyspace: Keyspace,
    kv: PartitionHandle,
}

/// `None` if fjall failed to open — commands then return an error and the
/// frontend degrades (cache misses fall through to the live HTTP payload).
pub struct KvState(pub Option<KvStore>);

pub fn init(app: &AppHandle) -> KvState {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    match KvStore::open_at(base.join("kvstore")) {
        Ok(store) => KvState(Some(store)),
        Err(e) => {
            eprintln!("kv: fjall unavailable ({e}); local cache disabled");
            KvState(None)
        }
    }
}

impl KvStore {
    fn open_at(dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).ok();
        let keyspace = Config::new(&dir).open().map_err(|e| e.to_string())?;
        let kv = keyspace
            .open_partition("kv", PartitionCreateOptions::default())
            .map_err(|e| e.to_string())?;
        Ok(KvStore { keyspace, kv })
    }
}

fn enc_key(ns: &str, scope: &str, k: &str) -> Vec<u8> {
    let mut key = Vec::with_capacity(ns.len() + scope.len() + k.len() + 2);
    key.extend_from_slice(ns.as_bytes());
    key.push(0);
    key.extend_from_slice(scope.as_bytes());
    key.push(0);
    key.extend_from_slice(k.as_bytes());
    key
}

fn enc_prefix(ns: &str, scope: Option<&str>) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(ns.as_bytes());
    p.push(0);
    if let Some(s) = scope {
        p.extend_from_slice(s.as_bytes());
        p.push(0);
    }
    p
}

fn store<'a>(state: &'a State<'_, KvState>) -> Result<&'a KvStore, String> {
    state
        .0
        .as_ref()
        .ok_or_else(|| "local cache unavailable".to_string())
}

#[tauri::command]
pub fn kv_get(
    state: State<KvState>,
    ns: String,
    scope: String,
    k: String,
) -> Result<Option<String>, String> {
    let st = store(&state)?;
    match st.kv.get(enc_key(&ns, &scope, &k)).map_err(|e| e.to_string())? {
        Some(v) => Ok(Some(String::from_utf8_lossy(v.as_ref()).into_owned())),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn kv_put(
    state: State<KvState>,
    ns: String,
    scope: String,
    k: String,
    v: String,
) -> Result<(), String> {
    let st = store(&state)?;
    st.kv
        .insert(enc_key(&ns, &scope, &k), v.into_bytes())
        .map_err(|e| e.to_string())?;
    st.keyspace
        .persist(PersistMode::SyncAll)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn kv_delete(
    state: State<KvState>,
    ns: String,
    scope: String,
    k: String,
) -> Result<(), String> {
    let st = store(&state)?;
    st.kv
        .remove(enc_key(&ns, &scope, &k))
        .map_err(|e| e.to_string())?;
    st.keyspace
        .persist(PersistMode::SyncAll)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn kv_clear_namespace(
    state: State<KvState>,
    ns: String,
    scope: Option<String>,
) -> Result<(), String> {
    let st = store(&state)?;
    let prefix = enc_prefix(&ns, scope.as_deref());
    let keys: Vec<_> = st
        .kv
        .prefix(prefix)
        .map(|entry| entry.map(|(k, _)| k))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for key in keys {
        st.kv.remove(key).map_err(|e| e.to_string())?;
    }
    st.keyspace
        .persist(PersistMode::SyncAll)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn kv_count(
    state: State<KvState>,
    ns: String,
    scope: Option<String>,
) -> Result<u64, String> {
    let st = store(&state)?;
    let prefix = enc_prefix(&ns, scope.as_deref());
    let mut n: u64 = 0;
    for entry in st.kv.prefix(prefix) {
        entry.map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}
