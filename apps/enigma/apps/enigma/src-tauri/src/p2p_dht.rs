// Mainline-DHT (Kademlia) rendezvous + presence engine — the server-free peer
// discovery behind the Settings "DHT discovery" toggle. See dht.md for the
// protocol spec and threat notes.
//
// Two functions ride the public BitTorrent DHT (community bootstrap, no infra
// of ours):
//
// 1. Room rendezvous: every holder of a room's 32-byte secret derives the SAME
//    hourly-rotating ed25519 key and publishes an encrypted BEP44 mutable item
//    listing its iroh EndpointId (+ up to 4 gossip neighbors). A ticketless
//    joiner with the secret reads those records and bootstraps the room's
//    existing gossip topic — `blake3(room_name)`, unchanged, so DHT-joiners,
//    ticket-joiners and reconnects all land on one topic.
// 2. Presence: iroh's `DhtAddressLookup` (wired in p2p_iroh::ensure_started)
//    publishes each node's pkarr record under its own EndpointId roughly every
//    hour. "Recently online" = that record's timestamp is fresh. Verified
//    against iroh 0.98.2 source: salt is None, seq is pkarr µs-since-epoch.
//
// The DHT only introduces transport connections — MLS still gates membership.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    ChaCha20Poly1305, Key, Nonce,
};
use futures_lite::StreamExt;
use iroh::EndpointId;
use mainline::{async_dht::AsyncDht, Dht, MutableItem, SigningKey};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ── settings (kv `p2p:settings`, user-set in the Settings tab — never hardcode) ─

const SETTINGS_NS: &str = "p2p:settings";
const SETTINGS_SCOPE: &str = "default";

/// The opt-in toggle. Locked vault / missing key ⇒ off (today's behavior).
pub fn discovery_enabled(app: &AppHandle) -> bool {
    crate::vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, "dht_discovery").as_deref()
        == Some("on")
}

fn setting_secs(app: &AppHandle, key: &str, default: u64, min: u64, max: u64) -> u64 {
    crate::vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, key)
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(min, max))
        .unwrap_or(default)
}

/// Rendezvous publish interval. Re-read every round so Settings edits apply live.
fn room_publish_secs(app: &AppHandle) -> u64 {
    setting_secs(app, "dht_room_publish_secs", 600, 60, 3600)
}

/// The user-set connect deadline (same value the frontend's join window uses —
/// see CONVENTIONS.md §3: never hardcode a connect deadline). Bounds how long
/// the rendezvous resolver keeps retrying after a ticketless join.
pub fn connect_timeout_secs(app: &AppHandle) -> u64 {
    setting_secs(app, "connect_timeout_secs", 60, 5, 600)
}

// ── protocol constants (spec: dht.md) ───────────────────────────────────────────

/// Rendezvous keys rotate hourly; readers query the current and previous bucket.
const BUCKET_SECS: u64 = 3600;
/// BEP44 salt. Constant — the signing key itself is what rotates per bucket.
const RENDEZVOUS_SALT: &[u8] = b"enigma-room-v1";
const RECORD_VERSION: u8 = 1;
/// A record advertises the publisher plus at most this many gossip neighbors.
const MAX_RECORD_PEERS: usize = 4;
/// dtt-style back-off: with this many fresh third-party records already visible
/// at the rendezvous, a publisher skips its round (rate-limits large rooms).
const MAX_FRESH_RECORDS: usize = 5;
/// Records older than this are ignored (stale members, prior buckets).
const RECORD_FRESH_SECS: u64 = 2 * BUCKET_SECS;
/// Presence: iroh's DhtAddressLookup republishes ~hourly (REPUBLISH_DELAY = 1 h);
/// a pkarr record younger than 2× that reads as "recently online".
const PRESENCE_FRESH_MICROS: i64 = 2 * 3600 * 1_000_000;

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn bucket_of(secs: u64) -> u64 {
    secs / BUCKET_SECS
}

// ── room secret (vault ns "dht") ─────────────────────────────────────────────────

const VAULT_NS: &str = "dht";

