// Mainline-DHT (Kademlia) rendezvous + presence engine — the server-free peer
// discovery behind the Settings "DHT discovery" toggle. See technology.md §12 for the
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
// 3. Nickname directory: an opt-in "findable as ‹nick›" record under a key
//    derived STATICALLY from the normalized nickname (no rotation — lookups
//    must always land). Sealed like room records, so only someone searching
//    that exact name can read it. A serverless namespace has no registry:
//    results are CLAIMS (any client can publish any name) — the UI shows the
//    NodeId fingerprint and the invite handshake authenticates later.
//
// The DHT only introduces transport connections — MLS still gates membership.

use std::collections::{HashMap, HashSet};
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
use tauri::{AppHandle, Manager};

// ── settings (kv `p2p:settings`, user-set in the Settings tab — never hardcode) ─

const SETTINGS_NS: &str = "p2p:settings";
const SETTINGS_SCOPE: &str = "default";

/// Returned by the `dht_*` commands that would otherwise do real work in a
/// build with `dht.enabled: false` (Pro-only — pland.md). Mirrors MAPS_DISABLED
/// / PEERS_DISABLED. `dht_status` and `dht_room_code` deliberately do NOT use
/// it: both already have a total "nothing here" value in their own return type.
pub(crate) const DHT_DISABLED: &str = "DHT discovery is disabled in this build.";

/// Fail-fast guard for those commands. Checked before the offline/Tor gates so
/// a DHT-less build never reaches `ensure_started` — which would bind the whole
/// iroh endpoint and open a relay connection for a call that cannot succeed.
pub(crate) fn ensure_enabled() -> Result<(), String> {
    if !crate::build_config::dht::ENABLED {
        return Err(DHT_DISABLED.to_string());
    }
    Ok(())
}

/// True in Tor-exclusive mode, where iroh (and therefore every DHT function)
/// is torn down.
fn tor_exclusive(app: &AppHandle) -> bool {
    let state = app.state::<crate::AppConfigState>();
    match crate::active_config(&state) {
        Ok(cfg) => crate::is_use_tor(&crate::load_profile_state(app, &cfg)),
        Err(_) => false,
    }
}

/// The opt-in toggle. Edition gate first, then the relay/discovery kill switch,
/// then Tor mode, then the user's setting; locked vault / missing key ⇒ the
/// build-config default. Single choke point: gates DhtHandle,
/// DhtAddressLookup, the nick publisher, dht_status and ticketless joins.
///
/// The build gate sits ABOVE the kv read on purpose: a profile carrying
/// `dht_discovery: "on"` from a Pro build must read as off here, without the
/// key being rewritten (the same profile reopened by Pro keeps the choice).
///
/// Tor mode returns false unconditionally: the DHT rides the iroh endpoint,
/// which Tor-exclusive mode shuts down, and a pkarr record would publish a
/// relay address this profile is deliberately not using.
pub fn discovery_enabled(app: &AppHandle) -> bool {
    if !crate::build_config::dht::ENABLED {
        return false;
    }
    if !crate::build_config::p2p::ALLOW_HOSTED_RELAYS {
        return false;
    }
    if tor_exclusive(app) {
        return false;
    }
    match crate::vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, "dht_discovery") {
        Some(v) => v == "on",
        None => crate::build_config::features::DHT_DISCOVERY_DEFAULT,
    }
}

fn setting_secs(app: &AppHandle, key: &str, default: u64, min: u64, max: u64) -> u64 {
    crate::vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, key)
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(min, max))
        .unwrap_or(default)
}

/// Rendezvous publish interval. Re-read every round so Settings edits apply live.
/// Default + clamp bounds come from build_config.yaml (settings section).
fn room_publish_secs(app: &AppHandle) -> u64 {
    use crate::build_config::settings as s;
    setting_secs(
        app,
        "dht_room_publish_secs",
        s::DHT_ROOM_PUBLISH_DEFAULT_SECS,
        s::DHT_ROOM_PUBLISH_MIN_SECS,
        s::DHT_ROOM_PUBLISH_MAX_SECS,
    )
}

