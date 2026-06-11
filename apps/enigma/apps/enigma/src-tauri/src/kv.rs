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

    fn get(&self, ns: &str, scope: &str, k: &str) -> Result<Option<String>, String> {
        match self.kv.get(enc_key(ns, scope, k)).map_err(|e| e.to_string())? {
            Some(v) => Ok(Some(String::from_utf8_lossy(v.as_ref()).into_owned())),
            None => Ok(None),
        }
    }

    fn put(&self, ns: &str, scope: &str, k: &str, v: &str) -> Result<(), String> {
        self.kv
            .insert(enc_key(ns, scope, k), v.as_bytes())
            .map_err(|e| e.to_string())?;
        self.persist()
    }

    fn delete(&self, ns: &str, scope: &str, k: &str) -> Result<(), String> {
        self.kv
            .remove(enc_key(ns, scope, k))
            .map_err(|e| e.to_string())?;
        self.persist()
    }

    fn clear_namespace(&self, ns: &str, scope: Option<&str>) -> Result<(), String> {
        let keys: Vec<_> = self
            .kv
            .prefix(enc_prefix(ns, scope))
            .map(|entry| entry.map(|(k, _)| k))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        for key in keys {
            self.kv.remove(key).map_err(|e| e.to_string())?;
        }
        self.persist()
    }

    fn count(&self, ns: &str, scope: Option<&str>) -> Result<u64, String> {
        let mut n: u64 = 0;
        for entry in self.kv.prefix(enc_prefix(ns, scope)) {
            entry.map_err(|e| e.to_string())?;
            n += 1;
        }
        Ok(n)
    }

    fn persist(&self) -> Result<(), String> {
        self.keyspace
            .persist(PersistMode::SyncAll)
            .map_err(|e| e.to_string())
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
    store(&state)?.get(&ns, &scope, &k)
}

#[tauri::command]
pub fn kv_put(
    state: State<KvState>,
    ns: String,
    scope: String,
    k: String,
    v: String,
) -> Result<(), String> {
    store(&state)?.put(&ns, &scope, &k, &v)
}

#[tauri::command]
pub fn kv_delete(
    state: State<KvState>,
    ns: String,
    scope: String,
    k: String,
) -> Result<(), String> {
    store(&state)?.delete(&ns, &scope, &k)
}

#[tauri::command]
pub fn kv_clear_namespace(
    state: State<KvState>,
    ns: String,
    scope: Option<String>,
) -> Result<(), String> {
    store(&state)?.clear_namespace(&ns, scope.as_deref())
}

#[tauri::command]
pub fn kv_count(
    state: State<KvState>,
    ns: String,
    scope: Option<String>,
) -> Result<u64, String> {
    store(&state)?.count(&ns, scope.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_store() -> (KvStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("kvtest-{}", Uuid::new_v4()));
        (KvStore::open_at(dir.clone()).expect("open kv"), dir)
    }

    #[test]
    fn round_trips_and_misses() {
        let (kv, dir) = temp_store();
        assert_eq!(kv.get("cache", "s", "k").unwrap(), None);
        kv.put("cache", "s", "k", "v1").unwrap();
        assert_eq!(kv.get("cache", "s", "k").unwrap().as_deref(), Some("v1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn upserts_in_place() {
        let (kv, dir) = temp_store();
        kv.put("cache", "s", "k", "v1").unwrap();
        kv.put("cache", "s", "k", "v2").unwrap();
        assert_eq!(kv.get("cache", "s", "k").unwrap().as_deref(), Some("v2"));
        assert_eq!(kv.count("cache", Some("s")).unwrap(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn isolates_by_namespace_and_scope() {
        let (kv, dir) = temp_store();
        kv.put("cache", "a", "k", "1").unwrap();
        kv.put("cache", "b", "k", "2").unwrap();
        kv.put("notes:queue", "a", "", "3").unwrap();
        assert_eq!(kv.get("cache", "a", "k").unwrap().as_deref(), Some("1"));
        assert_eq!(kv.get("cache", "b", "k").unwrap().as_deref(), Some("2"));
        assert_eq!(kv.count("cache", Some("a")).unwrap(), 1);
        assert_eq!(kv.count("cache", None).unwrap(), 2); // both scopes, same ns
        assert_eq!(kv.count("notes:queue", None).unwrap(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn scope_prefix_does_not_bleed_into_longer_scope() {
        // The NUL separator must keep scope "a" distinct from scope "ab".
        let (kv, dir) = temp_store();
        kv.put("cache", "a", "k", "1").unwrap();
        kv.put("cache", "ab", "k", "2").unwrap();
        assert_eq!(kv.count("cache", Some("a")).unwrap(), 1);
        assert_eq!(kv.count("cache", Some("ab")).unwrap(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn deletes_single_key() {
        let (kv, dir) = temp_store();
        kv.put("cache", "s", "k", "v").unwrap();
        kv.delete("cache", "s", "k").unwrap();
        assert_eq!(kv.get("cache", "s", "k").unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn clears_namespace_by_scope_and_whole() {
        let (kv, dir) = temp_store();
        kv.put("cache", "s1", "a", "1").unwrap();
        kv.put("cache", "s1", "b", "2").unwrap();
        kv.put("cache", "s2", "a", "3").unwrap();
        kv.clear_namespace("cache", Some("s1")).unwrap();
        assert_eq!(kv.count("cache", Some("s1")).unwrap(), 0);
        assert_eq!(kv.count("cache", Some("s2")).unwrap(), 1); // untouched
        kv.clear_namespace("cache", None).unwrap();
        assert_eq!(kv.count("cache", None).unwrap(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn survives_reopen_from_fjall() {
        let (kv, dir) = temp_store();
        kv.put("cache", "s", "k", "persisted").unwrap();
        drop(kv); // release the fjall keyspace + locks

        let reopened = KvStore::open_at(dir.clone()).unwrap();
        assert_eq!(
            reopened.get("cache", "s", "k").unwrap().as_deref(),
            Some("persisted")
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
