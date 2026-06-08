// CRDT-backed mission data layer — storage only (no mutations, no transport yet).
//
// Missions fetched from the toto kanban server are ingested into a yrs CRDT `Doc`
// (one per project) and persisted with fjall — a pure-Rust LSM key/value store (no C
// deps, Android-clean: same rationale as μ-law over libopus and the flat-file HTTP
// cache in data.rs). Persistence goes through yrs-kvstore's `DocOps`, implemented over
// a fjall partition by the `FjallKv` adapter below. The frontend reads back a JSON
// projection identical to the server shape, so missions become viewable offline.
//
// This is the substrate for the eventual p2p mission sync: user editing, gossip
// transport and MLS encryption are layered on later. For now records are stored as
// opaque JSON-string values keyed by a stable client UUID (a `server_id → uuid` index
// makes re-ingest idempotent). Field-level CRDT granularity is deferred to the
// mutation/sync step — it buys nothing while records are only ever replaced wholesale
// by a server refetch.

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use fjall::{Config, Keyspace, PartitionCreateOptions, PartitionHandle, PersistMode, Slice};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use yrs::{Doc, Map, Transact};
use yrs_kvstore::{DocOps, KVEntry, KVStore};

// ── fjall ⇒ yrs-kvstore adapter ────────────────────────────────────────────────
//
// yrs-kvstore auto-implements `DocOps` (load_doc / insert_doc / push_update / flush_doc)
// for any type implementing `KVStore`. We back it with a single fjall partition; the
// crate namespaces every document internally by an OID derived from the doc name.

struct FjallKv<'a>(&'a PartitionHandle);

struct FjallEntry {
    key: Vec<u8>,
    value: Vec<u8>,
}

impl KVEntry for FjallEntry {
    fn key(&self) -> &[u8] {
        &self.key
    }
    fn value(&self) -> &[u8] {
        &self.value
    }
}

impl<'a> KVStore<'a> for FjallKv<'a> {
    type Error = fjall::Error;
    type Cursor = std::vec::IntoIter<FjallEntry>;
    type Entry = FjallEntry;
    type Return = Slice;

    fn get(&self, key: &[u8]) -> Result<Option<Self::Return>, Self::Error> {
        self.0.get(key)
    }

    fn upsert(&self, key: &[u8], value: &[u8]) -> Result<(), Self::Error> {
        self.0.insert(key.to_vec(), value.to_vec())
    }

    fn remove(&self, key: &[u8]) -> Result<(), Self::Error> {
        self.0.remove(key.to_vec())
    }

    fn remove_range(&self, from: &[u8], to: &[u8]) -> Result<(), Self::Error> {
        // yrs-kvstore uses inclusive `from..=to` ranges.
        let keys: Vec<Slice> = self
            .0
            .range(from.to_vec()..=to.to_vec())
            .map(|kv| kv.map(|(k, _)| k))
            .collect::<Result<_, _>>()?;
        for k in keys {
            self.0.remove(k)?;
        }
        Ok(())
    }

    fn iter_range(&self, from: &[u8], to: &[u8]) -> Result<Self::Cursor, Self::Error> {
        let entries: Vec<FjallEntry> = self
            .0
            .range(from.to_vec()..=to.to_vec())
            .map(|kv| {
                kv.map(|(k, v)| FjallEntry {
                    key: k.as_ref().to_vec(),
                    value: v.as_ref().to_vec(),
                })
            })
            .collect::<Result<_, _>>()?;
        Ok(entries.into_iter())
    }

    fn peek_back(&self, key: &[u8]) -> Result<Option<Self::Entry>, Self::Error> {
        // Greatest stored entry strictly less than `key` — yrs-kvstore relies on this for
        // OID allocation and last-update lookup (e.g. {1,2,5,7}.peek_back(4) == 2).
        match self.0.range(..key.to_vec()).next_back() {
            Some(kv) => {
                let (k, v) = kv?;
                Ok(Some(FjallEntry {
                    key: k.as_ref().to_vec(),
                    value: v.as_ref().to_vec(),
                }))
            }
            None => Ok(None),
        }
    }
}

