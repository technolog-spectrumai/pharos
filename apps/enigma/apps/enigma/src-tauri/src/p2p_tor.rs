// Peer-hosted Tor onion transport — the second P2P backend, selected by the
// "use Tor" switch (see realtime.rs / lib.rs `use_tor`).
//
// Topology is a STAR: the room CREATOR publishes one onion hidden service and
// acts as a relay; joiners DIAL the creator's `.onion` (they never host). Every
// frame a joiner sends is re-broadcast by the creator to all OTHER joiners and
// delivered locally — so an MLS envelope reaches every member exactly as it does
// over iroh-gossip's broadcast. The relay only ever forwards MLS ciphertext; it
// never has the group keys for messages it relays. 1:1 is just the N=2 case.
//
// This module mirrors p2p_iroh.rs's public surface (create_room / join_room /
// broadcast / leave_room / node_info / shutdown) and emits the SAME
// `realtime://message` / `realtime://status` events, so the frontend transport
// layer and the MLS state machine are unchanged. The framing + handshake shape
// is modelled on limbo/rust/vox.rs (4-byte LE length prefix + JSON body).
//
// arti hosting notes: we build a per-profile state-dir client so arti's keystore
// persists the hidden-service identity key — relaunching the same room nickname
// yields the SAME `.onion`, which is what keeps an old QR valid. The onion
// descriptor takes seconds to publish on first launch (slower than iroh), so the
// creator stays "connecting" until the first joiner stream is accepted.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use arti_client::{config::TorClientConfigBuilder, DataStream, TorClient};
use futures_lite::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::Mutex;
use tor_cell::relaycell::msg::Connected;
use tor_hsservice::config::OnionServiceConfigBuilder;
use tor_hsservice::{handle_rend_requests, HsNickname, RendRequest, RunningOnionService};
use tor_rtcompat::PreferredRuntime;

/// Virtual onion port every peer connects to. Fixed, and also carried in the
/// ticket so it can change later without breaking old tickets.
const ONION_PORT: u16 = 9999;
/// Frame size cap — matches iroh's `max_message_size` so MLS-encrypted images and
/// voice notes (which exceed the 64 KB vox.rs cap) fit in a single frame.
const MAX_FRAME: usize = 16 * 1024 * 1024;
/// One-byte magic prefixed before the postcard ticket bytes so the realtime layer
/// can tell a Tor ticket from a (tagless) iroh ticket by sniffing. 'T'.
const TOR_TAG: u8 = 0x54;

// ── state ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct TorP2pState(pub Mutex<Option<Node>>);

pub struct Node {
    client: Arc<TorClient<PreferredRuntime>>,
    rooms: HashMap<String, RoomHandle>,
}

enum RoomHandle {
    Host(HostRoom),
    Joiner(JoinerRoom),
}

struct HostRoom {
    onion: String,
    // Keep the service alive; dropping it stops serving + descriptor publishing.
    _service: Arc<RunningOnionService>,
    // Connected joiner write-halves — the relay fan-out set.
    peers: Arc<Mutex<Vec<PeerConn>>>,
    accept_task: JoinHandle<()>,
}

struct JoinerRoom {
    #[allow(dead_code)]
    onion: String,
    // The single stream to the creator.
    write: Arc<Mutex<WriteHalf<DataStream>>>,
    read_task: JoinHandle<()>,
}

#[derive(Clone)]
struct PeerConn {
    id: String,
    write: Arc<Mutex<WriteHalf<DataStream>>>,
}

// ── ticket ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct TorTicket {
    onion: String,
    port: u16,
    name: String,
}

impl TorTicket {
    fn encode(&self) -> String {
        let mut buf = vec![TOR_TAG];
        buf.extend_from_slice(&postcard::to_stdvec(self).expect("postcard::to_stdvec is infallible"));
        let mut text = data_encoding::BASE32_NOPAD.encode(&buf);
        text.make_ascii_lowercase();
        text
    }
    fn decode(s: &str) -> Result<Self> {
        let bytes = data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?;
        let (&tag, rest) = bytes.split_first().ok_or_else(|| anyhow!("empty ticket"))?;
        if tag != TOR_TAG {
            return Err(anyhow!("not a tor ticket"));
        }
        Ok(postcard::from_bytes(rest)?)
    }
}

