// Device linking — pair a second device to this profile over a direct iroh QUIC
// connection (file_xfer.rs pattern: dedicated ephemeral endpoint, custom ALPN,
// length-prefixed JSON control frames), then hand it everything it needs to act
// as the same user: identity, link key, device registry, personas, the synced kv
// subset (contacts / rooms / meetings / settings allow-list) and the stored
// per-room chat logs.
//
// Protocol (joiner = the NEW device, host = the primary showing the QR):
//   1. Host `devlink_pair_begin` binds an ephemeral endpoint (ALPN
//      `enigma/devlink/0`), mints a one-time 32-byte secret and returns the
//      pairing ticket `base32(0x4C ++ postcard{v, addr, secret})` — the QR.
//   2. Joiner `devlink_pair_join` dials (deadline = the user's Settings
//      `connect_timeout_secs` — never a literal) and sends `hello` with a
//      keyed-BLAKE3 proof of the secret. The secret is dropped after the first
//      verified hello and expires with `devlink_pair_window_secs`.
//   3. The host UI must confirm (`devlink://request` → `devlink_pair_confirm`)
//      before anything is sent — the human backstop against a photographed QR.
//   4. Host streams: bundle frame, then per-room history frames (chunked), then
//      done; joiner acks with one byte. Progress rides `devlink://progress`.
//
// Security posture: the QUIC channel is E2E-encrypted and the host is
// authenticated by the NodeId inside the ticket; the joiner by the secret
// proof. Per-device key material (iroh/Tor/MLS keys) NEVER transfers — the new
// device mints its own and joins rooms as its own MLS leaf ("user#dev-xxxxxxxx").
// The registry MAC is finalized by the frontend (single HMAC implementation in
// TS); Rust writes it with an empty `mac`.
//
// Network policy: iroh-only, so airplane mode and Tor-exclusive mode both block
// pairing (file_xfer.rs precedent — a direct QUIC dial would leak the IP).

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex};

use crate::file_xfer::OFFLINE_BLOCKED;
use crate::{active_config, load_profile_state, save_profile_state, AppConfigState};

const DEVLINK_ALPN: &[u8] = b"enigma/devlink/0";
const TICKET_TAG: u8 = 0x4C; // 'L' — marks a pairing ticket apart from room tickets
const DEVLINK_VERSION: u8 = 1;

pub(crate) const DEVLINK_DISABLED: &str = "Device linking is disabled in this build.";
const TOR_BLOCKED: &str = "Device linking is unavailable in Tor mode.";
const VAULT_LOCKED: &str = "Unlock this profile before linking devices.";

/// Control frames stay small; bundle/history frames carry media data URLs and
/// use the wire-wide cap.
const CONTROL_FRAME_MAX: usize = 64 * 1024;
const DATA_FRAME_MAX: usize = crate::build_config::network::MAX_FRAME_BYTES;
/// Messages per history frame (mirrors deviceSyncModel DLINK_HISTORY_CHUNK_MAX_MSGS).
const HISTORY_CHUNK_MSGS: usize = 100;
/// Messages per stored chat:log segment (mirrors deviceSyncModel CHAT_LOG_SEG_MAX_MSGS).
const LOG_SEG_MSGS: usize = 100;

/// The kv entries that replicate between linked devices — the Rust mirror of
/// deviceSyncModel's DEVLINK_SYNC_KV (a pinning test on each side keeps them
/// from drifting). Everything else is deliberately device-local.
pub(crate) const SYNC_KV: &[(&str, &str, &str)] = &[
    ("contacts", "default", ""),
    ("p2p:rooms", "default", ""),
    ("meetings", "default", ""),
    ("meetings", "default", "polls"),
    ("p2p:settings", "default", "max_file_size_mb"),
    ("p2p:settings", "default", "meeting_reminder_mins"),
    ("p2p:settings", "default", "file_key_rotation_days"),
    ("p2p:settings", "default", "dht_room_publish_secs"),
];

// ── policy gates ─────────────────────────────────────────────────────────────

fn offline(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg)))
}

fn use_tor(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_use_tor(&load_profile_state(app, &cfg)))
}

fn check_policy(app: &AppHandle, config: &State<'_, AppConfigState>) -> Result<(), String> {
    if !crate::build_config::devices::ALLOW_LINKING {
        return Err(DEVLINK_DISABLED.to_string());
    }
    if offline(app, config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    if use_tor(app, config) {
        return Err(TOR_BLOCKED.to_string());
    }
    Ok(())
}

fn ensure_unlocked(app: &AppHandle) -> Result<(), String> {
    let st = app
        .try_state::<crate::vault::ProtasiusState>()
        .ok_or_else(|| VAULT_LOCKED.to_string())?;
    let unlocked = st.0.lock().map_err(|e| e.to_string())?.status().unlocked;
    if unlocked { Ok(()) } else { Err(VAULT_LOCKED.to_string()) }
}

// ── ticket + key derivation ──────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct PairTicket {
    v: u8,
    addr: EndpointAddr,
    secret: [u8; 32],
}

fn encode_ticket(t: &PairTicket) -> String {
    let mut bytes = vec![TICKET_TAG];
    bytes.extend(postcard::to_stdvec(t).expect("postcard::to_stdvec is infallible"));
    let mut text = data_encoding::BASE32_NOPAD.encode(&bytes);
    text.make_ascii_lowercase();
    text
}

fn decode_ticket(s: &str) -> Result<PairTicket> {
    let bytes = data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?;
    let Some((&tag, rest)) = bytes.split_first() else {
        return Err(anyhow!("empty ticket"));
    };
    if tag != TICKET_TAG {
        return Err(anyhow!("not a device-pairing ticket"));
    }
    let t: PairTicket = postcard::from_bytes(rest)?;
    if t.v != DEVLINK_VERSION {
        return Err(anyhow!("unsupported pairing ticket version {}", t.v));
    }
    Ok(t)
}

