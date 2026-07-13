// Peer-hosted Tor onion transport — the second P2P backend, selected by the
// "use Tor" switch (see realtime.rs / lib.rs `use_tor`).
//
// Topology is a STAR with an ELECTED CAPTAIN. EVERY member hosts its own onion
// service (and runs an accept/relay loop) and, unless it is the captain, holds ONE
// outbound dial to the current captain. The captain relays every frame it receives
// to all OTHER dialers and delivers it locally — so an MLS envelope reaches every
// member exactly as it does over iroh-gossip's broadcast. The relay only ever
// forwards MLS ciphertext; it never has the group keys. 1:1 is just the N=2 case.
//
// Why every member hosts: Tor has no discovery. If the captain dies, all star
// connections drop and there is no way to look up a replacement — you can only
// dial a `.onion` you already know. So the frontend elects a captain (lowest MLS
// identity), shares each member's `.onion` over the encrypted presence message,
// and on captain loss re-points every member's single outbound to the next
// captain's ALREADY-PUBLISHED onion via `set_captain`. This module owns only the
// mechanism (host, dial, relay, re-point); the election lives in useChatChannel.ts.
//
// This module mirrors p2p_iroh.rs's public surface and emits the SAME
// `realtime://message` / `realtime://status` events, so the frontend transport
// layer and the MLS state machine are unchanged (a captain-death event just adds
// an optional `reason:"captain_unreachable"`). Framing + handshake shape are
// modelled on limbo/rust/vox.rs (4-byte LE length prefix + JSON body).
//
// arti hosting notes: we build a per-profile state-dir client so arti's keystore
// persists each member's hidden-service identity key — relaunching the same room
// nickname yields the SAME `.onion`, which keeps an old QR valid and lets a
// re-elected captain be dialed at a stable address.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use arti_client::{config::TorClientConfigBuilder, DataStream, TorClient};
use futures_lite::StreamExt;
use safelog::DisplayRedacted;
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
/// can tell a Tor ticket from an iroh ticket (tagged `0x49`) by sniffing. 'T'.
const TOR_TAG: u8 = 0x54;
/// Cap per-frame writes so one stalled onion circuit can't block the host's
/// fan-out (or a joiner's send) forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(20);
/// Cap the join handshake read so a silent peer can't hang the join command.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// How many times the outbound connection manager retries dialing the captain
/// (with backoff) before declaring it unreachable — a slow Tor dial must not be
/// mistaken for a dead captain.
const MAX_CAPTAIN_RETRIES: u32 = 3;
/// Base backoff between captain redial attempts (doubles each attempt, capped).
const CAPTAIN_RETRY_BASE_SECS: u64 = 2;

fn captain_backoff(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(3);
    Duration::from_secs((CAPTAIN_RETRY_BASE_SECS << shift).min(15))
}

/// Per-connection sequence number, distinct from the (possibly reused) peer_id.
/// Used to identify a specific joiner stream for relay fan-out + removal.
static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

// ── state ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct TorP2pState(pub Mutex<Option<Node>>);

pub struct Node {
    client: Arc<TorClient<PreferredRuntime>>,
    rooms: HashMap<String, MemberRoom>,
}

/// One Tor room from this member's view. Every member hosts its own onion + relay
/// (`_service` / `peers` / `accept_task`) and, unless it is the captain, holds one
/// outbound dial to the current captain (`up`).
///
/// Relay is a TREE rooted at the captain: a member forwards each frame from a child
/// (inbound peer) up to its parent (`up`) AND across to its other children, and each
/// frame from its parent down to all children. Parent pointers always go to a
/// strictly-lower MLS id (everyone dials the lowest-id member it knows), so the
/// graph is acyclic — the flood can't loop. This lets ANY member be an entry point:
/// a joiner that dials a non-captain (e.g. the creator's QR onion after captaincy
/// moved) is still bridged to the real captain.
struct MemberRoom {
    name: String,
    my_onion: String,
    // Keep the service alive; dropping it stops serving + descriptor publishing.
    _service: Arc<RunningOnionService>,
    // Inbound peer write-halves — our children in the relay tree.
    peers: Arc<Mutex<Vec<PeerConn>>>,
    accept_task: JoinHandle<()>,
    // Write-half to our parent (the captain), or `None` when we ARE the captain or
    // are mid-reconnect. Stable across captain changes — the connection manager
    // publishes the current stream here, and re-pointing reuses this slot.
    up: Arc<Mutex<Option<WriteHalf<DataStream>>>>,
    // The task managing the `up` connection; `None` ⇒ I am the captain (host-only).
    outbound: Option<Outbound>,
}