/// True when `s` decodes to a Tor ticket (leading magic byte). Used by realtime.rs
/// to route a scanned ticket to the Tor backend regardless of the switch state.
pub fn ticket_is_tor(s: &str) -> bool {
    match data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes()) {
        Ok(bytes) => bytes.first() == Some(&TOR_TAG),
        Err(_) => false,
    }
}

/// Room slug — deterministic from the name so creator and joiner agree (and the
/// MLS session key `profile:room:identity` matches). A room is either iroh or
/// Tor, never both, so this need not equal iroh's topic string.
fn room_for(name: &str) -> String {
    blake3::hash(name.as_bytes()).to_hex().to_string()
}

/// Hidden-service nickname — stable per room + profile, so the keystore hands back
/// the same identity key (⇒ same `.onion`) every launch. HS nicknames have a
/// restricted charset, so derive from the name hash rather than the raw name.
fn nickname_for(name: &str) -> Result<HsNickname> {
    let hex = blake3::hash(name.as_bytes()).to_hex();
    HsNickname::new(format!("enigma_{}", &hex.as_str()[..16]))
        .map_err(|e| anyhow!("invalid hs nickname: {e}"))
}

// ── per-profile paths ─────────────────────────────────────────────────────────

fn profile_name(app: &AppHandle) -> String {
    app.try_state::<crate::AppConfigState>()
        .and_then(|s| s.lock().ok().map(|c| c.profile.clone()))
        .unwrap_or_else(|| "default".to_string())
}

/// `app_data_dir/profiles/<profile>/tor` — beside the iroh key + MLS state, so the
/// onion identity is per-profile (two dev instances ⇒ two distinct onions).
fn tor_base(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("profiles")
        .join(crate::safe_filename_component(&profile_name(app)))
        .join("tor")
}

/// Our stable presence id, sent in the join handshake. Persisted per profile so a
/// reconnecting joiner keeps the same id in the creator's presence view.
fn load_or_create_peer_id(app: &AppHandle) -> String {
    let path = tor_base(app).join("peer.id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, &id);
    id
}

// ── framing (length-prefixed JSON string bodies) ───────────────────────────────

fn frame_bytes(payload: &str) -> Vec<u8> {
    let body = payload.as_bytes();
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out
}

async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<()> {
    w.write_all(&frame_bytes(payload)).await?;
    w.flush().await?;
    Ok(())
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<String> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let n = u32::from_le_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(anyhow!("frame too large: {n} bytes"));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).await?;
    Ok(String::from_utf8(body)?)
}

// ── handshake frames ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Hello {
    name: String,
    peer_id: String,
}

#[derive(Serialize, Deserialize)]
struct Ready {
    ok: bool,
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

async fn ensure_started(app: &AppHandle, state: &TorP2pState) -> Result<()> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let base = tor_base(app);
    let state_dir = base.join("state");
    let cache_dir = base.join("cache");
    let _ = std::fs::create_dir_all(&state_dir);
    let _ = std::fs::create_dir_all(&cache_dir);
    // A per-profile on-disk state dir makes arti persist the hidden-service key in
    // its keystore, so the same room nickname resolves to the same .onion forever.
    let cfg = TorClientConfigBuilder::from_directories(state_dir, cache_dir)
        .build()
        .map_err(|e| anyhow!("tor config: {e}"))?;
    let client = TorClient::create_bootstrapped(cfg)
        .await
        .map_err(|e| anyhow!("tor bootstrap failed: {e}"))?;
    *guard = Some(Node {
        client: Arc::new(client),
        rooms: HashMap::new(),
    });
    Ok(())
}