fn pair_key(secret: &[u8; 32]) -> [u8; 32] {
    blake3::derive_key("enigma/devlink/v1/pair", secret)
}

fn hello_proof(secret: &[u8; 32], nonce: &str, device_id: &str, node_id: &str) -> String {
    let msg = format!("{nonce}|{device_id}|{node_id}");
    blake3::keyed_hash(&pair_key(secret), msg.as_bytes())
        .to_hex()
        .to_string()
}

/// The hidden device-room name, derived from the link key (unguessable topic).
/// TS never computes this — it travels in the bundle / dlink_rekey payloads.
fn devlink_room_name(link_key: &[u8; 32]) -> String {
    let hash = blake3::derive_key("enigma/devlink/v1/room", link_key);
    format!("devlink-{}", data_encoding::HEXLOWER.encode(&hash))
}

/// 8-char a-z2-7 suffix from the first 5 random bytes — the new device's id and
/// the tail of its MLS leaf identity ("user#dev-<suffix>").
fn device_suffix(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    assert!(bytes.len() >= 5, "need at least 5 bytes");
    let mut acc: u64 = 0;
    let mut bits = 0u32;
    let mut out = String::with_capacity(8);
    for &b in bytes {
        acc = (acc << 8) | b as u64;
        bits += 8;
        while bits >= 5 && out.len() < 8 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
        if out.len() >= 8 {
            break;
        }
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The bare user part of an MLS identity — mirrors TS `userPartOf`. Strips a
/// rigid `#dev-<8 base32>` suffix so pairing FROM a secondary device yields
/// `alice#dev-<new>` (not `alice#dev-old#dev-new`), and the registry `user`
/// stays the bare identity everywhere.
fn user_part_of(id: &str) -> &str {
    if let Some(pos) = id.rfind("#dev-") {
        let suffix = &id[pos + 5..];
        if suffix.len() == 8 && suffix.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)) {
            return &id[..pos];
        }
    }
    id
}

/// Clamp/validate the joiner's self-reported device metadata before it enters
/// the registry — an over-long label or bogus kind would make the whole
/// registry fail `validateDeviceRegistry` on load and silently break sync.
fn sanitize_device(dev: &DeviceHello) -> (String, String, String) {
    let mut label: String = dev.label.chars().take(60).collect();
    if label.trim().is_empty() {
        label = "Linked device".into();
    }
    let kind = if dev.kind == "mobile" { "mobile" } else { "desktop" }.to_string();
    // The device id is the 8-char base32 suffix the joiner minted; reject junk.
    let id_ok = dev.device_id.len() == 8
        && dev.device_id.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b));
    let device_id = if id_ok { dev.device_id.clone() } else { device_suffix(&random_bytes32()) };
    (label, kind, device_id)
}

fn random_bytes32() -> [u8; 32] {
    // iroh's key generation is the vetted entropy source already linked in.
    SecretKey::generate().to_bytes()
}

// ── wire frames (length-prefixed JSON, file_xfer framing) ────────────────────

#[derive(Serialize, Deserialize)]
struct Hello {
    v: u8,
    proof: String,
    device: DeviceHello,
}

#[derive(Serialize, Deserialize, Clone)]
struct DeviceHello {
    device_id: String,
    label: String,
    kind: String,
    node_id: String,
    nonce: String,
}