/// The background task dialing + reading + reconnecting the outbound to the captain.
struct Outbound {
    captain_onion: String,
    task: JoinHandle<()>,
}

#[derive(Clone)]
struct PeerConn {
    /// Unique per connection — used for fan-out exclusion + removal, so a
    /// same-device redial (same peer_id) doesn't alias a still-live stream.
    seq: u64,
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

/// `write_frame` bounded by `WRITE_TIMEOUT` — a stalled peer errors out instead of
/// blocking every other peer in a fan-out.
async fn write_frame_bounded<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<()> {
    match tokio::time::timeout(WRITE_TIMEOUT, write_frame(w, payload)).await {
        Ok(r) => r,
        Err(_) => Err(anyhow!("write timed out")),
    }
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
    // create_bootstrapped yields an Arc<TorClient> (cached for the process life).
    let client = TorClient::create_bootstrapped(cfg)
        .await
        .map_err(|e| anyhow!("tor bootstrap failed: {e}"))?;
    *guard = Some(Node {
        client,
        rooms: HashMap::new(),
    });
    Ok(())
}

async fn client_of(state: &TorP2pState) -> Result<Arc<TorClient<PreferredRuntime>>> {
    let guard = state.0.lock().await;
    Ok(guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?.client.clone())
}

/// Poll the running service for its address (the descriptor is not instant).
async fn wait_onion_address(service: &RunningOnionService) -> Result<String> {
    for _ in 0..50 {
        if let Some(id) = service.onion_address() {
            // HsId has no plain Display (redaction-safe); take the full address.
            return Ok(id.display_unredacted().to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Err(anyhow!("onion address was not ready"))
}

/// Launch this member's own onion service + accept/relay loop. Every member does
/// this (create AND join) so anyone can become the captain without a fresh
/// descriptor publish. Returns `(my_onion, service, peers, accept_task)`.
type HostParts = (
    String,                          // my_onion
    Arc<RunningOnionService>,        // service
    Arc<Mutex<Vec<PeerConn>>>,       // inbound children
    JoinHandle<()>,                  // accept task
    Arc<Mutex<Option<WriteHalf<DataStream>>>>, // `up` slot (to parent)
);

async fn host_onion(app: &AppHandle, state: &TorP2pState, room: &str, name: &str) -> Result<HostParts> {
    let client = client_of(state).await?;
    let nick = nickname_for(name)?;
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
    // `up` is created here (empty) and stays stable for the room's life; the accept
    // loop's per-peer readers bridge child frames up through it.
    let up = Arc::new(Mutex::new(None));
    let accept_task = spawn_accept_loop(app.clone(), room.to_string(), rend, peers.clone(), up.clone());
    Ok((onion, service, peers, accept_task, up))
}

/// Dial an onion and run the `Hello`/`Ready` handshake. Returns the split stream.
async fn dial_and_handshake(
    client: &Arc<TorClient<PreferredRuntime>>,
    onion: &str,
    name: &str,
    my_id: &str,
) -> Result<(ReadHalf<DataStream>, WriteHalf<DataStream>)> {
    let ds = client
        .connect((onion, ONION_PORT))
        .await
        .map_err(|e| anyhow!("tor connect to {onion} failed: {e}"))?;
    let (mut rd, mut wr) = tokio::io::split(ds);
    write_frame_bounded(
        &mut wr,
        &serde_json::to_string(&Hello { name: name.to_string(), peer_id: my_id.to_string() }).unwrap(),
    )
    .await?;
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut rd)).await {
        Ok(r) => {
            r.map_err(|e| anyhow!("handshake failed: {e}"))?;
        }
        Err(_) => return Err(anyhow!("handshake timed out")),
    }
    Ok((rd, wr))
}

/// Open a room as the initial captain and return `(room, ticket, my_onion)`.
/// Idempotent: recreating an already-open room returns the existing onion (the
/// reconnect / re-host path).
pub async fn create_room(app: &AppHandle, state: &TorP2pState, name: String) -> Result<(String, String, String)> {
    ensure_started(app, state).await?;
    let room = room_for(&name);

    // Already in this room? Return the existing onion.
    {
        let guard = state.0.lock().await;
        if let Some(node) = guard.as_ref() {
            if let Some(mr) = node.rooms.get(&room) {
                let ticket = TorTicket { onion: mr.my_onion.clone(), port: ONION_PORT, name: name.clone() }.encode();
                return Ok((room, ticket, mr.my_onion.clone()));
            }
        }
    }

    let (my_onion, service, peers, accept_task, up) = host_onion(app, state, &room, &name).await?;
    {
        let mut guard = state.0.lock().await;
        let node = guard.as_mut().ok_or_else(|| anyhow!("tor not started"))?;
        node.rooms.insert(
            room.clone(),
            MemberRoom {
                name: name.clone(),
                my_onion: my_onion.clone(),
                _service: service,
                peers,
                accept_task,
                up,
                outbound: None, // sole member ⇒ trivially the captain
            },
        );
    }
    emit_status(app, &room, "connecting", 0, None);
    let ticket = TorTicket { onion: my_onion.clone(), port: ONION_PORT, name }.encode();
    Ok((room, ticket, my_onion))
}

/// Join a room: host my own onion (so I can become captain), then dial the ticket
/// onion (the initial captain). Returns `(room, name, my_onion)`.
/// `_extra` is accepted for parity with the iroh backend but unused.
pub async fn join_room(
    app: &AppHandle,
    state: &TorP2pState,
    ticket: String,
    _extra: Vec<String>,
) -> Result<(String, String, String)> {
    ensure_started(app, state).await?;
    let t = TorTicket::decode(&ticket).map_err(|e| anyhow!("invalid tor ticket: {e}"))?;
    let room = room_for(&t.name);
    let my_id = load_or_create_peer_id(app);
    emit_status(app, &room, "connecting", 0, None);

    // Host my own onion first (failover candidate / future captain).
    let (my_onion, service, peers, accept_task, up) = host_onion(app, state, &room, &t.name).await?;

    // Dial the initial captain synchronously so a bad onion fails loudly.
    let client = client_of(state).await?;
    let (rd, wr) = dial_and_handshake(&client, &t.onion, &t.name, &my_id).await?;
    *up.lock().await = Some(wr);
    let task = spawn_captain_manager(
        app.clone(),
        room.clone(),
        t.name.clone(),
        client,
        my_id,
        t.onion.clone(),
        up.clone(),
        peers.clone(),
        Some(rd),
    );

    {
        let mut guard = state.0.lock().await;
        let node = guard.as_mut().ok_or_else(|| anyhow!("tor not started"))?;
        node.rooms.insert(
            room.clone(),
            MemberRoom {
                name: t.name.clone(),
                my_onion: my_onion.clone(),
                _service: service,
                peers,
                accept_task,
                up,
                outbound: Some(Outbound { captain_onion: t.onion.clone(), task }),
            },
        );
    }
    emit_status(app, &room, "connected", 1, Some(t.onion));
    Ok((room, t.name, my_onion))
}

/// Re-point this member's outbound dial to `captain_onion` (the elected captain).
/// Idempotent: no-op when unchanged; drops the outbound (host-only) when I am the
/// captain; aborts + redials on a change.
pub async fn set_captain(app: &AppHandle, state: &TorP2pState, room: &str, captain_onion: String) -> Result<()> {
    let my_id = load_or_create_peer_id(app);
    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("tor not started"))?;
    let client = node.client.clone();
    let mr = node.rooms.get_mut(room).ok_or_else(|| anyhow!("no such tor room"))?;

    // Unchanged captain → no-op (avoids redial blips on stable elections).
    if captain_onion != mr.my_onion {
        if let Some(out) = &mr.outbound {
            if out.captain_onion == captain_onion {
                return Ok(());
            }
        }
    }
    // Abort any existing outbound and stop sending to the old captain.
    if let Some(out) = mr.outbound.take() {
        out.task.abort();
    }
    *mr.up.lock().await = None;

    // I am the captain → host-only, no outbound (accept/relay loop already runs).
    if captain_onion == mr.my_onion {
        return Ok(());
    }
    // Otherwise dial the new captain (the manager reuses the stable `up` slot).
    let task = spawn_captain_manager(
        app.clone(),
        room.to_string(),
        mr.name.clone(),
        client,
        my_id,
        captain_onion.clone(),
        mr.up.clone(),
        mr.peers.clone(),
        None,
    );
    mr.outbound = Some(Outbound { captain_onion, task });
    Ok(())
}

/// Reconnect by name — for Tor this means "re-host" (same nickname ⇒ same onion).
/// The joiner reconnect path goes through `join_room` with the saved ticket.
pub async fn join_room_by_node(
    app: &AppHandle,
    state: &TorP2pState,
    name: String,
    _onions: Vec<String>,
) -> Result<String> {
    let (room, _ticket, _onion) = create_room(app, state, name).await?;
    Ok(room)
}

pub async fn broadcast(state: &TorP2pState, room: &str, payload: String) -> Result<()> {
    // Our own frame floods both ways in the relay tree: up to the captain (parent)
    // and down to every inbound peer (children). Snapshot handles under the lock,
    // then write after dropping it (Tor writes are slow).
    let (up, children) = {
        let guard = state.0.lock().await;
        let node = guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?;
        let mr = node.rooms.get(room).ok_or_else(|| anyhow!("no such tor room"))?;
        let up = mr.up.clone();
        let children: Vec<Arc<Mutex<WriteHalf<DataStream>>>> =
            mr.peers.lock().await.iter().map(|c| c.write.clone()).collect();
        (up, children)
    };
    // Up to the captain (None while captain / mid-reconnect ⇒ skip, best-effort).
    {
        let mut g = up.lock().await;
        if let Some(w) = g.as_mut() {
            let _ = write_frame_bounded(w, &payload).await;
        }
    }
    // Down to our children.
    for w in children {
        let mut g = w.lock().await;
        let _ = write_frame_bounded(&mut *g, &payload).await;
    }
    Ok(())
}

/// True if this backend currently owns `room` — lets the realtime layer route a
/// send to the transport that actually holds the room, not the global switch.
pub async fn has_room(state: &TorP2pState, room: &str) -> bool {
    let guard = state.0.lock().await;
    guard.as_ref().is_some_and(|node| node.rooms.contains_key(room))
}

pub async fn leave_room(state: &TorP2pState, room: &str) -> Result<()> {
    let mut guard = state.0.lock().await;
    if let Some(node) = guard.as_mut() {
        if let Some(mr) = node.rooms.remove(room) {
            mr.accept_task.abort(); // dropping _service stops serving
            if let Some(out) = mr.outbound {
                out.task.abort();
            }
        }
    }
    Ok(())
}

/// Our onion for a currently-open room, or "" (no global identity over Tor). Does
/// not bootstrap Tor — the Settings "My identity" card must not hang on this.
pub async fn node_info(_app: &AppHandle, state: &TorP2pState) -> Result<String> {
    let guard = state.0.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(mr) = node.rooms.values().next() {
            return Ok(mr.my_onion.clone());
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
        for (_, mr) in node.rooms.drain() {
            mr.accept_task.abort();
            if let Some(out) = mr.outbound {
                out.task.abort();
            }
        }
        for room in rooms {
            emit_status(app, &room, "disconnected", 0, None);
        }
        // Dropping `node` (and its client + services) closes circuits + serving.
    }
}

// ── outbound: dial the captain, read, reconnect ────────────────────────────────

/// Manages this member's single outbound connection to the captain: reads relayed
/// frames, publishes the live write-half into `write` for `broadcast`, and
/// reconnects with backoff. After `MAX_CAPTAIN_RETRIES` failed dials it emits a
/// `captain_unreachable` status so the frontend can re-elect. `initial_rd` is the
/// read half of an already-established connection (from a synchronous join); when
/// `Some`, `write` must already hold that connection's write half.
#[allow(clippy::too_many_arguments)]
fn spawn_captain_manager(
    app: AppHandle,
    room: String,
    name: String,
    client: Arc<TorClient<PreferredRuntime>>,
    my_id: String,
    captain_onion: String,
    up: Arc<Mutex<Option<WriteHalf<DataStream>>>>,
    peers: Arc<Mutex<Vec<PeerConn>>>,
    mut initial_rd: Option<ReadHalf<DataStream>>,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut attempt: u32 = 0;
        loop {
            // Acquire a read half: reuse the pre-established one, else dial fresh.
            let mut rd = match initial_rd.take() {
                Some(rd) => rd,
                None => match dial_and_handshake(&client, &captain_onion, &name, &my_id).await {
                    Ok((rd, wr)) => {
                        *up.lock().await = Some(wr);
                        rd
                    }
                    Err(_) => {
                        attempt += 1;
                        if attempt > MAX_CAPTAIN_RETRIES {
                            emit_status_reason(&app, &room, "disconnected", 0, Some(captain_onion.clone()), Some("captain_unreachable"));
                            return;
                        }
                        tokio::time::sleep(captain_backoff(attempt)).await;
                        continue;
                    }
                },
            };
            attempt = 0;
            emit_status(&app, &room, "connected", 1, Some(captain_onion.clone()));
            while let Ok(payload) = read_frame(&mut rd).await {
                emit_message(&app, &room, &payload);
                // Bridge down: fan the captain's frame to our own inbound children.
                let targets: Vec<Arc<Mutex<WriteHalf<DataStream>>>> = {
                    peers.lock().await.iter().map(|c| c.write.clone()).collect()
                };
                for w in targets {
                    let mut g = w.lock().await;
                    let _ = write_frame_bounded(&mut *g, &payload).await;
                }
            }
            // Connection dropped: stop sending, then reconnect (or declare death).
            *up.lock().await = None;
            attempt += 1;
            if attempt > MAX_CAPTAIN_RETRIES {
                emit_status_reason(&app, &room, "disconnected", 0, Some(captain_onion.clone()), Some("captain_unreachable"));
                return;
            }
            tokio::time::sleep(captain_backoff(attempt)).await;
        }
    })
}