fn secret_key_name(room_id: &str) -> String {
    format!("room_secret_{room_id}")
}

pub fn load_room_secret(app: &AppHandle, room_id: &str) -> Option<[u8; 32]> {
    let bytes = crate::vault::get(app, VAULT_NS, &secret_key_name(room_id)).ok().flatten()?;
    bytes.try_into().ok()
}

pub fn store_room_secret(app: &AppHandle, room_id: &str, secret: &[u8; 32]) -> Result<()> {
    crate::vault::put(app, VAULT_NS, &secret_key_name(room_id), secret)
        .map_err(|e| anyhow!("persist room secret: {e}"))
}

/// The room secret is random — NEVER derived from the room name, so rendezvous
/// points can't be squatted or enumerated from guessable names.
pub fn load_or_create_room_secret(app: &AppHandle, room_id: &str) -> Result<[u8; 32]> {
    if let Some(secret) = load_room_secret(app, room_id) {
        return Ok(secret);
    }
    let secret = iroh::SecretKey::generate().to_bytes();
    store_room_secret(app, room_id, &secret)?;
    Ok(secret)
}

// ── key derivation ───────────────────────────────────────────────────────────────

fn derive_material(secret: &[u8; 32], bucket: u64) -> [u8; 40] {
    let mut material = [0u8; 40];
    material[..32].copy_from_slice(secret);
    material[32..].copy_from_slice(&bucket.to_le_bytes());
    material
}

/// Shared by ALL secret-holders: storage nodes accept only records signed with
/// this key, so non-holders can't write to the rendezvous.
fn derive_signing_key(secret: &[u8; 32], bucket: u64) -> SigningKey {
    SigningKey::from_bytes(&blake3::derive_key(
        "enigma/dht/room-sign/v1",
        &derive_material(secret, bucket),
    ))
}

/// Seals record payloads so DHT observers can't read room membership (NodeIds).
fn derive_enc_key(secret: &[u8; 32], bucket: u64) -> [u8; 32] {
    blake3::derive_key("enigma/dht/room-enc/v1", &derive_material(secret, bucket))
}

// ── record codec ─────────────────────────────────────────────────────────────────

/// Plaintext of a rendezvous record. ~200 B sealed with 4 peers — the BEP44
/// value cap is 1000 B (asserted in tests).
#[derive(Serialize, Deserialize)]
struct Record {
    v: u8,
    node_id: [u8; 32],
    peers: Vec<[u8; 32]>,
    ts: u64,
}

fn encode_record(enc_key: &[u8; 32], record: &Record) -> Option<Vec<u8>> {
    let plaintext = postcard::to_stdvec(record).ok()?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(enc_key));
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let sealed = cipher.encrypt(&nonce, plaintext.as_slice()).ok()?;
    let mut value = nonce.to_vec();
    value.extend_from_slice(&sealed);
    Some(value)
}

fn decode_record(enc_key: &[u8; 32], value: &[u8]) -> Option<Record> {
    if value.len() < 12 {
        return None;
    }
    let (nonce, sealed) = value.split_at(12);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(enc_key));
    let plaintext = cipher.decrypt(Nonce::from_slice(nonce), sealed).ok()?;
    let record: Record = postcard::from_bytes(&plaintext).ok()?;
    (record.v == RECORD_VERSION).then_some(record)
}

// ── DHT handle ───────────────────────────────────────────────────────────────────

/// One extra Mainline node (client mode, community bootstrap) for the rendezvous
/// and presence queries. iroh's DhtAddressLookup runs its own — two UDP sockets
/// while the toggle is on, accepted in dht.md. Clones share the same node.
#[derive(Clone)]
pub struct DhtHandle {
    dht: AsyncDht,
}

impl DhtHandle {
    pub fn new() -> Result<Self> {
        let dht = Dht::builder()
            .build()
            .map_err(|e| anyhow!("mainline dht bind failed: {e}"))?;
        Ok(Self { dht: dht.as_async() })
    }