// `DocOps` is auto-implemented; `yrs_kvstore::error::Error` (Box<dyn Error>) converts
// from `fjall::Error` via the std blanket `From<E: Error + 'static>`.
impl<'a> DocOps<'a> for FjallKv<'a> {}

// ── store ───────────────────────────────────────────────────────────────────────

pub struct MissionStore {
    keyspace: Keyspace,
    /// yrs-kvstore document storage; each project's doc is named `p{project_id}`.
    docs: PartitionHandle,
    /// `{map}:{server_id}` → client UUID, so re-ingesting a server row is idempotent.
    index: PartitionHandle,
    /// Serializes ingests (each does load → mutate → store full state).
    write_lock: Mutex<()>,
}

/// `None` if fjall failed to open — commands then return an error and the frontend
/// falls back to the raw HTTP payload (see tasks store).
pub struct MissionStoreState(pub Option<MissionStore>);

pub fn init(app: &AppHandle) -> MissionStoreState {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    match MissionStore::open_at(base.join("missioncrdt")) {
        Ok(store) => MissionStoreState(Some(store)),
        Err(e) => {
            eprintln!("mission_store: fjall unavailable ({e}); missions won't be cached");
            MissionStoreState(None)
        }
    }
}

impl MissionStore {
    pub fn open_at(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir).ok();
        let keyspace = Config::new(&dir)
            .open()
            .map_err(|e| anyhow!("fjall open: {e}"))?;
        let docs = keyspace
            .open_partition("docs", PartitionCreateOptions::default())
            .map_err(|e| anyhow!("fjall docs partition: {e}"))?;
        let index = keyspace
            .open_partition("index", PartitionCreateOptions::default())
            .map_err(|e| anyhow!("fjall index partition: {e}"))?;
        Ok(MissionStore {
            keyspace,
            docs,
            index,
            write_lock: Mutex::new(()),
        })
    }

    fn doc_name(project_id: i64) -> String {
        format!("p{project_id}")
    }

    /// Load a project's document from fjall (empty `Doc` if never ingested).
    fn load_doc(&self, project_id: i64) -> Result<Doc> {
        let doc = Doc::new();
        let kv = FjallKv(&self.docs);
        let name = Self::doc_name(project_id);
        {
            let mut txn = doc.transact_mut();
            kv.load_doc(name.as_bytes(), &mut txn)
                .map_err(|e| anyhow!("load_doc: {e}"))?;
        }
        Ok(doc)
    }

    /// Persist a project's full document state and fsync it.
    fn store_doc(&self, project_id: i64, doc: &Doc) -> Result<()> {
        let kv = FjallKv(&self.docs);
        let name = Self::doc_name(project_id);
        kv.insert_doc(name.as_bytes(), &doc.transact())
            .map_err(|e| anyhow!("insert_doc: {e}"))?;
        self.keyspace
            .persist(PersistMode::SyncAll)
            .map_err(|e| anyhow!("persist: {e}"))?;
        Ok(())
    }

    /// Stable client UUID for a server row, created (and indexed) on first sight.
    fn uuid_for(&self, map: &str, server_id: i64) -> Result<String> {
        let key = format!("{map}:{server_id}");
        if let Some(existing) = self.index.get(&key).map_err(|e| anyhow!("index get: {e}"))? {
            return Ok(String::from_utf8_lossy(existing.as_ref()).into_owned());
        }
        let uuid = Uuid::new_v4().to_string();
        self.index
            .insert(key.as_bytes(), uuid.as_bytes())
            .map_err(|e| anyhow!("index put: {e}"))?;
        Ok(uuid)
    }

    /// Upsert server records (each a JSON object, ideally with an `id`) into `map`.
    /// Records are stored whole as JSON strings keyed by their stable UUID.
    pub fn ingest(&self, project_id: i64, map: &str, records: &[Value]) -> Result<usize> {
        let _guard = self.write_lock.lock().unwrap();
        let doc = self.load_doc(project_id)?;
        let map_ref = doc.get_or_insert_map(map);
        {
            let mut txn = doc.transact_mut();
            for rec in records {
                let key = match rec.get("id").and_then(Value::as_i64) {
                    Some(id) => self.uuid_for(map, id)?,
                    None => Uuid::new_v4().to_string(),
                };
                let json = serde_json::to_string(rec)?;
                map_ref.insert(&mut txn, key, json);
            }
        }
        self.store_doc(project_id, &doc)?;
        Ok(records.len())
    }

    /// Project a `map`'s stored records back to the JSON array the frontend consumes.
    pub fn snapshot(&self, project_id: i64, map: &str) -> Result<Vec<Value>> {
        let doc = self.load_doc(project_id)?;
        let map_ref = doc.get_or_insert_map(map);
        let txn = doc.transact();
        let keys: Vec<String> = map_ref.keys(&txn).map(str::to_string).collect();
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            if let Ok(json) = map_ref.get_as::<_, String>(&txn, &k) {
                if let Ok(v) = serde_json::from_str::<Value>(&json) {
                    out.push(v);
                }
            }
        }
        Ok(out)
    }
}

// ── commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn mission_store_ingest(
    store: State<'_, MissionStoreState>,
    project_id: i64,
    map: String,
    records: Vec<Value>,
) -> Result<usize, String> {
    let s = store.0.as_ref().ok_or("mission store unavailable")?;
    s.ingest(project_id, &map, &records).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mission_store_snapshot(
    store: State<'_, MissionStoreState>,
    project_id: i64,
    map: String,
) -> Result<Vec<Value>, String> {
    let s = store.0.as_ref().ok_or("mission store unavailable")?;
    s.snapshot(project_id, &map).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_store() -> (MissionStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("misstest-{}", Uuid::new_v4()));
        (MissionStore::open_at(dir.clone()).expect("open store"), dir)
    }

    #[test]
    fn ingest_then_snapshot_round_trips_records() {
        let (store, dir) = temp_store();
        let recs = vec![
            json!({ "id": 1, "title": "Alpha", "urgency": 3 }),
            json!({ "id": 2, "title": "Beta", "urgency": 1 }),
        ];
        store.ingest(7, "missions", &recs).unwrap();

        let mut snap = store.snapshot(7, "missions").unwrap();
        snap.sort_by_key(|v| v["id"].as_i64().unwrap());
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0]["title"], "Alpha");
        assert_eq!(snap[1]["urgency"], 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn survives_reopen_from_fjall() {
        let (store, dir) = temp_store();
        store
            .ingest(7, "missions", &[json!({ "id": 1, "title": "Persisted" })])
            .unwrap();
        drop(store); // release the fjall keyspace + locks

        let reopened = MissionStore::open_at(dir.clone()).unwrap();
        let snap = reopened.snapshot(7, "missions").unwrap();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0]["title"], "Persisted");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reingesting_same_server_id_upserts_not_duplicates() {
        let (store, dir) = temp_store();
        store
            .ingest(7, "missions", &[json!({ "id": 1, "title": "Before" })])
            .unwrap();
        store
            .ingest(7, "missions", &[json!({ "id": 1, "title": "After" })])
            .unwrap();

        let snap = store.snapshot(7, "missions").unwrap();
        assert_eq!(snap.len(), 1, "same server id must map to one row");
        assert_eq!(snap[0]["title"], "After", "fields are updated in place");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn projects_are_isolated() {
        let (store, dir) = temp_store();
        store.ingest(1, "missions", &[json!({ "id": 1, "title": "P1" })]).unwrap();
        store.ingest(2, "missions", &[json!({ "id": 1, "title": "P2" })]).unwrap();

        assert_eq!(store.snapshot(1, "missions").unwrap()[0]["title"], "P1");
        assert_eq!(store.snapshot(2, "missions").unwrap()[0]["title"], "P2");

        let _ = std::fs::remove_dir_all(dir);
    }
}