// ── host: accept + relay ───────────────────────────────────────────────────────

fn spawn_accept_loop<S>(
    app: AppHandle,
    room: String,
    rend: S,
    peers: Arc<Mutex<Vec<PeerConn>>>,
    up: Arc<Mutex<Option<WriteHalf<DataStream>>>>,
) -> JoinHandle<()>
where
    S: futures_lite::stream::Stream<Item = RendRequest> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        // Box::pin so the returned stream is Unpin for `.next()`.
        let mut streams = Box::pin(handle_rend_requests(rend));
        // Only our own members dial this service, so accept every stream request.
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
            let seq = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
            let peer = PeerConn { seq, write };
            let count = {
                let mut p = peers.lock().await;
                p.push(peer);
                p.len() as u32
            };
            emit_status(&app, &room, "connected", count, Some(hello.peer_id));
            spawn_peer_reader(app.clone(), room.clone(), rd, peers.clone(), up.clone(), seq);
        }
    })
}

/// Per-dialer reader on the captain: deliver each frame locally AND fan it out to
/// the other dialers (star relay). On disconnect, drop the peer + update status.
fn spawn_peer_reader(
    app: AppHandle,
    room: String,
    mut rd: ReadHalf<DataStream>,
    peers: Arc<Mutex<Vec<PeerConn>>>,
    up: Arc<Mutex<Option<WriteHalf<DataStream>>>>,
    origin_seq: u64,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match read_frame(&mut rd).await {
                Ok(payload) => {
                    emit_message(&app, &room, &payload);
                    // Fan across to our OTHER children (never echo to the sender).
                    let targets: Vec<Arc<Mutex<WriteHalf<DataStream>>>> = {
                        let p = peers.lock().await;
                        p.iter().filter(|c| c.seq != origin_seq).map(|c| c.write.clone()).collect()
                    };
                    for w in targets {
                        let mut g = w.lock().await;
                        let _ = write_frame_bounded(&mut *g, &payload).await;
                    }
                    // Bridge up: if we are a relay hop (not the captain), forward the
                    // child's frame to our own parent so it reaches the real captain.
                    let mut g = up.lock().await;
                    if let Some(w) = g.as_mut() {
                        let _ = write_frame_bounded(w, &payload).await;
                    }
                }
                Err(_) => break,
            }
        }
        let count = {
            let mut p = peers.lock().await;
            if let Some(i) = p.iter().position(|c| c.seq == origin_seq) {
                p.remove(i);
            }
            p.len() as u32
        };
        let st = if count > 0 { "connected" } else { "disconnected" };
        emit_status(&app, &room, st, count, None);
    });
}