/// The user-set connect deadline (same value the frontend's join window uses —
/// see technology.md §15: never hardcode a connect deadline). Bounds how long
/// the rendezvous resolver keeps retrying after a ticketless join.
/// Default + clamp bounds come from build_config.yaml (settings section).
pub fn connect_timeout_secs(app: &AppHandle) -> u64 {
    use crate::build_config::settings as s;
    setting_secs(
        app,
        "connect_timeout_secs",
        s::CONNECT_TIMEOUT_DEFAULT_SECS,
        s::CONNECT_TIMEOUT_MIN_SECS,
        s::CONNECT_TIMEOUT_MAX_SECS,
    )
}

/// Opt-in "findable by nickname" toggle (Contacts tab). Missing key ⇒ the
/// build-config default; inert in a build without the DHT or without hosted
/// relays, and in Tor mode (nothing to announce — see `discovery_enabled`).
///
/// Redundant with `discovery_enabled` in practice — the publisher it guards can
/// only be spawned when that returned true — but kept honest so the function
/// answers its own question when read in isolation.
pub fn nick_publish_enabled(app: &AppHandle) -> bool {
    if !crate::build_config::dht::ENABLED {
        return false;
    }
    if !crate::build_config::p2p::ALLOW_HOSTED_RELAYS {
        return false;
    }
    if tor_exclusive(app) {
        return false;
    }
    match crate::vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, "dht_nick_publish") {
        Some(v) => v == "on",
        None => crate::build_config::features::DHT_NICK_PUBLISH_DEFAULT,
    }
}

/// The user's public nickname (display form). Empty/missing ⇒ nothing publishes.
pub fn nickname(app: &AppHandle) -> String {
    crate::vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, "dht_nickname")
        .map(|n| n.trim().to_string())
        .unwrap_or_default()
}

// ── protocol constants (spec: technology.md §12) ───────────────────────────────────────────

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

/// Seal a plaintext for the DHT: random 12-byte nonce ‖ ChaCha20-Poly1305.
/// Shared by room rendezvous records and nickname-directory records.
fn seal(enc_key: &[u8; 32], plaintext: &[u8]) -> Option<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(enc_key));
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let sealed = cipher.encrypt(&nonce, plaintext).ok()?;
    let mut value = nonce.to_vec();
    value.extend_from_slice(&sealed);
    Some(value)
}

fn open(enc_key: &[u8; 32], value: &[u8]) -> Option<Vec<u8>> {
    if value.len() < 12 {
        return None;
    }
    let (nonce, sealed) = value.split_at(12);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(enc_key));
    cipher.decrypt(Nonce::from_slice(nonce), sealed).ok()
}

fn encode_record(enc_key: &[u8; 32], record: &Record) -> Option<Vec<u8>> {
    seal(enc_key, &postcard::to_stdvec(record).ok()?)
}

fn decode_record(enc_key: &[u8; 32], value: &[u8]) -> Option<Record> {
    let record: Record = postcard::from_bytes(&open(enc_key, value)?).ok()?;
    (record.v == RECORD_VERSION).then_some(record)
}

// ── DHT handle ───────────────────────────────────────────────────────────────────

/// One extra Mainline node (client mode, community bootstrap) for the rendezvous
/// and presence queries. iroh's DhtAddressLookup runs its own — two UDP sockets
/// while the toggle is on, accepted in technology.md §12. Clones share the same node.
#[derive(Clone)]
pub struct DhtHandle {
    dht: AsyncDht,
}

impl DhtHandle {
    pub fn new() -> Result<Self> {
        Self::from_builder(&Dht::builder())
    }