    /// Best-effort "is the Kademlia routing table alive" for status UIs. The
    /// underlying check runs a find_node query; cap it so status never hangs.
    pub async fn bootstrapped(&self) -> bool {
        matches!(
            tokio::time::timeout(Duration::from_secs(10), self.dht.bootstrapped()).await,
            Ok(true)
        )
    }

    /// Read the room rendezvous (current + previous bucket) and return every
    /// fresh member EndpointId, excluding our own.
    pub async fn resolve_room_peers(
        &self,
        secret: &[u8; 32],
        exclude: Option<EndpointId>,
    ) -> Vec<EndpointId> {
        let now = now_secs();
        let bucket = bucket_of(now);
        let mut ids: HashSet<[u8; 32]> = HashSet::new();
        // Previous bucket too: records published just before the hourly rotation
        // are still valid. (At bucket 0 both reads coincide; the set dedupes.)
        for b in [bucket, bucket.saturating_sub(1)] {
            let signing = derive_signing_key(secret, b);
            let enc = derive_enc_key(secret, b);
            for record in read_records(&self.dht, &signing, &enc).await {
                if now.saturating_sub(record.ts) > RECORD_FRESH_SECS {
                    continue;
                }
                ids.insert(record.node_id);
                for peer in record.peers.iter().take(MAX_RECORD_PEERS) {
                    ids.insert(*peer);
                }
            }
        }
        ids.into_iter()
            .filter_map(|bytes| EndpointId::from_bytes(&bytes).ok())
            .filter(|id| Some(*id) != exclude)
            .collect()
    }

    /// "Recently online" per contact: freshness of the pkarr record iroh's
    /// DhtAddressLookup publishes under the contact's EndpointId (seq = µs).
    /// Queries run concurrently — each is a full DHT lookup taking seconds.
    pub async fn presence(&self, node_ids: Vec<String>) -> Vec<(String, bool)> {
        let now_micros = (now_secs() as i64).saturating_mul(1_000_000);
        let mut tasks = tokio::task::JoinSet::new();
        for id_str in node_ids {
            let dht = self.dht.clone();
            tasks.spawn(async move {
                let online = match id_str.parse::<EndpointId>() {
                    Ok(id) => dht
                        .get_mutable_most_recent(id.as_bytes(), None)
                        .await
                        .map(|item| now_micros.saturating_sub(item.seq()) <= PRESENCE_FRESH_MICROS)
                        .unwrap_or(false),
                    Err(_) => false,
                };
                (id_str, online)
            });
        }
        let mut out = Vec::new();
        while let Some(Ok(pair)) = tasks.join_next().await {
            out.push(pair);
        }
        out
    }

    pub fn clone_dht(&self) -> AsyncDht {
        self.dht.clone()
    }
}

/// Drain one bucket's rendezvous records. `get_mutable` streams the scatter of
/// items held across storage nodes (multi-writer under one key: nodes keep the
/// highest seq each, different nodes hold different members' records).
async fn read_records(dht: &AsyncDht, signing: &SigningKey, enc_key: &[u8; 32]) -> Vec<Record> {
    let public_key = signing.verifying_key().to_bytes();
    let mut stream = dht.get_mutable(&public_key, Some(RENDEZVOUS_SALT), None);
    let mut out = Vec::new();
    while let Some(item) = stream.next().await {
        if let Some(record) = decode_record(enc_key, item.value()) {
            out.push(record);
        }
    }
    out
}

// ── room publisher ───────────────────────────────────────────────────────────────