// ── events (identical shape to p2p_iroh.rs, plus an optional `reason`) ──────────

fn emit_message(app: &AppHandle, room: &str, payload: &str) {
    let _ = app.emit("realtime://message", serde_json::json!({ "room": room, "payload": payload }));
}

fn emit_status(app: &AppHandle, room: &str, state: &str, peers: u32, peer_id: Option<String>) {
    emit_status_reason(app, room, state, peers, peer_id, None);
}

/// Like `emit_status` but carries an optional `reason` (e.g. `captain_unreachable`)
/// so the frontend can distinguish a captain-death from an ordinary disconnect.
fn emit_status_reason(
    app: &AppHandle,
    room: &str,
    state: &str,
    peers: u32,
    peer_id: Option<String>,
    reason: Option<&str>,
) {
    let _ = app.emit(
        "realtime://status",
        serde_json::json!({ "room": room, "state": state, "peers": peers, "peer_id": peer_id, "reason": reason }),
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

    #[test]
    fn captain_backoff_grows_then_caps() {
        assert_eq!(captain_backoff(1), Duration::from_secs(2));
        assert_eq!(captain_backoff(2), Duration::from_secs(4));
        assert_eq!(captain_backoff(3), Duration::from_secs(8));
        assert_eq!(captain_backoff(9), Duration::from_secs(15)); // capped
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