#[derive(Serialize, Deserialize)]
struct Verdict {
    v: u8,
    status: String, // "accept" | "reject"
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Frame {
    Bundle { v: u8, bundle: LinkBundle },
    History { v: u8, room: String, chunk: u32, of: u32, msgs: Vec<serde_json::Value> },
    Done { v: u8, rooms: u32, msgs: u64 },
}

#[derive(Serialize, Deserialize)]
struct KvItem {
    ns: String,
    scope: String,
    k: String,
    val: String,
}

#[derive(Serialize, Deserialize)]
struct PersonaBundle {
    offline_profile: serde_json::Value,
    offline_profiles: serde_json::Value,
    selected_offline_profile_id: String,
}

#[derive(Serialize, Deserialize)]
struct LinkBundle {
    v: u8,
    user: String,
    link_key: String, // base64, 32 bytes
    room_name: String,
    /// TS DeviceRegistry shape with `mac: ""` — the frontend finalizes the MAC.
    registry: serde_json::Value,
    personas: PersonaBundle,
    kv_items: Vec<KvItem>,
}

fn frame_bytes<T: Serialize>(val: &T) -> Vec<u8> {
    let body = serde_json::to_vec(val).unwrap_or_default();
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

async fn write_frame<T: Serialize>(send: &mut SendStream, val: &T) -> Result<()> {
    send.write_all(&frame_bytes(val)).await?;
    Ok(())
}

async fn read_frame_capped<T: DeserializeOwned>(recv: &mut RecvStream, cap: usize) -> Result<T> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await?;
    let n = u32::from_le_bytes(len) as usize;
    if n > cap {
        return Err(anyhow!("frame too large ({n} > {cap})"));
    }
    let mut body = vec![0u8; n];
    recv.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

// ── events ───────────────────────────────────────────────────────────────────

fn emit_progress(app: &AppHandle, phase: &str, current: u64, total: u64) {
    let _ = app.emit(
        "devlink://progress",
        serde_json::json!({ "phase": phase, "current": current, "total": total }),
    );
}

fn emit_error(app: &AppHandle, message: &str) {
    let _ = app.emit("devlink://error", serde_json::json!({ "message": message }));
}

// ── state ────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct DevLinkState(pub Mutex<Option<PairingHost>>);

pub struct PairingHost {
    endpoint: Endpoint,
    _router: Router,
    session: Arc<Mutex<PairSession>>,
}

struct PairSession {
    /// One-time: taken by the first verified hello; expiry invalidates it.
    secret: Option<[u8; 32]>,
    expires_at: Instant,
    confirm: Option<oneshot::Sender<bool>>,
}

/// Tear down any pairing host (airplane/Tor toggle, profile switch, cancel).
pub async fn shutdown(state: &DevLinkState) {
    let mut guard = state.0.lock().await;
    if let Some(host) = guard.take() {
        host.endpoint.close().await;
    }
}

// ── settings ─────────────────────────────────────────────────────────────────

/// The user's pairing window (Settings kv, clamped by build config).
fn pair_window_secs(app: &AppHandle) -> u64 {
    use crate::build_config::settings as s;
    let v = crate::vault::kv_get_raw(app, "p2p:settings", "default", "devlink_pair_window_secs")
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(s::DEVLINK_PAIR_WINDOW_DEFAULT_SECS);
    v.clamp(s::DEVLINK_PAIR_WINDOW_MIN_SECS, s::DEVLINK_PAIR_WINDOW_MAX_SECS)
}

// ── link info + registry (kv `devices` namespace, TS-compatible JSON) ────────

const NS_DEVICES: &str = "devices";
const SCOPE: &str = "default";
const KEY_REGISTRY: &str = "";
const KEY_LINK: &str = "link";

#[derive(Serialize, Deserialize)]
struct LinkInfo {
    v: u8,
    #[serde(rename = "linkKey")]
    link_key: String,
    #[serde(rename = "roomName")]
    room_name: String,
    #[serde(rename = "myDeviceId")]
    my_device_id: String,
    #[serde(rename = "myLeafId")]
    my_leaf_id: String,
}

fn read_link_info(app: &AppHandle) -> Option<LinkInfo> {
    let raw = crate::vault::kv_get_raw(app, NS_DEVICES, SCOPE, KEY_LINK)?;
    serde_json::from_str(&raw).ok()
}

fn write_link_info(app: &AppHandle, info: &LinkInfo) -> Result<(), String> {
    let raw = serde_json::to_string(info).map_err(|e| e.to_string())?;
    crate::vault::kv_put_raw(app, NS_DEVICES, SCOPE, KEY_LINK, &raw)
}

fn device_entry_json(
    device_id: &str,
    label: &str,
    kind: &str,
    leaf_id: &str,
    node_id: &str,
    added_at: u64,
) -> serde_json::Value {
    serde_json::json!({
        "deviceId": device_id,
        "label": label,
        "kind": if kind == "mobile" { "mobile" } else { "desktop" },
        "leafId": leaf_id,
        "nodeId": node_id,
        "addedAt": added_at,
    })
}

/// Load the stored registry, or a fresh one seeded with this (primary) device.
fn load_or_seed_registry(app: &AppHandle, user: &str, my_node_id: &str) -> serde_json::Value {
    if let Some(raw) = crate::vault::kv_get_raw(app, NS_DEVICES, SCOPE, KEY_REGISTRY) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if v.get("devices").map(|d| d.is_array()).unwrap_or(false) {
                return v;
            }
        }
    }
    serde_json::json!({
        "v": 1,
        "user": user,
        "rev": 0,
        "devices": [device_entry_json("primary", "This device", "desktop", user, my_node_id, now_ms())],
        "mac": "",
    })
}

// ── bundle assembly (host side) ──────────────────────────────────────────────

/// Per-device fields never leave the device: `onion` is this device's Tor
/// identity for the room, `host` is who created/hosts it here.
fn strip_room_entry(entry: &mut serde_json::Value) {
    if let Some(obj) = entry.as_object_mut() {
        obj.remove("onion");
        obj.remove("host");
    }
}

fn stripped_rooms_value(raw: &str) -> String {
    let Ok(mut rooms) = serde_json::from_str::<serde_json::Value>(raw) else {
        return "[]".to_string();
    };
    if let Some(list) = rooms.as_array_mut() {
        for entry in list.iter_mut() {
            strip_room_entry(entry);
        }
    }
    rooms.to_string()
}

fn assemble_kv_items(app: &AppHandle) -> Vec<KvItem> {
    let mut items = Vec::new();
    for &(ns, scope, k) in SYNC_KV {
        let Some(raw) = crate::vault::kv_get_raw(app, ns, scope, k) else { continue };
        let val = if ns == "p2p:rooms" { stripped_rooms_value(&raw) } else { raw };
        items.push(KvItem { ns: ns.into(), scope: scope.into(), k: k.into(), val });
    }
    items
}

/// Room slugs from the saved-rooms kv — the set whose chat logs we stream.
fn room_slugs(app: &AppHandle) -> Vec<String> {
    let Some(raw) = crate::vault::kv_get_raw(app, "p2p:rooms", "default", "") else {
        return Vec::new();
    };
    let Ok(rooms) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    rooms
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|r| r.get("room").and_then(|v| v.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// The full stored log of one room (index + segments), oldest first.
fn load_room_log(app: &AppHandle, slug: &str) -> Vec<serde_json::Value> {
    let Some(raw) = crate::vault::kv_get_raw(app, "chat:log", slug, "index") else {
        return Vec::new();
    };
    let Ok(index) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(segs) = index.get("segs").and_then(|s| s.as_array()) {
        for seg in segs {
            let Some(n) = seg.get("n").and_then(|n| n.as_u64()) else { continue };
            let key = format!("seg-{n}");
            let Some(seg_raw) = crate::vault::kv_get_raw(app, "chat:log", slug, &key) else {
                continue;
            };
            if let Ok(serde_json::Value::Array(msgs)) = serde_json::from_str(&seg_raw) {
                out.extend(msgs);
            }
        }
    }
    out
}

/// Split a room's messages into history frames: ≤ HISTORY_CHUNK_MSGS msgs and a
/// soft 256 KiB serialized budget per frame (media-heavy logs split further).
fn chunk_history(room: &str, msgs: &[serde_json::Value]) -> Vec<(String, Vec<serde_json::Value>)> {
    const SOFT_BYTES: usize = 256 * 1024;
    let mut chunks: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut current: Vec<serde_json::Value> = Vec::new();
    let mut current_bytes = 0usize;
    for m in msgs {
        let sz = serde_json::to_string(m).map(|s| s.len()).unwrap_or(0);
        let would_overflow = !current.is_empty()
            && (current.len() >= HISTORY_CHUNK_MSGS || current_bytes + sz > SOFT_BYTES);
        if would_overflow {
            chunks.push(std::mem::take(&mut current));
            current_bytes = 0;
        }
        current_bytes += sz;
        current.push(m.clone());
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks.into_iter().map(|c| (room.to_string(), c)).collect()
}

// ── host: serve one pairing connection ───────────────────────────────────────

#[derive(Clone)]
struct DevlinkShared {
    app: AppHandle,
    session: Arc<Mutex<PairSession>>,
}

#[derive(Clone)]
struct DevlinkProtocol {
    shared: DevlinkShared,
}

impl std::fmt::Debug for DevlinkProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DevlinkProtocol")
    }
}

impl ProtocolHandler for DevlinkProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        if let Err(e) = self.shared.clone().serve(conn).await {
            eprintln!("[devlink] pairing ended: {e}");
            emit_error(&self.shared.app, &e.to_string());
        }
        Ok(())
    }
}