/// Poll the running service for its address (the descriptor is not instant).
async fn wait_onion_address(service: &RunningOnionService) -> Result<String> {
    for _ in 0..50 {
        if let Some(id) = service.onion_address() {
            return Ok(id.to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Err(anyhow!("onion address was not ready"))
}

/// Open a room as the host and return `(room, ticket)`. Idempotent: recreating an
/// already-hosted room returns the existing onion (the reconnect/re-host path).
pub async fn create_room(app: &AppHandle, state: &TorP2pState, name: String) -> Result<(String, String)> {
    ensure_started(app, state).await?;
    let room = room_for(&name);

    // Already hosting this room? Return the existing ticket.
    {
        let guard = state.0.lock().await;
        if let Some(node) = guard.as_ref() {
            if let Some(RoomHandle::Host(h)) = node.rooms.get(&room) {
                let ticket = TorTicket { onion: h.onion.clone(), port: ONION_PORT, name: name.clone() }.encode();
                return Ok((room, ticket));
            }
        }
    }

    // Launch OUTSIDE the state lock — descriptor publish can take tens of seconds
    // and must not block other rooms' commands.
    let client = {
        let guard = state.0.lock().await;
        guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?.client.clone()
    };
    let nick = nickname_for(&name)?;
    let svc_cfg = OnionServiceConfigBuilder::default()
        .nickname(nick)
        .build()
        .map_err(|e| anyhow!("onion service config: {e}"))?;
    let (service, rend) = client
        .launch_onion_service(svc_cfg)
        .map_err(|e| anyhow!("launch onion service: {e}"))?
        .ok_or_else(|| anyhow!("onion service disabled in config"))?;
    let onion = wait_onion_address(&service).await?;

    let peers = Arc::new(Mutex::new(Vec::new()));
    let accept_task = spawn_accept_loop(app.clone(), room.clone(), rend, peers.clone());

    {
        let mut guard = state.0.lock().await;
        let node = guard.as_mut().ok_or_else(|| anyhow!("tor not started"))?;
        node.rooms.insert(
            room.clone(),
            RoomHandle::Host(HostRoom { onion: onion.clone(), _service: service, peers, accept_task }),
        );
    }
    emit_status(app, &room, "connecting", 0, None);
    let ticket = TorTicket { onion, port: ONION_PORT, name }.encode();
    Ok((room, ticket))
}

/// Join a room by dialing the creator's onion. Returns `(room, name)`.
/// `_extra` (persisted reconnect handles) is accepted for parity with the iroh
/// backend but unused — the onion is already in the ticket.
pub async fn join_room(
    app: &AppHandle,
    state: &TorP2pState,
    ticket: String,
    _extra: Vec<String>,
) -> Result<(String, String)> {
    ensure_started(app, state).await?;
    let t = TorTicket::decode(&ticket).map_err(|e| anyhow!("invalid tor ticket: {e}"))?;
    let room = room_for(&t.name);
    let my_id = load_or_create_peer_id(app);
    emit_status(app, &room, "connecting", 0, None);

    // Dial without holding the state lock (Tor connect is slow).
    let client = {
        let guard = state.0.lock().await;
        guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?.client.clone()
    };
    let ds = client
        .connect((t.onion.as_str(), t.port))
        .await
        .map_err(|e| anyhow!("tor connect to {} failed: {e}", t.onion))?;
    let (mut rd, mut wr) = tokio::io::split(ds);

    // Handshake: send Hello, expect Ready.
    write_frame(&mut wr, &serde_json::to_string(&Hello { name: t.name.clone(), peer_id: my_id }).unwrap()).await?;
    let _ready = read_frame(&mut rd).await.map_err(|e| anyhow!("handshake failed: {e}"))?;

    let write = Arc::new(Mutex::new(wr));
    let read_task = spawn_joiner_reader(app.clone(), room.clone(), rd);
    {
        let mut guard = state.0.lock().await;
        let node = guard.as_mut().ok_or_else(|| anyhow!("tor not started"))?;
        node.rooms.insert(
            room.clone(),
            RoomHandle::Joiner(JoinerRoom { onion: t.onion.clone(), write, read_task }),
        );
    }
    emit_status(app, &room, "connected", 1, Some(t.onion));
    Ok((room, t.name))
}

/// Reconnect by name — for Tor this means "re-host" (same nickname ⇒ same onion).
/// The joiner reconnect path goes through `join_room` with the saved ticket.
pub async fn join_room_by_node(
    app: &AppHandle,
    state: &TorP2pState,
    name: String,
    _onions: Vec<String>,
) -> Result<String> {
    let (room, _ticket) = create_room(app, state, name).await?;
    Ok(room)
}

pub async fn broadcast(state: &TorP2pState, room: &str, payload: String) -> Result<()> {
    // Collect the target write-halves, then drop the state lock before doing any
    // (slow) network writes.
    let writes: Vec<Arc<Mutex<WriteHalf<DataStream>>>> = {
        let guard = state.0.lock().await;
        let node = guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?;
        match node.rooms.get(room).ok_or_else(|| anyhow!("no such tor room"))? {
            RoomHandle::Host(h) => h.peers.lock().await.iter().map(|c| c.write.clone()).collect(),
            RoomHandle::Joiner(j) => vec![j.write.clone()],
        }
    };
    for w in writes {
        let mut g = w.lock().await;
        let _ = write_frame(&mut *g, &payload).await;
    }
    Ok(())
}

pub async fn leave_room(state: &TorP2pState, room: &str) -> Result<()> {
    let mut guard = state.0.lock().await;
    if let Some(node) = guard.as_mut() {
        if let Some(handle) = node.rooms.remove(room) {
            match handle {
                RoomHandle::Host(h) => h.accept_task.abort(), // dropping _service stops serving
                RoomHandle::Joiner(j) => j.read_task.abort(),
            }
        }
    }
    Ok(())
}

/// Our onion for a currently-hosted room, or "" (no global identity over Tor). Does
/// not bootstrap Tor — the Settings "My identity" card must not hang on this.
pub async fn node_info(_app: &AppHandle, state: &TorP2pState) -> Result<String> {
    let guard = state.0.lock().await;
    if let Some(node) = guard.as_ref() {
        for handle in node.rooms.values() {
            if let RoomHandle::Host(h) = handle {
                return Ok(h.onion.clone());
            }
        }
    }
    Ok(String::new())
}

/// Tear the whole Tor node down (airplane mode, or switching Tor off): abort every
/// room task, drop the running services, and emit a disconnected status per room.
pub async fn shutdown(app: &AppHandle, state: &TorP2pState) {
    let mut guard = state.0.lock().await;
    if let Some(mut node) = guard.take() {
        let rooms: Vec<String> = node.rooms.keys().cloned().collect();
        for (_, handle) in node.rooms.drain() {
            match handle {
                RoomHandle::Host(h) => h.accept_task.abort(),
                RoomHandle::Joiner(j) => j.read_task.abort(),
            }
        }
        for room in rooms {
            emit_status(app, &room, "disconnected", 0, None);
        }
        // Dropping `node` (and its client + services) closes circuits + serving.
    }
}

// ── host: accept + relay ───────────────────────────────────────────────────────

fn spawn_accept_loop<S>(
    app: AppHandle,
    room: String,
    rend: S,
    peers: Arc<Mutex<Vec<PeerConn>>>,
) -> JoinHandle<()>
where
    S: futures_lite::stream::Stream<Item = RendRequest> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        // Box::pin so the returned stream is Unpin for `.next()`.
        let mut streams = Box::pin(handle_rend_requests(rend));
        // Only our own joiners dial this service, so accept every stream request.
        while let Some(req) = streams.next().await {
            let ds = match req.accept(Connected::new_empty()).await {
                Ok(ds) => ds,
                Err(_) => continue,
            };
            let (mut rd, mut wr) = tokio::io::split(ds);
            // Handshake: read Hello, reply Ready.
            let hello = match read_frame(&mut rd).await {
                Ok(s) => match serde_json::from_str::<Hello>(&s) {
                    Ok(h) => h,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            if write_frame(&mut wr, &serde_json::to_string(&Ready { ok: true }).unwrap())
                .await
                .is_err()
            {
                continue;
            }
            let write = Arc::new(Mutex::new(wr));
            let peer = PeerConn { id: hello.peer_id.clone(), write };
            let count = {
                let mut p = peers.lock().await;
                p.push(peer);
                p.len() as u32
            };
            emit_status(&app, &room, "connected", count, Some(hello.peer_id.clone()));
            spawn_peer_reader(app.clone(), room.clone(), rd, peers.clone(), hello.peer_id);
        }
    })
}

/// Per-joiner reader on the host: deliver each frame locally AND fan it out to the
/// other joiners (star relay). On disconnect, drop the peer + update status.
fn spawn_peer_reader(
    app: AppHandle,
    room: String,
    mut rd: ReadHalf<DataStream>,
    peers: Arc<Mutex<Vec<PeerConn>>>,
    origin_id: String,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match read_frame(&mut rd).await {
                Ok(payload) => {
                    emit_message(&app, &room, &payload);
                    let targets: Vec<Arc<Mutex<WriteHalf<DataStream>>>> = {
                        let p = peers.lock().await;
                        p.iter().filter(|c| c.id != origin_id).map(|c| c.write.clone()).collect()
                    };
                    for w in targets {
                        let mut g = w.lock().await;
                        let _ = write_frame(&mut *g, &payload).await;
                    }
                }
                Err(_) => break,
            }
        }
        let count = {
            let mut p = peers.lock().await;
            if let Some(i) = p.iter().position(|c| c.id == origin_id) {
                p.remove(i);
            }
            p.len() as u32
        };
        let st = if count > 0 { "connected" } else { "disconnected" };
        emit_status(&app, &room, st, count, None);
    });
}

