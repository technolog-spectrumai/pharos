// CRDT-backed local data store ("y_store") — a generic yrs + fjall key/value store.
//
// Server data (missions, and — for the sync feature — notes/events/locations) is
// ingested into yrs CRDT `Doc`s and persisted with fjall, a pure-Rust LSM store (no C
// deps, Android-clean: same rationale as μ-law over libopus and the flat-file HTTP cache
// in data.rs). Persistence goes through yrs-kvstore's `DocOps`, implemented over a fjall
// partition by the `FjallKv` adapter below. The frontend reads back a JSON projection
// identical to the server shape, so data stays viewable offline.
//
// A "doc" is any caller-chosen string scope (e.g. `missions:p7`, `notes`, `events`,
// `locations`); within a doc, records live in named maps. Records are stored as opaque
// JSON-string values keyed by a stable client UUID (a `{doc}:{map}:{server_id}` → uuid
// index makes re-ingest idempotent). This is the substrate the p2p sync layer exchanges:
// each doc is a yrs document whose state vectors / updates converge across peers.

use std::path::PathBuf;
use std::sync::Mutex;

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use data_encoding::BASE64;
use fjall::{Config, Keyspace, PartitionCreateOptions, PartitionHandle, PersistMode, Slice};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, Map, ReadTxn, StateVector, Transact, Update};
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

pub struct YStore {
    keyspace: Keyspace,
    /// yrs-kvstore document storage; one yrs doc per caller-chosen `doc` name.
    docs: PartitionHandle,
    /// `reg:{doc}` markers enumerating known docs (used to scope sync by domain prefix).
    index: PartitionHandle,
    /// Serializes ingests (each does load → mutate → store full state).
    write_lock: Mutex<()>,
}

/// `None` if fjall failed to open — commands then return an error and the frontend
/// falls back to the raw HTTP payload (see the data stores).
pub struct YStoreState(pub Option<YStore>);

pub fn init(app: &AppHandle) -> YStoreState {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    match YStore::open_at(base.join("ystore")) {
        Ok(store) => YStoreState(Some(store)),
        Err(e) => {
            eprintln!("y_store: fjall unavailable ({e}); data won't be cached");
            YStoreState(None)
        }
    }
}