impl DevlinkShared {
    async fn serve(self, conn: Connection) -> Result<()> {
        let (mut send, mut recv) = conn.accept_bi().await?;
        let hello: Hello = read_frame_capped(&mut recv, CONTROL_FRAME_MAX).await?;

        // Redeem the one-time secret (expiry + single use), verify the proof.
        let secret = {
            let mut session = self.session.lock().await;
            if Instant::now() >= session.expires_at {
                write_frame(&mut send, &Verdict { v: DEVLINK_VERSION, status: "reject".into() }).await?;
                return Err(anyhow!("pairing window expired"));
            }
            let Some(secret) = session.secret else {
                write_frame(&mut send, &Verdict { v: DEVLINK_VERSION, status: "reject".into() }).await?;
                return Err(anyhow!("pairing secret already redeemed"));
            };
            let expected = hello_proof(&secret, &hello.device.nonce, &hello.device.device_id, &hello.device.node_id);
            if hello.v != DEVLINK_VERSION || hello.proof != expected {
                write_frame(&mut send, &Verdict { v: DEVLINK_VERSION, status: "reject".into() }).await?;
                return Err(anyhow!("pairing proof rejected"));
            }
            session.secret = None; // one-time: a second dial gets rejected above
            secret
        };
        let _ = secret; // proof consumed; nothing further derives from it

        // Human confirm on this (primary) device before anything is disclosed.
        let (tx, rx) = oneshot::channel::<bool>();
        {
            let mut session = self.session.lock().await;
            session.confirm = Some(tx);
        }
        let _ = self.app.emit(
            "devlink://request",
            serde_json::json!({
                "label": hello.device.label,
                "kind": hello.device.kind,
                "nodeId": hello.device.node_id,
                "deviceId": hello.device.device_id,
            }),
        );
        let confirm_deadline = {
            let session = self.session.lock().await;
            session.expires_at.saturating_duration_since(Instant::now())
        };
        let accepted = matches!(
            tokio::time::timeout(confirm_deadline, rx).await,
            Ok(Ok(true))
        );
        if !accepted {
            write_frame(&mut send, &Verdict { v: DEVLINK_VERSION, status: "reject".into() }).await?;
            return Err(anyhow!("pairing rejected"));
        }
        write_frame(&mut send, &Verdict { v: DEVLINK_VERSION, status: "accept".into() }).await?;

        // ── assemble + stream the bundle ─────────────────────────────────────
        let cfg = {
            let state = self.app.state::<AppConfigState>();
            let guard = state.lock().map_err(|e| anyhow!("{e}"))?;
            guard.clone()
        };
        // Always the BARE user, even when pairing from an already-linked
        // secondary (whose cfg.identity is itself "user#dev-…").
        let user = user_part_of(&cfg.identity).to_string();
        let my_node_id = crate::p2p_iroh::load_or_create_secret(&self.app, "gossip")
            .map(|sk| sk.public().to_string())
            .unwrap_or_default();
        let (dev_label, dev_kind, dev_device_id) = sanitize_device(&hello.device);

        // Link info: reuse an existing link key (N-th device joins the same
        // hidden room); mint one on first pairing.
        let (link_key_b64, room_name) = match read_link_info(&self.app) {
            Some(info) => (info.link_key, info.room_name),
            None => {
                let key = random_bytes32();
                let b64 = data_encoding::BASE64.encode(&key);
                let room = devlink_room_name(&key);
                write_link_info(
                    &self.app,
                    &LinkInfo {
                        v: DEVLINK_VERSION,
                        link_key: b64.clone(),
                        room_name: room.clone(),
                        my_device_id: "primary".into(),
                        my_leaf_id: user.clone(),
                    },
                )
                .map_err(|e| anyhow!("{e}"))?;
                (b64, room)
            }
        };

        // Registry: add/update the joiner entry, bump rev; the frontend
        // recomputes the MAC and rebroadcasts.
        let leaf_id = format!("{}#dev-{}", user, dev_device_id);
        let mut registry = load_or_seed_registry(&self.app, &user, &my_node_id);
        {
            let rev = registry.get("rev").and_then(|r| r.as_u64()).unwrap_or(0);
            let obj = registry.as_object_mut().ok_or_else(|| anyhow!("bad registry"))?;
            obj.insert("rev".into(), serde_json::json!(rev + 1));
            obj.insert("mac".into(), serde_json::json!(""));
            let devices = obj
                .get_mut("devices")
                .and_then(|d| d.as_array_mut())
                .ok_or_else(|| anyhow!("bad registry devices"))?;
            devices.retain(|d| d.get("deviceId").and_then(|i| i.as_str()) != Some(dev_device_id.as_str()));
            devices.push(device_entry_json(
                &dev_device_id,
                &dev_label,
                &dev_kind,
                &leaf_id,
                &hello.device.node_id,
                now_ms(),
            ));
        }
        crate::vault::kv_put_raw(&self.app, NS_DEVICES, SCOPE, KEY_REGISTRY, &registry.to_string())
            .map_err(|e| anyhow!("{e}"))?;

        let personas = {
            let state = load_profile_state(&self.app, &cfg);
            PersonaBundle {
                offline_profile: serde_json::to_value(&state.offline_profile)?,
                offline_profiles: serde_json::to_value(&state.offline_profiles)?,
                selected_offline_profile_id: state.selected_offline_profile_id,
            }
        };

        let bundle = LinkBundle {
            v: DEVLINK_VERSION,
            user: user.clone(),
            link_key: link_key_b64,
            room_name,
            registry: registry.clone(),
            personas,
            kv_items: assemble_kv_items(&self.app),
        };
        write_frame(&mut send, &Frame::Bundle { v: DEVLINK_VERSION, bundle }).await?;
        emit_progress(&self.app, "bundle", 1, 1);

        // History: every saved room's stored log, chunked.
        let slugs = room_slugs(&self.app);
        let mut frames: Vec<(String, Vec<serde_json::Value>)> = Vec::new();
        for slug in &slugs {
            let msgs = load_room_log(&self.app, slug);
            if !msgs.is_empty() {
                frames.extend(chunk_history(slug, &msgs));
            }
        }
        let total = frames.len() as u64;
        let mut sent_msgs: u64 = 0;
        let mut per_room_counts: std::collections::HashMap<String, (u32, u32)> = Default::default();
        for (room, _) in &frames {
            per_room_counts.entry(room.clone()).or_insert((0, 0)).1 += 1;
        }
        for (i, (room, msgs)) in frames.into_iter().enumerate() {
            let counts = per_room_counts.get_mut(&room).expect("counted above");
            counts.0 += 1;
            sent_msgs += msgs.len() as u64;
            write_frame(
                &mut send,
                &Frame::History { v: DEVLINK_VERSION, room, chunk: counts.0, of: counts.1, msgs },
            )
            .await?;
            emit_progress(&self.app, "history", (i + 1) as u64, total);
        }
        write_frame(&mut send, &Frame::Done { v: DEVLINK_VERSION, rooms: slugs.len() as u32, msgs: sent_msgs })
            .await?;
        let _ = send.finish();

        // 1-byte ack: the joiner has applied everything.
        let mut ack = [0u8; 1];
        let _ = recv.read_exact(&mut ack).await;
        let _ = self.app.emit(
            "devlink://paired",
            serde_json::json!({ "registry": registry, "leafId": leaf_id }),
        );
        Ok(())
    }
}