/// Joiner-side reader: every frame from the creator is a delivered message.
fn spawn_joiner_reader(app: AppHandle, room: String, mut rd: ReadHalf<DataStream>) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            match read_frame(&mut rd).await {
                Ok(payload) => emit_message(&app, &room, &payload),
                Err(_) => break,
            }
        }
        emit_status(&app, &room, "disconnected", 0, None);
    })
}

// ── events (identical shape to p2p_iroh.rs) ────────────────────────────────────

fn emit_message(app: &AppHandle, room: &str, payload: &str) {
    let _ = app.emit("realtime://message", serde_json::json!({ "room": room, "payload": payload }));
}

fn emit_status(app: &AppHandle, room: &str, state: &str, peers: u32, peer_id: Option<String>) {
    let _ = app.emit(
        "realtime://status",
        serde_json::json!({ "room": room, "state": state, "peers": peers, "peer_id": peer_id }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tor_ticket_round_trips_and_is_tagged() {
        let t = TorTicket { onion: "abcd1234.onion".to_string(), port: 9999, name: "general".to_string() };
        let encoded = t.encode();
        assert_eq!(encoded, encoded.to_ascii_lowercase());
        assert!(ticket_is_tor(&encoded));

        let decoded = TorTicket::decode(&encoded).expect("decode our own ticket");
        assert_eq!(decoded.onion, "abcd1234.onion");
        assert_eq!(decoded.port, 9999);
        assert_eq!(decoded.name, "general");
    }

    #[test]
    fn ticket_is_tor_rejects_iroh_and_garbage() {
        // Garbage / non-base32.
        assert!(!ticket_is_tor("not a valid ticket!!!"));
        assert!(!ticket_is_tor(""));
        // A base32 blob whose first byte is not the tag (an iroh-style tagless
        // ticket) must not be mistaken for Tor.
        let iroh_like = data_encoding::BASE32_NOPAD.encode(&[0u8, 1, 2, 3]).to_ascii_lowercase();
        assert!(!ticket_is_tor(&iroh_like));
    }

    #[test]
    fn decode_rejects_wrong_tag() {
        let mut bytes = vec![0x00u8]; // wrong tag
        bytes.extend_from_slice(
            &postcard::to_stdvec(&TorTicket { onion: "x".into(), port: 1, name: "n".into() }).unwrap(),
        );
        let s = data_encoding::BASE32_NOPAD.encode(&bytes).to_ascii_lowercase();
        assert!(TorTicket::decode(&s).is_err());
    }

    #[test]
    fn room_and_nickname_are_deterministic() {
        assert_eq!(room_for("room-a"), room_for("room-a"));
        assert_ne!(room_for("room-a"), room_for("room-b"));
        let n1 = nickname_for("room-a").unwrap();
        let n2 = nickname_for("room-a").unwrap();
        assert_eq!(n1.to_string(), n2.to_string());
    }

    #[tokio::test]
    async fn frame_round_trips_through_a_buffer() {
        let payload = r#"{"type":"mls_app","cipher":"…"}"#;
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, payload).await.unwrap();
        // Trailing bytes after a frame must be ignored by the reader.
        buf.extend_from_slice(b"leftover");

        let mut cursor = std::io::Cursor::new(buf);
        let got = read_frame(&mut cursor).await.unwrap();
        assert_eq!(got, payload);
    }

    #[tokio::test]
    async fn read_frame_rejects_oversized_length() {
        // A length prefix above MAX_FRAME must be rejected without allocating it.
        let mut buf = ((MAX_FRAME as u32) + 1).to_le_bytes().to_vec();
        buf.extend_from_slice(b"body");
        let mut cursor = std::io::Cursor::new(buf);
        assert!(read_frame(&mut cursor).await.is_err());
    }
}