impl YStore {
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
        Ok(YStore {
            keyspace,
            docs,
            index,
            write_lock: Mutex::new(()),
        })
    }

    /// Load a doc from fjall (empty `Doc` if never ingested).
    fn load_doc(&self, doc: &str) -> Result<Doc> {
        let ydoc = Doc::new();
        let kv = FjallKv(&self.docs);
        {
            let mut txn = ydoc.transact_mut();
            kv.load_doc(doc.as_bytes(), &mut txn)
                .map_err(|e| anyhow!("load_doc: {e}"))?;
        }
        Ok(ydoc)
    }

    /// Persist a doc's full state, register it for enumeration, and fsync.
    fn store_doc(&self, doc: &str, ydoc: &Doc) -> Result<()> {
        let kv = FjallKv(&self.docs);
        kv.insert_doc(doc.as_bytes(), &ydoc.transact())
            .map_err(|e| anyhow!("insert_doc: {e}"))?;
        self.index
            .insert(format!("reg:{doc}").as_bytes(), b"1")
            .map_err(|e| anyhow!("reg put: {e}"))?;
        self.keyspace
            .persist(PersistMode::SyncAll)
            .map_err(|e| anyhow!("persist: {e}"))?;
        Ok(())
    }

    /// Deterministic record key so re-ingest is idempotent and two peers' copies of the
    /// same row converge to one entry on sync. Server rows key on their `id` (`s{id}`);
    /// id-less rows key on a content hash (`h{blake3}`) so identical re-fetches dedup.
    fn record_key(rec: &Value) -> String {
        match rec.get("id") {
            // Server ids may be numeric (kanban/locations) or strings (events) — key on
            // either so edits upsert the same row.
            Some(Value::Number(n)) => format!("s{n}"),
            Some(Value::String(s)) if !s.is_empty() => format!("s{s}"),
            _ => {
                let json = serde_json::to_string(rec).unwrap_or_default();
                format!("h{}", blake3::hash(json.as_bytes()).to_hex())
            }
        }
    }

    /// Upsert server records (each a JSON object, ideally with an `id`) into `doc`/`map`.
    /// Records are stored whole as JSON strings keyed by their deterministic key.
    pub fn ingest(&self, doc: &str, map: &str, records: &[Value]) -> Result<usize> {
        let _guard = self.write_lock.lock().unwrap();
        let ydoc = self.load_doc(doc)?;
        let map_ref = ydoc.get_or_insert_map(map);
        {
            let mut txn = ydoc.transact_mut();
            for rec in records {
                let json = serde_json::to_string(rec)?;
                map_ref.insert(&mut txn, Self::record_key(rec), json);
            }
        }
        self.store_doc(doc, &ydoc)?;
        Ok(records.len())
    }

    /// Authoritative mirror: make `doc`/`map` hold exactly `records` — upsert changed
    /// rows, remove rows no longer present. Used for server-wins refresh (Phase 4) and
    /// snapshot persistence. Change-detection skips unchanged rows so a single edit
    /// doesn't tombstone-churn the whole collection (which would bloat sync).
    pub fn replace(&self, doc: &str, map: &str, records: &[Value]) -> Result<usize> {
        let _guard = self.write_lock.lock().unwrap();
        let ydoc = self.load_doc(doc)?;
        let map_ref = ydoc.get_or_insert_map(map);
        {
            let mut txn = ydoc.transact_mut();
            let mut desired: HashMap<String, String> = HashMap::new();
            for rec in records {
                desired.insert(Self::record_key(rec), serde_json::to_string(rec)?);
            }
            // Remove rows that are gone (collect keys first to drop the read borrow).
            let existing: Vec<String> = map_ref.keys(&txn).map(str::to_string).collect();
            for k in existing {
                if !desired.contains_key(&k) {
                    map_ref.remove(&mut txn, &k);
                }
            }
            // Upsert only rows whose stored JSON differs.
            for (k, json) in desired {
                let cur = map_ref.get_as::<_, String>(&txn, &k).ok();
                if cur.as_deref() != Some(json.as_str()) {
                    map_ref.insert(&mut txn, k, json);
                }
            }
        }
        self.store_doc(doc, &ydoc)?;
        Ok(records.len())
    }

    /// Project a `doc`/`map`'s stored records back to the JSON array the frontend consumes.
    pub fn snapshot(&self, doc: &str, map: &str) -> Result<Vec<Value>> {
        let ydoc = self.load_doc(doc)?;
        let map_ref = ydoc.get_or_insert_map(map);
        let txn = ydoc.transact();
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

    // ── sync primitives (peer ↔ peer, yrs two-way) ──────────────────────────────

    /// Names of all stored docs whose name starts with `prefix` (a domain, e.g. "notes").
    fn doc_names(&self, prefix: &str) -> Result<Vec<String>> {
        let reg_prefix = format!("reg:{prefix}");
        let mut out = Vec::new();
        for kv in self.index.prefix(reg_prefix.into_bytes()) {
            let (k, _) = kv.map_err(|e| anyhow!("reg scan: {e}"))?;
            // strip the "reg:" tag (4 bytes) to recover the doc name.
            out.push(String::from_utf8_lossy(&k.as_ref()[4..]).into_owned());
        }
        Ok(out)
    }

    /// `(docName, base64(state_vector))` for every doc under `prefix` — what we hand the
    /// peer so they can compute the delta we're missing.
    pub fn state_vectors(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        for name in self.doc_names(prefix)? {
            let ydoc = self.load_doc(&name)?;
            let sv = ydoc.transact().state_vector().encode_v1();
            out.push((name, BASE64.encode(&sv)));
        }
        Ok(out)
    }

    /// Given the peer's `(docName, base64 state_vector)` list, return `(docName,
    /// base64 update)` carrying everything we have that they lack — full state for our
    /// docs (under `prefix`) the peer didn't list.
    pub fn diff(&self, prefix: &str, remote: &[(String, String)]) -> Result<Vec<(String, String)>> {
        let remote_map: HashMap<&str, &str> =
            remote.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let mut out = Vec::new();
        for name in self.doc_names(prefix)? {
            let ydoc = self.load_doc(&name)?;
            let sv = match remote_map.get(name.as_str()) {
                Some(b64) => {
                    let bytes = BASE64.decode(b64.as_bytes()).map_err(|e| anyhow!("b64: {e}"))?;
                    StateVector::decode_v1(&bytes).map_err(|e| anyhow!("sv decode: {e}"))?
                }
                None => StateVector::default(),
            };
            let update = ydoc.transact().encode_state_as_update_v1(&sv);
            out.push((name, BASE64.encode(&update)));
        }
        Ok(out)
    }

    /// Apply received `(docName, base64 update)` blobs into the local docs; returns the
    /// names of docs that changed (so the UI can refresh).
    pub fn apply(&self, updates: &[(String, String)]) -> Result<Vec<String>> {
        let _guard = self.write_lock.lock().unwrap();
        let mut changed = Vec::new();
        for (name, b64) in updates {
            let bytes = BASE64.decode(b64.as_bytes()).map_err(|e| anyhow!("b64: {e}"))?;
            let update = Update::decode_v1(&bytes).map_err(|e| anyhow!("update decode: {e}"))?;
            let ydoc = self.load_doc(name)?;
            {
                let mut txn = ydoc.transact_mut();
                txn.apply_update(update);
            }
            self.store_doc(name, &ydoc)?;
            changed.push(name.clone());
        }
        Ok(changed)
    }
}

// ── commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn y_store_ingest(
    store: State<'_, YStoreState>,
    doc: String,
    map: String,
    records: Vec<Value>,
) -> Result<usize, String> {
    let s = store.0.as_ref().ok_or("y_store unavailable")?;
    s.ingest(&doc, &map, &records).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn y_store_replace(
    store: State<'_, YStoreState>,
    doc: String,
    map: String,
    records: Vec<Value>,
) -> Result<usize, String> {
    let s = store.0.as_ref().ok_or("y_store unavailable")?;
    s.replace(&doc, &map, &records).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn y_store_snapshot(
    store: State<'_, YStoreState>,
    doc: String,
    map: String,
) -> Result<Vec<Value>, String> {
    let s = store.0.as_ref().ok_or("y_store unavailable")?;
    s.snapshot(&doc, &map).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn y_store_state_vectors(
    store: State<'_, YStoreState>,
    prefix: String,
) -> Result<Vec<(String, String)>, String> {
    let s = store.0.as_ref().ok_or("y_store unavailable")?;
    s.state_vectors(&prefix).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn y_store_diff(
    store: State<'_, YStoreState>,
    prefix: String,
    remote: Vec<(String, String)>,
) -> Result<Vec<(String, String)>, String> {
    let s = store.0.as_ref().ok_or("y_store unavailable")?;
    s.diff(&prefix, &remote).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn y_store_apply(
    store: State<'_, YStoreState>,
    updates: Vec<(String, String)>,
) -> Result<Vec<String>, String> {
    let s = store.0.as_ref().ok_or("y_store unavailable")?;
    s.apply(&updates).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn temp_store() -> (YStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ystoretest-{}", Uuid::new_v4()));
        (YStore::open_at(dir.clone()).expect("open store"), dir)
    }

    #[test]
    fn ingest_then_snapshot_round_trips_records() {
        let (store, dir) = temp_store();
        let recs = vec![
            json!({ "id": 1, "title": "Alpha", "urgency": 3 }),
            json!({ "id": 2, "title": "Beta", "urgency": 1 }),
        ];
        store.ingest("missions:p7", "missions", &recs).unwrap();

        let mut snap = store.snapshot("missions:p7", "missions").unwrap();
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
            .ingest("notes", "boxes", &[json!({ "id": 1, "title": "Persisted" })])
            .unwrap();
        drop(store); // release the fjall keyspace + locks

        let reopened = YStore::open_at(dir.clone()).unwrap();
        let snap = reopened.snapshot("notes", "boxes").unwrap();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0]["title"], "Persisted");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reingesting_same_server_id_upserts_not_duplicates() {
        let (store, dir) = temp_store();
        store
            .ingest("events", "events", &[json!({ "id": 1, "title": "Before" })])
            .unwrap();
        store
            .ingest("events", "events", &[json!({ "id": 1, "title": "After" })])
            .unwrap();

        let snap = store.snapshot("events", "events").unwrap();
        assert_eq!(snap.len(), 1, "same server id must map to one row");
        assert_eq!(snap[0]["title"], "After", "fields are updated in place");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn docs_are_isolated() {
        let (store, dir) = temp_store();
        store.ingest("locations", "locations", &[json!({ "id": 1, "title": "L1" })]).unwrap();
        store.ingest("events", "events", &[json!({ "id": 1, "title": "E1" })]).unwrap();

        assert_eq!(store.snapshot("locations", "locations").unwrap()[0]["title"], "L1");
        assert_eq!(store.snapshot("events", "events").unwrap()[0]["title"], "E1");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn two_stores_converge_via_state_vector_diff_apply() {
        // Each peer creates a different row, plus a shared row they both edit.
        let (a, da) = temp_store();
        let (b, db) = temp_store();
        a.ingest("notes", "boxes", &[json!({ "id": 1, "title": "from A" })]).unwrap();
        b.ingest("notes", "boxes", &[json!({ "id": 2, "title": "from B" })]).unwrap();

        // Exchange state vectors, compute the delta each peer is missing, apply both ways.
        let sv_a = a.state_vectors("notes").unwrap();
        let sv_b = b.state_vectors("notes").unwrap();
        let a_to_b = a.diff("notes", &sv_b).unwrap();
        let b_to_a = b.diff("notes", &sv_a).unwrap();
        a.apply(&b_to_a).unwrap();
        b.apply(&a_to_b).unwrap();

        let mut sa = a.snapshot("notes", "boxes").unwrap();
        let mut sb = b.snapshot("notes", "boxes").unwrap();
        sa.sort_by_key(|v| v["id"].as_i64().unwrap());
        sb.sort_by_key(|v| v["id"].as_i64().unwrap());
        assert_eq!(sa.len(), 2, "A has both rows after sync");
        assert_eq!(sb.len(), 2, "B has both rows after sync");
        assert_eq!(sa, sb, "both peers converge to the same state");

        let _ = std::fs::remove_dir_all(da);
        let _ = std::fs::remove_dir_all(db);
    }

    #[test]
    fn replace_upserts_changed_and_removes_missing() {
        let (store, dir) = temp_store();
        store
            .ingest("notes", "boxes", &[json!({ "id": 1, "label": "A" }), json!({ "id": 2, "label": "B" })])
            .unwrap();

        // Authoritative mirror: box 1 changed, box 2 gone, box 3 new.
        store
            .replace("notes", "boxes", &[json!({ "id": 1, "label": "A2" }), json!({ "id": 3, "label": "C" })])
            .unwrap();

        let mut snap = store.snapshot("notes", "boxes").unwrap();
        snap.sort_by_key(|v| v["id"].as_i64().unwrap());
        assert_eq!(snap.len(), 2, "box 2 removed, box 3 added");
        assert_eq!(snap[0]["label"], "A2");
        assert_eq!(snap[1]["id"], 3);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn full_state_transferred_when_peer_lacks_a_doc() {
        // B has never seen the "events" doc; A's diff against B's (empty) SV list must
        // carry full state so B receives it.
        let (a, da) = temp_store();
        let (b, db) = temp_store();
        a.ingest("events", "events", &[json!({ "id": 5, "title": "Launch" })]).unwrap();

        let sv_b = b.state_vectors("events").unwrap(); // empty — B has no events doc
        let a_to_b = a.diff("events", &sv_b).unwrap();
        b.apply(&a_to_b).unwrap();

        let sb = b.snapshot("events", "events").unwrap();
        assert_eq!(sb.len(), 1);
        assert_eq!(sb[0]["title"], "Launch");

        let _ = std::fs::remove_dir_all(da);
        let _ = std::fs::remove_dir_all(db);
    }
}