// ── joiner: dial, prove, apply ───────────────────────────────────────────────

fn merge_rooms_value(existing: Option<String>, incoming: &str) -> String {
    let mut base: Vec<serde_json::Value> = existing
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let incoming: Vec<serde_json::Value> =
        serde_json::from_str(incoming).unwrap_or_default();
    for room in incoming {
        let slug = room.get("room").and_then(|v| v.as_str()).map(String::from);
        let known = slug.as_ref().map(|s| {
            base.iter()
                .any(|r| r.get("room").and_then(|v| v.as_str()) == Some(s.as_str()))
        });
        if !known.unwrap_or(true) {
            base.push(room);
        }
    }
    serde_json::to_string(&base).unwrap_or_else(|_| "[]".into())
}

fn apply_bundle(app: &AppHandle, bundle: &LinkBundle, my_device_id: &str) -> Result<String, String> {
    // kv allow-list (re-checked on receive — never trust the wire).
    for item in &bundle.kv_items {
        let allowed = SYNC_KV
            .iter()
            .any(|&(ns, scope, k)| ns == item.ns && scope == item.scope && k == item.k);
        if !allowed {
            continue;
        }
        if item.ns == "p2p:rooms" {
            let existing = crate::vault::kv_get_raw(app, &item.ns, &item.scope, &item.k);
            let merged = merge_rooms_value(existing, &item.val);
            crate::vault::kv_put_raw(app, &item.ns, &item.scope, &item.k, &merged)?;
        } else {
            crate::vault::kv_put_raw(app, &item.ns, &item.scope, &item.k, &item.val)?;
        }
    }

    // Personas → this profile's state (device-local toggles untouched).
    if let Ok(cfg) = app
        .state::<AppConfigState>()
        .lock()
        .map(|g| g.clone())
        .map_err(|e| e.to_string())
    {
        let mut state = load_profile_state(app, &cfg);
        if let Ok(p) = serde_json::from_value(bundle.personas.offline_profile.clone()) {
            state.offline_profile = p;
        }
        if let Ok(p) = serde_json::from_value(bundle.personas.offline_profiles.clone()) {
            state.offline_profiles = p;
        }
        state.selected_offline_profile_id = bundle.personas.selected_offline_profile_id.clone();
        save_profile_state(app, &cfg, &state)?;
    }

    // Registry + link info (registry MAC finalized by the frontend).
    crate::vault::kv_put_raw(app, NS_DEVICES, SCOPE, KEY_REGISTRY, &bundle.registry.to_string())?;
    let leaf_id = format!("{}#dev-{}", bundle.user, my_device_id);
    write_link_info(
        app,
        &LinkInfo {
            v: DEVLINK_VERSION,
            link_key: bundle.link_key.clone(),
            room_name: bundle.room_name.clone(),
            my_device_id: my_device_id.to_string(),
            my_leaf_id: leaf_id.clone(),
        },
    )?;
    Ok(leaf_id)
}