/// Keep a room discoverable: publish our rendezvous record now and then every
/// `dht_room_publish_secs` (±20 % jitter) while the room is open. Aborted by
/// `leave_room`/`shutdown` via the returned handle — never runs in background.
pub fn spawn_room_publisher(
    app: AppHandle,
    dht: AsyncDht,
    secret: [u8; 32],
    self_id: EndpointId,
    neighbors: Arc<Mutex<HashSet<EndpointId>>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            let now = now_secs();
            let bucket = bucket_of(now);
            let signing = derive_signing_key(&secret, bucket);
            let enc = derive_enc_key(&secret, bucket);

            // Back-off: enough fresh records from other members already make the
            // room findable — skip our put this round (dtt-style rate limit).
            let fresh_others = read_records(&dht, &signing, &enc)
                .await
                .iter()
                .filter(|r| {
                    r.node_id != *self_id.as_bytes()
                        && now.saturating_sub(r.ts) <= RECORD_FRESH_SECS
                })
                .count();
            if fresh_others < MAX_FRESH_RECORDS {
                let peers: Vec<[u8; 32]> = neighbors
                    .lock()
                    .map(|set| set.iter().take(MAX_RECORD_PEERS).map(|id| *id.as_bytes()).collect())
                    .unwrap_or_default();
                let record =
                    Record { v: RECORD_VERSION, node_id: *self_id.as_bytes(), peers, ts: now };
                if let Some(value) = encode_record(&enc, &record) {
                    let item = MutableItem::new(signing, &value, now as i64, Some(RENDEZVOUS_SALT));
                    // Publish failures are routine on flaky networks and never
                    // fatal — the room stays reachable via ticket/n0; next round
                    // retries (and re-derives keys if the bucket rolled over).
                    let _ = dht.put_mutable(item, None).await;
                }
            }

            let base = room_publish_secs(&app);
            tokio::time::sleep(Duration::from_secs(jittered(base))).await;
        }
    })
}

/// ±20 % jitter so a room's members don't stampede the rendezvous in sync.
/// Derived from the clock's sub-second noise — no rand dependency needed.
fn jittered(base: u64) -> u64 {
    let noise = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;
    let spread = (2 * base / 5).max(1); // total window = 40 % of base, centered
    base - spread / 2 + noise % spread
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [42u8; 32];

    #[test]
    fn derivation_is_deterministic_and_rotates_per_bucket() {
        let a = derive_signing_key(&SECRET, 7).verifying_key().to_bytes();
        let b = derive_signing_key(&SECRET, 7).verifying_key().to_bytes();
        let c = derive_signing_key(&SECRET, 8).verifying_key().to_bytes();
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(derive_enc_key(&SECRET, 7), derive_enc_key(&SECRET, 7));
        assert_ne!(derive_enc_key(&SECRET, 7), derive_enc_key(&SECRET, 8));
        // Sign and encrypt keys must never coincide.
        assert_ne!(derive_signing_key(&SECRET, 7).to_bytes(), derive_enc_key(&SECRET, 7));
    }

    #[test]
    fn record_round_trips_only_with_the_right_key() {
        let enc = derive_enc_key(&SECRET, 1);
        let record = Record {
            v: RECORD_VERSION,
            node_id: [1u8; 32],
            peers: vec![[2u8; 32], [3u8; 32]],
            ts: 12345,
        };
        let value = encode_record(&enc, &record).expect("encode");
        let decoded = decode_record(&enc, &value).expect("decode with the right key");
        assert_eq!(decoded.node_id, record.node_id);
        assert_eq!(decoded.peers, record.peers);
        assert_eq!(decoded.ts, record.ts);

        let wrong = derive_enc_key(&SECRET, 2);
        assert!(decode_record(&wrong, &value).is_none());
        assert!(decode_record(&enc, b"garbage").is_none());
        assert!(decode_record(&enc, &[]).is_none());
    }

    #[test]
    fn record_fits_bep44_value_cap() {
        let enc = derive_enc_key(&SECRET, 1);
        let record = Record {
            v: RECORD_VERSION,
            node_id: [9u8; 32],
            peers: vec![[8u8; 32]; MAX_RECORD_PEERS],
            ts: u64::MAX,
        };
        let value = encode_record(&enc, &record).expect("encode");
        assert!(value.len() < 1000, "BEP44 caps values at 1000 B, got {}", value.len());
    }

    #[test]
    fn jitter_stays_within_20_percent() {
        for _ in 0..100 {
            let v = jittered(600);
            assert!((480..=720).contains(&v), "jittered(600) out of range: {v}");
        }
    }
}