    /// Seam for tests: the testnet e2e tests point this at a local
    /// `mainline::Testnet` instead of the public bootstrap nodes.
    fn from_builder(builder: &mainline::DhtBuilder) -> Result<Self> {
        let dht = builder.build().map_err(|e| anyhow!("mainline dht bind failed: {e}"))?;
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

// ── nickname directory ("find people" — see technology.md §12) ─────────────────────────────

/// BEP44 salt for nickname records — domain-separates them from room records.
const NICK_SALT: &[u8] = b"enigma-nick-v1";
/// Claimed display names are capped so a record can never approach the BEP44
/// value limit (and so the UI stays sane).
const NICK_NAME_MAX_CHARS: usize = 64;

/// The lookup key: exact spelling matters (documented in the UI), but case and
/// surrounding whitespace don't. Mirrored by the frontend's trim/toLowerCase.
pub fn normalize_nick(nick: &str) -> String {
    nick.trim().to_lowercase()
}

/// STATIC derivation (unlike hourly room keys): a nickname must resolve for as
/// long as its owner keeps publishing. Anyone who knows the name derives the
/// same keypair — multi-writer claims, exactly like the room rendezvous.
fn derive_nick_signing_key(normalized: &str) -> SigningKey {
    SigningKey::from_bytes(&blake3::derive_key("enigma/dht/nick-sign/v1", normalized.as_bytes()))
}

fn derive_nick_enc_key(normalized: &str) -> [u8; 32] {
    blake3::derive_key("enigma/dht/nick-enc/v1", normalized.as_bytes())
}

/// A nickname claim: "this NodeId answers to this name". Sealed with the
/// nick-derived key, so only someone searching this exact name can read it.
#[derive(Serialize, Deserialize)]
struct NickRecord {
    v: u8,
    node_id: [u8; 32],
    /// Display form as the owner typed it (the lookup key is the normalized form).
    name: String,
    ts: u64,
}

fn encode_nick_record(enc_key: &[u8; 32], record: &NickRecord) -> Option<Vec<u8>> {
    let mut capped = NickRecord {
        v: record.v,
        node_id: record.node_id,
        name: record.name.clone(),
        ts: record.ts,
    };
    if capped.name.chars().count() > NICK_NAME_MAX_CHARS {
        capped.name = capped.name.chars().take(NICK_NAME_MAX_CHARS).collect();
    }
    seal(enc_key, &postcard::to_stdvec(&capped).ok()?)
}

fn decode_nick_record(enc_key: &[u8; 32], value: &[u8]) -> Option<NickRecord> {
    let record: NickRecord = postcard::from_bytes(&open(enc_key, value)?).ok()?;
    (record.v == RECORD_VERSION && record.name.chars().count() <= NICK_NAME_MAX_CHARS)
        .then_some(record)
}

impl DhtHandle {
    /// Search the nickname directory: every fresh claim on `nick`, deduped by
    /// NodeId (keeping each claimant's freshest record). Results are CLAIMS —
    /// the caller shows fingerprints; nothing here implies verified identity.
    pub async fn find_nick(&self, nick: &str) -> Vec<(EndpointId, String, u64)> {
        let normalized = normalize_nick(nick);
        if normalized.is_empty() {
            return Vec::new();
        }
        let signing = derive_nick_signing_key(&normalized);
        let enc = derive_nick_enc_key(&normalized);
        let public_key = signing.verifying_key().to_bytes();
        let now = now_secs();

        let mut freshest: HashMap<[u8; 32], NickRecord> = HashMap::new();
        let mut stream = self.dht.get_mutable(&public_key, Some(NICK_SALT), None);
        while let Some(item) = stream.next().await {
            let Some(record) = decode_nick_record(&enc, item.value()) else { continue };
            if now.saturating_sub(record.ts) > RECORD_FRESH_SECS {
                continue;
            }
            match freshest.get(&record.node_id) {
                Some(existing) if existing.ts >= record.ts => {}
                _ => {
                    freshest.insert(record.node_id, record);
                }
            }
        }
        let mut claims: Vec<(EndpointId, String, u64)> = freshest
            .into_values()
            .filter_map(|r| Some((EndpointId::from_bytes(&r.node_id).ok()?, r.name, r.ts)))
            .collect();
        // Freshest claim first — a stable order for the results list.
        claims.sort_by(|a, b| b.2.cmp(&a.2));
        claims
    }
}

/// One immediate claim publish — the Contacts "Publish" button awaits this so
/// its spinner reflects a REAL `put_mutable` reaching the DHT's storage nodes,
/// and "name published" is a confirmation, not a hope. Errors surface to the UI.
pub async fn publish_nick_once(app: &AppHandle, dht: &AsyncDht, self_id: EndpointId) -> Result<()> {
    let name = nickname(app);
    if name.is_empty() {
        return Err(anyhow!("set a nickname first"));
    }
    let normalized = normalize_nick(&name);
    let now = now_secs();
    let record = NickRecord { v: RECORD_VERSION, node_id: *self_id.as_bytes(), name, ts: now };
    let value = encode_nick_record(&derive_nick_enc_key(&normalized), &record)
        .ok_or_else(|| anyhow!("failed to encode the claim"))?;
    let item = MutableItem::new(
        derive_nick_signing_key(&normalized),
        &value,
        now as i64,
        Some(NICK_SALT),
    );
    dht.put_mutable(item, None).await.map_err(|e| anyhow!("publish failed: {e}"))?;
    Ok(())
}

/// Keep this node findable by nickname: refresh the claim every announce
/// interval while the node runs. Settings are re-read every round, so renames
/// apply on the next round and turning the toggle off stops publishing without
/// a rebind (the record then ages out of the DHT in ~1–2 h).
pub fn spawn_nick_publisher(
    app: AppHandle,
    dht: AsyncDht,
    self_id: EndpointId,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            if nick_publish_enabled(&app) {
                // Refresh failures are non-fatal; the next round retries.
                let _ = publish_nick_once(&app, &dht, self_id).await;
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

    #[test]
    fn encoding_twice_yields_distinct_ciphertexts_that_both_decode() {
        // Random nonces: identical plaintext must never seal to identical bytes
        // (otherwise DHT observers could correlate members across publishes).
        let enc = derive_enc_key(&SECRET, 3);
        let record = Record { v: RECORD_VERSION, node_id: [4u8; 32], peers: vec![], ts: 99 };
        let a = encode_record(&enc, &record).expect("encode a");
        let b = encode_record(&enc, &record).expect("encode b");
        assert_ne!(a, b);
        assert!(decode_record(&enc, &a).is_some());
        assert!(decode_record(&enc, &b).is_some());
    }

    #[test]
    fn buckets_rotate_hourly_and_readers_cover_the_boundary() {
        assert_eq!(bucket_of(0), 0);
        assert_eq!(bucket_of(BUCKET_SECS - 1), 0);
        assert_eq!(bucket_of(BUCKET_SECS), 1);
        // A record published at the end of bucket N is found by a reader in
        // bucket N+1 (readers query b and b-1) and only ages out past the
        // freshness window.
        let published_at = 5 * BUCKET_SECS - 1;
        let read_at = 5 * BUCKET_SECS + 1;
        assert_eq!(bucket_of(read_at) - 1, bucket_of(published_at));
        assert!(read_at - published_at <= RECORD_FRESH_SECS);
    }

    #[test]
    fn nick_normalization_folds_case_and_whitespace_only() {
        assert_eq!(normalize_nick("  Alice-Dev "), "alice-dev");
        assert_eq!(normalize_nick("ŻÓŁW"), "żółw"); // Unicode-aware lowercase
        assert_ne!(normalize_nick("alice"), normalize_nick("alicę")); // spelling matters
        assert_eq!(normalize_nick("   "), "");
    }

    #[test]
    fn nick_record_round_trips_only_with_the_right_name() {
        let enc = derive_nick_enc_key("alice-dev");
        let record = NickRecord {
            v: RECORD_VERSION,
            node_id: [3u8; 32],
            name: "Alice-Dev".into(),
            ts: 777,
        };
        let value = encode_nick_record(&enc, &record).expect("encode");
        let decoded = decode_nick_record(&enc, &value).expect("decode");
        assert_eq!(decoded.node_id, [3u8; 32]);
        assert_eq!(decoded.name, "Alice-Dev");

        // Searching a different name derives a different key ⇒ unreadable.
        let wrong = derive_nick_enc_key("alice");
        assert!(decode_nick_record(&wrong, &value).is_none());
        assert!(decode_nick_record(&enc, b"garbage").is_none());
    }

    #[test]
    fn nick_claims_are_capped_and_stay_under_bep44() {
        let enc = derive_nick_enc_key("x");
        let record = NickRecord {
            v: RECORD_VERSION,
            node_id: [1u8; 32],
            name: "n".repeat(500),
            ts: 1,
        };
        let value = encode_nick_record(&enc, &record).expect("encode");
        assert!(value.len() < 1000, "BEP44 caps values at 1000 B, got {}", value.len());
        let decoded = decode_nick_record(&enc, &value).expect("decode");
        assert_eq!(decoded.name.chars().count(), NICK_NAME_MAX_CHARS);
    }

    #[test]
    fn nick_keys_never_collide_with_room_keys() {
        // A room secret that happens to equal a nickname's bytes must still
        // derive different DHT targets (separate derivation contexts + salts).
        let nick_pk = derive_nick_signing_key("aaaa").verifying_key().to_bytes();
        let mut secret = [0u8; 32];
        secret[..4].copy_from_slice(b"aaaa");
        let room_pk = derive_signing_key(&secret, 0).verifying_key().to_bytes();
        assert_ne!(nick_pk, room_pk);
        assert_ne!(NICK_SALT, RENDEZVOUS_SALT);
    }

    // ── e2e over a local Kademlia testnet (no public DHT, no network) ────────────
    //
    // `mainline::Testnet` spins up an in-process DHT swarm on loopback; these
    // tests exercise the REAL rendezvous protocol — derived signing keys, sealed
    // records, BEP44 multi-writer put/get — end to end against it.

    fn testnet_handle(testnet: &mainline::Testnet) -> DhtHandle {
        let mut builder = Dht::builder();
        builder.bootstrap(&testnet.bootstrap);
        DhtHandle::from_builder(&builder).expect("bind testnet dht")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rendezvous_round_trips_over_a_local_testnet() {
        let testnet = mainline::Testnet::new(8).expect("spawn testnet");
        let publisher = testnet_handle(&testnet);
        let joiner = testnet_handle(&testnet);

        // A real ed25519 identity — resolve validates EndpointId parsing.
        let member_id = iroh::SecretKey::generate().public();
        let secret: [u8; 32] = [9u8; 32];
        let now = now_secs();
        let bucket = bucket_of(now);
        let record =
            Record { v: RECORD_VERSION, node_id: *member_id.as_bytes(), peers: vec![], ts: now };
        let value = encode_record(&derive_enc_key(&secret, bucket), &record).expect("encode");
        let item = MutableItem::new(
            derive_signing_key(&secret, bucket),
            &value,
            now as i64,
            Some(RENDEZVOUS_SALT),
        );
        publisher.dht.put_mutable(item, None).await.expect("publish rendezvous record");

        // Secret-holder finds the member…
        let found = joiner.resolve_room_peers(&secret, None).await;
        assert!(found.contains(&member_id), "joiner should resolve the published member");

        // …the member's own resolve excludes itself…
        let excluded = joiner.resolve_room_peers(&secret, Some(member_id)).await;
        assert!(!excluded.contains(&member_id));

        // …and a different secret derives a different rendezvous: nothing there.
        let other = joiner.resolve_room_peers(&[1u8; 32], None).await;
        assert!(other.is_empty(), "wrong secret must not find the room");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stale_rendezvous_records_are_ignored() {
        let testnet = mainline::Testnet::new(8).expect("spawn testnet");
        let handle = testnet_handle(&testnet);

        let member_id = iroh::SecretKey::generate().public();
        let secret: [u8; 32] = [8u8; 32];
        let now = now_secs();
        let bucket = bucket_of(now);
        // Fresh signature/key (current bucket) but a plaintext timestamp past
        // the freshness window — a member that stopped publishing long ago.
        let stale_ts = now - RECORD_FRESH_SECS - 60;
        let record =
            Record { v: RECORD_VERSION, node_id: *member_id.as_bytes(), peers: vec![], ts: stale_ts };
        let value = encode_record(&derive_enc_key(&secret, bucket), &record).expect("encode");
        let item = MutableItem::new(
            derive_signing_key(&secret, bucket),
            &value,
            now as i64,
            Some(RENDEZVOUS_SALT),
        );
        handle.dht.put_mutable(item, None).await.expect("publish stale record");

        let found = handle.resolve_room_peers(&secret, None).await;
        assert!(found.is_empty(), "stale records must not resolve");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nickname_search_round_trips_over_a_local_testnet() {
        let testnet = mainline::Testnet::new(8).expect("spawn testnet");
        let publisher = testnet_handle(&testnet);
        let searcher = testnet_handle(&testnet);

        let owner_id = iroh::SecretKey::generate().public();
        let normalized = normalize_nick(" Alice-Dev ");
        let now = now_secs();
        let record = NickRecord {
            v: RECORD_VERSION,
            node_id: *owner_id.as_bytes(),
            name: "Alice-Dev".into(),
            ts: now,
        };
        let value =
            encode_nick_record(&derive_nick_enc_key(&normalized), &record).expect("encode");
        let item = MutableItem::new(
            derive_nick_signing_key(&normalized),
            &value,
            now as i64,
            Some(NICK_SALT),
        );
        publisher.dht.put_mutable(item, None).await.expect("publish nick claim");

        // Search normalizes too: differently-cased/spaced input finds the claim.
        let claims = searcher.find_nick("alice-dev").await;
        assert!(
            claims.iter().any(|(id, name, _)| *id == owner_id && name == "Alice-Dev"),
            "searcher should find the published claim"
        );

        // A different name derives a different key — nothing there.
        assert!(searcher.find_nick("alice").await.is_empty());
        assert!(searcher.find_nick("   ").await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stale_nickname_claims_are_ignored() {
        let testnet = mainline::Testnet::new(8).expect("spawn testnet");
        let handle = testnet_handle(&testnet);

        let owner_id = iroh::SecretKey::generate().public();
        let normalized = normalize_nick("ghost");
        let now = now_secs();
        // Valid key/signature, but the claim's own timestamp is long past the
        // freshness window — an owner that stopped publishing.
        let record = NickRecord {
            v: RECORD_VERSION,
            node_id: *owner_id.as_bytes(),
            name: "ghost".into(),
            ts: now - RECORD_FRESH_SECS - 60,
        };
        let value =
            encode_nick_record(&derive_nick_enc_key(&normalized), &record).expect("encode");
        let item = MutableItem::new(
            derive_nick_signing_key(&normalized),
            &value,
            now as i64,
            Some(NICK_SALT),
        );
        handle.dht.put_mutable(item, None).await.expect("publish stale claim");

        assert!(handle.find_nick("ghost").await.is_empty(), "stale claims must not resolve");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn presence_sees_a_fresh_pkarr_style_record() {
        let testnet = mainline::Testnet::new(8).expect("spawn testnet");
        let handle = testnet_handle(&testnet);

        // Simulate exactly what iroh's DhtAddressLookup publishes: a mutable
        // item signed with the node's own ed25519 key, salt=None, seq in µs.
        let peer_sk = iroh::SecretKey::generate();
        let peer_id = peer_sk.public();
        let signer = SigningKey::from_bytes(&peer_sk.to_bytes());
        let now_micros = (now_secs() as i64) * 1_000_000;
        let item = MutableItem::new(signer, b"addrs", now_micros, None);
        // The item lands under the NodeId — same ed25519 keypair on both sides.
        assert_eq!(item.key(), peer_id.as_bytes());
        handle.dht.put_mutable(item, None).await.expect("publish presence record");

        let unseen_id = iroh::SecretKey::generate().public();
        let presence =
            handle.presence(vec![peer_id.to_string(), unseen_id.to_string(), "junk".into()]).await;
        let get = |id: &str| presence.iter().find(|(n, _)| n == id).map(|(_, online)| *online);
        assert_eq!(get(&peer_id.to_string()), Some(true), "fresh record ⇒ recently online");
        assert_eq!(get(&unseen_id.to_string()), Some(false), "no record ⇒ offline");
        assert_eq!(get("junk"), Some(false), "unparseable id ⇒ offline, not an error");
    }
}