/// Write one room's received history as a fresh chat:log (segments + index).
/// If a log already exists (re-pair), messages merge by id, ordered by ts.
fn write_room_log(app: &AppHandle, room: &str, incoming: Vec<serde_json::Value>) -> Result<(), String> {
    let mut msgs = load_room_log(app, room);
    let mut seen: std::collections::HashSet<String> = msgs
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    for m in incoming {
        let Some(id) = m.get("id").and_then(|v| v.as_str()).map(String::from) else { continue };
        if seen.insert(id) {
            msgs.push(m);
        }
    }
    msgs.sort_by(|a, b| {
        let ta = a.get("ts").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let tb = b.get("ts").and_then(|v| v.as_f64()).unwrap_or(0.0);
        ta.partial_cmp(&tb).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut segs = Vec::new();
    for (n, chunk) in msgs.chunks(LOG_SEG_MSGS).enumerate() {
        let seg_val = serde_json::Value::Array(chunk.to_vec());
        crate::vault::kv_put_raw(app, "chat:log", room, &format!("seg-{n}"), &seg_val.to_string())?;
        segs.push(serde_json::json!({ "n": n, "count": chunk.len() }));
    }
    let index = serde_json::json!({ "v": 1, "segs": segs });
    crate::vault::kv_put_raw(app, "chat:log", room, "index", &index.to_string())
}

async fn join_and_apply(app: AppHandle, ticket: PairTicket, label: String, kind: String) -> Result<()> {
    let builder = if crate::build_config::p2p::ALLOW_HOSTED_RELAYS {
        Endpoint::builder(presets::N0).relay_mode(RelayMode::Default)
    } else {
        Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled)
    };
    let endpoint = builder.bind().await.map_err(|e| anyhow!("devlink bind failed: {e}"))?;

    // Connect deadline = the user's Settings value (house rule: never a literal).
    let deadline = Duration::from_secs(crate::p2p_dht::connect_timeout_secs(&app));
    let conn = tokio::time::timeout(deadline, endpoint.connect(ticket.addr.clone(), DEVLINK_ALPN))
        .await
        .map_err(|_| anyhow!("pairing connection timed out"))??;
    let (mut send, mut recv) = conn.open_bi().await?;

    // Identity material for this NEW device: its own suffix + chat NodeId.
    let device_id = device_suffix(&random_bytes32());
    let node_id = crate::p2p_iroh::load_or_create_secret(&app, "gossip")
        .map(|sk| sk.public().to_string())
        .unwrap_or_default();
    let nonce = data_encoding::HEXLOWER.encode(&random_bytes32()[..16]);
    let proof = hello_proof(&ticket.secret, &nonce, &device_id, &node_id);
    write_frame(
        &mut send,
        &Hello {
            v: DEVLINK_VERSION,
            proof,
            device: DeviceHello {
                device_id: device_id.clone(),
                label,
                kind,
                node_id,
                nonce,
            },
        },
    )
    .await?;

    let verdict: Verdict = read_frame_capped(&mut recv, CONTROL_FRAME_MAX).await?;
    if verdict.status != "accept" {
        return Err(anyhow!("The other device declined the pairing request."));
    }
    emit_progress(&app, "accepted", 0, 0);

    let mut leaf_id = String::new();
    let mut room_name = String::new();
    let mut user = String::new();
    let mut history: std::collections::HashMap<String, Vec<serde_json::Value>> = Default::default();
    let mut frame_no: u64 = 0;
    loop {
        let frame: Frame = read_frame_capped(&mut recv, DATA_FRAME_MAX).await?;
        match frame {
            Frame::Bundle { bundle, .. } => {
                user = bundle.user.clone();
                room_name = bundle.room_name.clone();
                leaf_id = apply_bundle(&app, &bundle, &device_id).map_err(|e| anyhow!("{e}"))?;
                emit_progress(&app, "bundle", 1, 1);
            }
            Frame::History { room, msgs, chunk, of, .. } => {
                frame_no += 1;
                emit_progress(&app, "history", frame_no, 0);
                let entry = history.entry(room.clone()).or_default();
                entry.extend(msgs);
                if chunk == of {
                    let complete = history.remove(&room).unwrap_or_default();
                    write_room_log(&app, &room, complete).map_err(|e| anyhow!("{e}"))?;
                }
            }
            Frame::Done { rooms, msgs, .. } => {
                // Flush any rooms whose final chunk went missing — best effort.
                for (room, pending) in history.drain() {
                    let _ = write_room_log(&app, &room, pending);
                }
                let _ = send.write_all(&[1u8]).await;
                let _ = send.finish();
                conn.close(0u32.into(), b"done");
                endpoint.close().await;
                let _ = app.emit(
                    "devlink://done",
                    serde_json::json!({
                        "user": user, "leafId": leaf_id, "roomName": room_name,
                        "rooms": rooms, "msgs": msgs,
                    }),
                );
                return Ok(());
            }
        }
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PairBegun {
    ticket: String,
    expires_at: u64, // epoch ms
}

/// Primary: bind the pairing endpoint, mint the one-time secret, return the
/// ticket for the QR. Replaces any previous pairing session.
#[tauri::command]
pub async fn devlink_pair_begin(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    state: State<'_, DevLinkState>,
) -> Result<PairBegun, String> {
    check_policy(&app, &config)?;
    ensure_unlocked(&app)?;
    shutdown(&state).await; // one pairing at a time

    let builder = if crate::build_config::p2p::ALLOW_HOSTED_RELAYS {
        Endpoint::builder(presets::N0).relay_mode(RelayMode::Default)
    } else {
        Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled)
    };
    let endpoint = builder.bind().await.map_err(|e| format!("devlink bind failed: {e}"))?;

    let secret = random_bytes32();
    let window = Duration::from_secs(pair_window_secs(&app));
    let session = Arc::new(Mutex::new(PairSession {
        secret: Some(secret),
        expires_at: Instant::now() + window,
        confirm: None,
    }));
    let shared = DevlinkShared { app: app.clone(), session: session.clone() };
    let router = Router::builder(endpoint.clone())
        .accept(DEVLINK_ALPN, DevlinkProtocol { shared })
        .spawn();

    let ticket = encode_ticket(&PairTicket {
        v: DEVLINK_VERSION,
        addr: endpoint.addr(),
        secret,
    });
    let expires_at = now_ms() + window.as_millis() as u64;

    let mut guard = state.0.lock().await;
    *guard = Some(PairingHost { endpoint, _router: router, session });
    Ok(PairBegun { ticket, expires_at })
}

/// Primary: resolve the confirm dialog raised by `devlink://request`.
#[tauri::command]
pub async fn devlink_pair_confirm(state: State<'_, DevLinkState>, accept: bool) -> Result<(), String> {
    let guard = state.0.lock().await;
    let host = guard.as_ref().ok_or("no pairing in progress")?;
    let mut session = host.session.lock().await;
    let tx = session.confirm.take().ok_or("no pairing request pending")?;
    let _ = tx.send(accept);
    Ok(())
}

/// Primary: abort the pairing session (drops the endpoint + secret).
#[tauri::command]
pub async fn devlink_pair_cancel(state: State<'_, DevLinkState>) -> Result<(), String> {
    shutdown(&state).await;
    Ok(())
}

/// Secondary (the NEW device): dial the ticket, prove the secret, receive and
/// apply the link bundle + history. Returns once the transfer is running;
/// completion arrives as `devlink://done` (then the frontend switches identity
/// via `app_set_active_profile(profile, leafId)`).
#[tauri::command]
pub async fn devlink_pair_join(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    ticket: String,
    label: String,
    kind: String,
) -> Result<(), String> {
    check_policy(&app, &config)?;
    ensure_unlocked(&app)?;
    let ticket = decode_ticket(&ticket).map_err(|e| format!("invalid pairing ticket: {e}"))?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = join_and_apply(app2.clone(), ticket, label, kind).await {
            emit_error(&app2, &e.to_string());
        }
    });
    Ok(())
}

/// After vault unlock: if this profile is a linked device, adopt its stored
/// leaf identity ("user#dev-xxxxxxxx") as the runtime MLS identity — the
/// CHAT_USER/profile-name default would otherwise come back on every launch.
/// No transport teardown or vault relock: call it before any room/MLS session
/// exists (the unlock gate's loader path). Returns the adopted leaf id, or
/// None when this profile was never paired.
#[tauri::command]
pub fn devlink_adopt_identity(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    sessions: State<'_, crate::Sessions>,
) -> Result<Option<String>, String> {
    let Some(info) = read_link_info(&app) else { return Ok(None) };
    {
        let mut guard = config.lock().map_err(|e| e.to_string())?;
        if guard.identity == info.my_leaf_id {
            return Ok(Some(info.my_leaf_id));
        }
        guard.identity = info.my_leaf_id.clone();
    }
    if let Ok(mut s) = sessions.lock() {
        s.clear();
    }
    Ok(Some(info.my_leaf_id))
}

/// Derive the hidden room name for a link key (base64). Used by the frontend
/// when it rotates the link key on unlink (N>2 rekey) — blake3 lives here.
#[tauri::command]
pub fn devlink_derive_room(link_key: String) -> Result<String, String> {
    let bytes = data_encoding::BASE64
        .decode(link_key.as_bytes())
        .map_err(|e| format!("invalid link key: {e}"))?;
    let key: [u8; 32] = bytes.try_into().map_err(|_| "link key must be 32 bytes".to_string())?;
    Ok(devlink_room_name(&key))
}

#[derive(Serialize)]
pub struct DevlinkStatus {
    allow_linking: bool,
    pairing_active: bool,
    linked: bool,
    device_count: u32,
    my_device_id: Option<String>,
    my_leaf_id: Option<String>,
}

#[tauri::command]
pub async fn devlink_status(app: AppHandle, state: State<'_, DevLinkState>) -> Result<DevlinkStatus, String> {
    let pairing_active = state.0.lock().await.is_some();
    let link = read_link_info(&app);
    let device_count = crate::vault::kv_get_raw(&app, NS_DEVICES, SCOPE, KEY_REGISTRY)
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|reg| {
            reg.get("devices").and_then(|d| d.as_array()).map(|list| {
                list.iter()
                    .filter(|d| d.get("revokedAt").map(|r| r.is_null()).unwrap_or(true))
                    .count() as u32
            })
        })
        .unwrap_or(0);
    Ok(DevlinkStatus {
        allow_linking: crate::build_config::devices::ALLOW_LINKING,
        pairing_active,
        linked: link.is_some(),
        device_count,
        my_device_id: link.as_ref().map(|l| l.my_device_id.clone()),
        my_leaf_id: link.map(|l| l.my_leaf_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_round_trips_and_rejects_wrong_tag() {
        let sk = SecretKey::generate();
        let addr = EndpointAddr::from(sk.public());
        let t = PairTicket { v: DEVLINK_VERSION, addr, secret: [7u8; 32] };
        let encoded = encode_ticket(&t);
        assert!(encoded.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        let decoded = decode_ticket(&encoded).unwrap();
        assert_eq!(decoded.secret, [7u8; 32]);
        assert_eq!(decoded.v, DEVLINK_VERSION);
        // First tag byte marks the ticket type — a room ticket must not parse.
        assert!(decode_ticket("aaaqeay").is_err());
    }

    #[test]
    fn hello_proof_is_keyed_and_binding() {
        let secret = [1u8; 32];
        let p = hello_proof(&secret, "nonce", "abcd2345", "node-x");
        assert_eq!(p.len(), 64);
        assert_eq!(p, hello_proof(&secret, "nonce", "abcd2345", "node-x"));
        assert_ne!(p, hello_proof(&secret, "nonce", "abcd2345", "node-y"));
        assert_ne!(p, hello_proof(&[2u8; 32], "nonce", "abcd2345", "node-x"));
    }

    #[test]
    fn devlink_room_name_is_stable_and_prefixed() {
        let key = [9u8; 32];
        let a = devlink_room_name(&key);
        assert!(a.starts_with("devlink-"));
        assert_eq!(a.len(), "devlink-".len() + 64);
        assert_eq!(a, devlink_room_name(&key));
        assert_ne!(a, devlink_room_name(&[8u8; 32]));
    }

    #[test]
    fn user_part_strips_only_a_valid_dev_suffix() {
        assert_eq!(user_part_of("alice"), "alice");
        assert_eq!(user_part_of("alice#dev-abcd2345"), "alice");
        // Pairing FROM a secondary must still yield the bare user (no double suffix).
        assert_eq!(user_part_of("alice#dev-abcd2345#dev-efgh6767"), "alice#dev-abcd2345");
        // Names containing #dev- with a non-base32 / wrong-length tail are left whole.
        assert_eq!(user_part_of("bob#dev-short"), "bob#dev-short");
        assert_eq!(user_part_of("bob#dev-UPPER123"), "bob#dev-UPPER123");
        assert_eq!(user_part_of("a#b"), "a#b");
    }

    #[test]
    fn sanitize_device_clamps_label_and_validates_kind_and_id() {
        let dev = DeviceHello {
            device_id: "abcd2345".into(),
            label: "x".repeat(200),
            kind: "weird".into(),
            node_id: "n".into(),
            nonce: "n".into(),
        };
        let (label, kind, device_id) = sanitize_device(&dev);
        assert_eq!(label.chars().count(), 60);
        assert_eq!(kind, "desktop"); // unknown kind → desktop
        assert_eq!(device_id, "abcd2345"); // valid id kept
        // Blank label → default; bogus id → freshly minted valid suffix.
        let dev2 = DeviceHello {
            device_id: "NOTBASE32".into(), label: "   ".into(), kind: "mobile".into(),
            node_id: "n".into(), nonce: "n".into(),
        };
        let (label2, kind2, id2) = sanitize_device(&dev2);
        assert_eq!(label2, "Linked device");
        assert_eq!(kind2, "mobile");
        assert_eq!(id2.len(), 8);
        assert!(id2.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)));
    }

    #[test]
    fn device_suffix_is_base32_and_deterministic() {
        let s = device_suffix(&[0, 0, 0, 0, 0]);
        assert_eq!(s, "aaaaaaaa");
        let s2 = device_suffix(&[255, 255, 255, 255, 255]);
        assert_eq!(s2.len(), 8);
        assert!(s2.chars().all(|c| "abcdefghijklmnopqrstuvwxyz234567".contains(c)));
    }

    #[test]
    fn sync_kv_allow_list_is_pinned() {
        // Mirrors deviceSyncModel.DEVLINK_SYNC_KV — drift must be deliberate.
        assert_eq!(
            SYNC_KV,
            &[
                ("contacts", "default", ""),
                ("p2p:rooms", "default", ""),
                ("meetings", "default", ""),
                ("meetings", "default", "polls"),
                ("p2p:settings", "default", "max_file_size_mb"),
                ("p2p:settings", "default", "meeting_reminder_mins"),
                ("p2p:settings", "default", "file_key_rotation_days"),
                ("p2p:settings", "default", "dht_room_publish_secs"),
            ]
        );
    }

    #[test]
    fn room_entries_are_stripped_of_device_local_fields() {
        let raw = r#"[{"room":"r1","name":"Room","ticket":"t","onion":"x.onion","host":true,"peers":["n1"]}]"#;
        let stripped = stripped_rooms_value(raw);
        let v: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        let entry = &v.as_array().unwrap()[0];
        assert!(entry.get("onion").is_none());
        assert!(entry.get("host").is_none());
        assert_eq!(entry.get("room").unwrap(), "r1");
        assert_eq!(entry.get("peers").unwrap()[0], "n1");
    }

    #[test]
    fn history_chunks_respect_message_and_byte_budgets() {
        let msgs: Vec<serde_json::Value> = (0..250)
            .map(|i| serde_json::json!({ "id": format!("m{i}"), "ts": i }))
            .collect();
        let chunks = chunk_history("r1", &msgs);
        assert_eq!(chunks.len(), 3); // 100 + 100 + 50
        assert!(chunks.iter().all(|(room, c)| room == "r1" && c.len() <= HISTORY_CHUNK_MSGS));
        let total: usize = chunks.iter().map(|(_, c)| c.len()).sum();
        assert_eq!(total, 250);

        // A media-heavy message forces an early split on the byte budget.
        let big = "x".repeat(200 * 1024);
        let heavy: Vec<serde_json::Value> = (0..4)
            .map(|i| serde_json::json!({ "id": format!("b{i}"), "image_data": big }))
            .collect();
        let heavy_chunks = chunk_history("r2", &heavy);
        assert!(heavy_chunks.len() >= 2, "byte budget must split media-heavy logs");
    }

    #[test]
    fn merge_rooms_keeps_local_and_adds_missing() {
        let existing = Some(r#"[{"room":"r1","name":"Mine","ticket":"tl"}]"#.to_string());
        let incoming = r#"[{"room":"r1","name":"Theirs","ticket":"tr"},{"room":"r2","name":"New","ticket":"t2"}]"#;
        let merged = merge_rooms_value(existing, incoming);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        let list = v.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].get("name").unwrap(), "Mine"); // local wins on conflict
        assert_eq!(list[1].get("room").unwrap(), "r2");
    }
}
