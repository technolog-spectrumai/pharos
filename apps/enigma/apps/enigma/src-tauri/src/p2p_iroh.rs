// Direct peer-to-peer chat backend using iroh-gossip (QUIC) — the app's ONLY
// transport (the WebSocket relay backend was removed in the serverless rework).
//
// A room is an iroh-gossip topic (blake3 of the room name). Peers bootstrap from
// a `Ticket` (topic + name + our endpoint addresses, base32-encoded) shared out
// of band — in practice as a QR code. Reconnects after the one-time pairing go by
// persisted peer NodeIds, resolved via iroh's built-in n0 discovery. The MLS
// handshake + message protocol ride the gossip topic; any relay hop only ever
// sees MLS ciphertext.
//
// With the opt-in DHT discovery toggle (dht.md), rooms are additionally joinable
// ticketlessly from a `RoomCode` (name + rendezvous secret): member addresses
// come from the Mainline DHT via p2p_dht.rs, and the same blake3 topic keeps
// code-joiners, ticket-joiners and reconnects in one room.
//
// Emits `realtime://message` / `realtime://status` events (room-tagged), keeping
// the frontend transport-agnostic.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{anyhow, Result};
use bytes::Bytes;
use futures_lite::StreamExt;
use iroh::{
    address_lookup::{memory::MemoryLookup, pkarr::dht::DhtAddressLookup},
    endpoint::presets,
    protocol::Router,
    Endpoint, EndpointAddr, EndpointId, RelayMode, SecretKey,
};
use iroh_gossip::{
    api::{Event, GossipReceiver, GossipSender},
    net::{Gossip, GOSSIP_ALPN},
    proto::TopicId,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct P2pState(pub Mutex<Option<Node>>);

pub struct Node {
    endpoint: Endpoint,
    gossip: Gossip,
    lookup: MemoryLookup,
    _router: Router,
    rooms: HashMap<String, RoomHandle>,
    /// Mainline rendezvous/presence node — `Some` only while the Settings DHT
    /// discovery toggle is on (read at bind time; `dht_apply` rebinds).
    dht: Option<crate::p2p_dht::DhtHandle>,
    /// "Findable by nickname" announcer — runs whenever the DHT is on (each
    /// round no-ops unless the opt-in toggle is on and a nickname is set, so
    /// renames/toggles apply without a rebind). Aborted in `shutdown`.
    nick_publisher: Option<tauri::async_runtime::JoinHandle<()>>,
}

struct RoomHandle {
    sender: GossipSender,
    #[allow(dead_code)]
    name: String,
    task: tauri::async_runtime::JoinHandle<()>,
    /// Live gossip neighbors, maintained by the receive loop. Read by the
    /// rendezvous publisher (records advertise a few neighbors) and by the
    /// resolver (stops once the room has a connection).
    neighbors: Arc<StdMutex<HashSet<EndpointId>>>,
    /// DHT rendezvous publisher — running only while this room is open AND the
    /// room's secret exists (created rooms, code-joins, code-minted rooms).
    publisher: Option<tauri::async_runtime::JoinHandle<()>>,
    /// DHT rendezvous reader retrying until the room has a neighbor (code joins
    /// and reconnects); bounded by the user-set connect timeout.
    resolver: Option<tauri::async_runtime::JoinHandle<()>>,
}

// ── ticket ────────────────────────────────────────────────────────────────────

/// Leading tag byte on an iroh ticket. Distinguishes it from a Tor ticket (which
/// is tagged `0x54`) so the realtime layer can route a scanned ticket by sniffing.
/// Without this, an iroh ticket whose topic happens to start with `0x54` (~1/256)
/// would be misrouted to the Tor backend. See `p2p_tor::TOR_TAG`.
const IROH_TAG: u8 = 0x49; // 'I'

#[derive(Serialize, Deserialize)]
struct Ticket {
    topic: TopicId,
    name: String,
    peers: Vec<EndpointAddr>,
}

impl Ticket {
    fn encode(&self) -> String {
        let mut buf = vec![IROH_TAG];
        buf.extend_from_slice(&postcard::to_stdvec(self).expect("postcard::to_stdvec is infallible"));
        let mut text = data_encoding::BASE32_NOPAD.encode(&buf);
        text.make_ascii_lowercase();
        text
    }
    fn decode(s: &str) -> Result<Self> {
        let bytes = data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?;
        // Strip the tag; older untagged tickets fall back to raw postcard.
        let body = match bytes.split_first() {
            Some((&IROH_TAG, rest)) => rest,
            _ => &bytes[..],
        };
        Ok(postcard::from_bytes(body)?)
    }
}

// ── room code (ticketless join via DHT rendezvous — dht.md) ─────────────────────

/// Leading tag byte on a DHT room code, joining the `IROH_TAG 0x49` /
/// `TOR_TAG 0x54` family so the one join field routes any pasted/scanned code.
const DHT_TAG: u8 = 0x44; // 'D'

/// Ticketless-join credential: the room name (→ the SAME blake3 gossip topic
/// ticket-joiners use) plus the rendezvous secret. No addresses embedded — those
/// come from the DHT, so a code never goes stale the way a ticket's peers can.
/// It is a bearer credential (see dht.md threat notes), like the ticket itself.
#[derive(Serialize, Deserialize)]
struct RoomCode {
    name: String,
    secret: [u8; 32],
}

impl RoomCode {
    fn encode(&self) -> String {
        let mut buf = vec![DHT_TAG];
        buf.extend_from_slice(&postcard::to_stdvec(self).expect("postcard::to_stdvec is infallible"));
        let mut text = data_encoding::BASE32_NOPAD.encode(&buf);
        text.make_ascii_lowercase();
        text
    }
    fn decode(s: &str) -> Result<Self> {
        let bytes = data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?;
        match bytes.split_first() {
            Some((&DHT_TAG, body)) => Ok(postcard::from_bytes(body)?),
            _ => Err(anyhow!("not a DHT room code")),
        }
    }
}

/// Tag sniff for the realtime router (mirrors `p2p_tor::ticket_is_tor`).
pub fn code_is_dht(s: &str) -> bool {
    match data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes()) {
        Ok(bytes) => bytes.first() == Some(&DHT_TAG),
        Err(_) => false,
    }
}

fn topic_for(name: &str) -> TopicId {
    TopicId::from_bytes(*blake3::hash(name.as_bytes()).as_bytes())
}

// ── stable identity ────────────────────────────────────────────────────────────

/// Load this endpoint's persisted secret key, or generate + persist a new one. A
/// stable secret means a stable NodeId — the durable contact handle peers keep
/// after a one-time QR pairing, so reconnects work without re-scanning. Stored
/// encrypted at rest via protasius (`keys/iroh_{name}`), per profile.
pub fn load_or_create_secret(app: &AppHandle, name: &str) -> Result<SecretKey> {
    let key = format!("iroh_{name}");
    if let Ok(Some(bytes)) = crate::vault::get(app, "keys", &key) {
        if bytes.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            return Ok(SecretKey::from_bytes(&arr));
        }
    }
    let sk = SecretKey::generate();
    crate::vault::put(app, "keys", &key, &sk.to_bytes())
        .map_err(|e| anyhow!("persist iroh key: {e}"))?;
    Ok(sk)
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

async fn ensure_started(app: &AppHandle, state: &P2pState) -> Result<()> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    // Stable secret key → stable NodeId, so this gossip endpoint is a durable
    // contact handle across restarts (QR pairs once; reconnects go by NodeId).
    let secret = load_or_create_secret(app, "gossip")?;
    let lookup = MemoryLookup::new();
    let dht_enabled = crate::p2p_dht::discovery_enabled(app);
    // presets::N0 keeps iroh's built-in n0 relay + discovery (pkarr/DNS): peers
    // publish their own addresses and NodeId-only dials resolve without any app
    // server. The QR ticket (EndpointAddr) is the bootstrap; discovery is the
    // auto-refresh when addresses change later.
    let mut builder = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .address_lookup(lookup.clone()) // ticket path (QR bootstrap)
        .relay_mode(RelayMode::Default);
    if dht_enabled {
        // Mainline-DHT address lookup stacked on n0 (lookups race in parallel):
        // publishes our pkarr record to the DHT (relay addrs only, the privacy
        // default) and resolves NodeIds server-free. Secret key is inherited
        // from the endpoint by `into_address_lookup`.
        builder = builder.address_lookup(DhtAddressLookup::builder());
    }
    let endpoint = builder.bind().await.map_err(|e| anyhow!("iroh bind failed: {e}"))?;
    // Rendezvous/presence node. A bind failure here is non-fatal — chat still
    // works via ticket + n0; `dht_status` then reports unreachable.
    let dht = if dht_enabled { crate::p2p_dht::DhtHandle::new().ok() } else { None };
    let nick_publisher = dht.as_ref().map(|handle| {
        crate::p2p_dht::spawn_nick_publisher(app.clone(), handle.clone_dht(), endpoint.id())
    });
    // Raise the gossip message cap (default is a few KB) so MLS-encrypted images
    // and voice notes fit in a single broadcast.
    let gossip = Gossip::builder()
        .max_message_size(16 * 1024 * 1024)
        .spawn(endpoint.clone());
    // Direct room invites from contacts ride this same endpoint, so a contact
    // is invitable at the stable NodeId they already have saved.
    let invites = crate::p2p_invite::InviteProtocol::new(
        app.clone(),
        tauri::Manager::state::<crate::p2p_invite::InviteState>(app).inner().clone(),
    );
    let router = Router::builder(endpoint.clone())
        .accept(GOSSIP_ALPN, gossip.clone())
        .accept(crate::p2p_invite::INVITE_ALPN, invites)
        .spawn();
    *guard = Some(Node {
        endpoint,
        gossip,
        lookup,
        _router: router,
        rooms: HashMap::new(),
        dht,
        nick_publisher,
    });
    Ok(())
}

/// Subscribe to a room's gossip topic and register its handle (idempotent).
async fn open_room(
    app: &AppHandle,
    node: &mut Node,
    topic: TopicId,
    room: &str,
    name: &str,
    peer_ids: Vec<EndpointId>,
) -> Result<()> {
    if node.rooms.contains_key(room) {
        return Ok(());
    }
    let (sender, receiver) = node
        .gossip
        .subscribe(topic, peer_ids)
        .await
        .map_err(|e| anyhow!("subscribe failed: {e}"))?
        .split();
    let neighbors = Arc::new(StdMutex::new(HashSet::new()));
    let task = spawn_receiver(app.clone(), room.to_string(), receiver, neighbors.clone());
    node.rooms.insert(
        room.to_string(),
        RoomHandle {
            sender,
            name: name.to_string(),
            task,
            neighbors,
            publisher: None,
            resolver: None,
        },
    );
    Ok(())
}

/// Start the rendezvous publisher for an open room — no-op unless discovery is
/// on AND the room's secret exists (i.e. this member can serve code-joiners).
/// Idempotent; the task is aborted by `leave_room`/`shutdown`.
fn start_publisher(app: &AppHandle, node: &mut Node, room: &str) {
    let Some(dht) = node.dht.as_ref().map(|d| d.clone_dht()) else { return };
    let Some(secret) = crate::p2p_dht::load_room_secret(app, room) else { return };
    let self_id = node.endpoint.id();
    if let Some(handle) = node.rooms.get_mut(room) {
        if handle.publisher.is_none() {
            handle.publisher = Some(crate::p2p_dht::spawn_room_publisher(
                app.clone(),
                dht,
                secret,
                self_id,
                handle.neighbors.clone(),
            ));
        }
    }
}

/// Keep reading the rendezvous until the room has a live neighbor, feeding found
/// member NodeIds to gossip as extra bootstrap peers. Covers the race where the
/// other side's record hasn't propagated yet at join time. No-op without the
/// room secret / discovery.
fn start_resolver(app: &AppHandle, node: &mut Node, room: &str) {
    let Some(dht) = node.dht.clone() else { return };
    let Some(secret) = crate::p2p_dht::load_room_secret(app, room) else { return };
    let self_id = node.endpoint.id();
    if let Some(handle) = node.rooms.get_mut(room) {
        // Replace any previous attempt (a finished one gave up at its connect
        // deadline; an aborted running one just restarts its window).
        if let Some(old) = handle.resolver.take() {
            old.abort();
        }
        handle.resolver = Some(spawn_rendezvous_resolver(
            app.clone(),
            dht,
            secret,
            self_id,
            handle.sender.clone(),
            handle.neighbors.clone(),
        ));
    }
}

fn spawn_rendezvous_resolver(
    app: AppHandle,
    dht: crate::p2p_dht::DhtHandle,
    secret: [u8; 32],
    self_id: EndpointId,
    sender: GossipSender,
    neighbors: Arc<StdMutex<HashSet<EndpointId>>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        // Deadline = the user-set connect timeout (the frontend's join window
        // spans the same setting — never a hardcoded connect deadline).
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(crate::p2p_dht::connect_timeout_secs(&app));
        loop {
            if neighbors.lock().map(|s| !s.is_empty()).unwrap_or(false) {
                break;
            }
            let found = dht.resolve_room_peers(&secret, Some(self_id)).await;
            if !found.is_empty() {
                // Feeding known-but-unreached peers again is harmless; gossip
                // dials the new ones and ignores active neighbors.
                let _ = sender.join_peers(found).await;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    })
}

/// Open a room (we are the first member) and return `(room_id, ticket, code)`.
/// `code` is the ticketless-join room code — `None` while DHT discovery is off.
pub async fn create_room(
    app: &AppHandle,
    state: &P2pState,
    name: String,
) -> Result<(String, String, Option<String>)> {
    ensure_started(app, state).await?;
    let topic = topic_for(&name);
    let room = topic.to_string();

    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("p2p not started"))?;
    open_room(app, node, topic, &room, &name, vec![]).await?;
    let ticket = Ticket {
        topic,
        name: name.clone(),
        peers: vec![node.endpoint.addr()],
    }
    .encode();
    let code = if node.dht.is_some() {
        let secret = crate::p2p_dht::load_or_create_room_secret(app, &room)?;
        start_publisher(app, node, &room);
        Some(RoomCode { name, secret }.encode())
    } else {
        None
    };
    Ok((room, ticket, code))
}

/// Join a room from a ticket and return `(room_id, name)`.
///
/// `extra_peer_ids` seeds the gossip bootstrap with additional known peers (the
/// persisted NodeIds from previous sessions): the ticket's embedded addresses may
/// be stale, but a bare NodeId still resolves through n0 discovery — this is what
/// makes "pair once by QR, reconnect forever" work.
pub async fn join_room(
    app: &AppHandle,
    state: &P2pState,
    ticket: String,
    extra_peer_ids: Vec<String>,
) -> Result<(String, String)> {
    ensure_started(app, state).await?;
    let ticket = Ticket::decode(&ticket).map_err(|e| anyhow!("invalid ticket: {e}"))?;
    let topic = ticket.topic;
    let room = topic.to_string();
    let mut peer_ids = ticket.peers.iter().map(|p| p.id).collect::<Vec<_>>();
    for id in &extra_peer_ids {
        if let Ok(id) = id.parse::<EndpointId>() {
            if !peer_ids.contains(&id) {
                peer_ids.push(id);
            }
        }
    }

    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("p2p not started"))?;
    for peer in &ticket.peers {
        node.lookup.add_endpoint_info(peer.clone());
    }
    open_room(app, node, topic, &room, &ticket.name, peer_ids).await?;
    // No-op unless this room's rendezvous secret exists from an earlier
    // create/code-join — then keep the room discoverable for code-joiners.
    start_publisher(app, node, &room);
    Ok((room, ticket.name))
}

/// Ticketless join from a DHT room code (see dht.md): the code carries the room
/// name + rendezvous secret; member addresses come from the Mainline DHT. The
/// topic stays `blake3(name)`, so code-joiners land in the same room as
/// ticket-joiners and reconnects.
pub async fn join_room_by_code(
    app: &AppHandle,
    state: &P2pState,
    code: String,
) -> Result<(String, String)> {
    ensure_started(app, state).await?;
    let RoomCode { name, secret } =
        RoomCode::decode(&code).map_err(|e| anyhow!("invalid room code: {e}"))?;
    let topic = topic_for(&name);
    let room = topic.to_string();

    // Resolve OUTSIDE the state lock — a DHT lookup takes seconds and must not
    // stall other realtime commands.
    let (dht, self_id) = {
        let guard = state.0.lock().await;
        let node = guard.as_ref().ok_or_else(|| anyhow!("p2p not started"))?;
        let dht = node.dht.clone().ok_or_else(|| {
            anyhow!("DHT discovery is off — enable it in Settings to join by room code")
        })?;
        (dht, node.endpoint.id())
    };
    // Persist first: we are now a secret-holder and keep the room discoverable.
    crate::p2p_dht::store_room_secret(app, &room, &secret)?;
    let peer_ids = dht.resolve_room_peers(&secret, Some(self_id)).await;

    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("p2p not started"))?;
    // An empty bootstrap is fine: subscribe anyway — our publisher makes US
    // findable, and the resolver keeps looking until a neighbor appears.
    open_room(app, node, topic, &room, &name, peer_ids).await?;
    start_publisher(app, node, &room);
    start_resolver(app, node, &room);
    Ok((room, name))
}

/// Join a room by name, bootstrapping from peer NodeIds. Unlike `join_room`, no ticket
/// is needed — peer addresses are resolved via iroh's built-in n0 discovery. This is
/// the reconnect path after a one-time QR pairing: the app persists each room's peer
/// NodeIds and re-subscribes with them on startup.
pub async fn join_room_by_node(
    app: &AppHandle,
    state: &P2pState,
    name: String,
    peer_node_ids: Vec<String>,
) -> Result<String> {
    ensure_started(app, state).await?;
    let topic = topic_for(&name);
    let room = topic.to_string();
    let peer_ids: Vec<EndpointId> = peer_node_ids.iter().filter_map(|s| s.parse().ok()).collect();

    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("p2p not started"))?;
    open_room(app, node, topic, &room, &name, peer_ids).await?;
    // If this room has a rendezvous secret, publish + merge DHT-found members
    // into the reconnect bootstrap (non-blocking; persisted NodeIds may be
    // offline while a newer member is reachable via the rendezvous).
    start_publisher(app, node, &room);
    start_resolver(app, node, &room);
    Ok(room)
}

/// Airplane mode: tear the whole P2P node down — abort every room's receive loop,
/// close the iroh endpoint (drops the relay connection and stops discovery
/// publishing), and emit a disconnected status for each open room so the UI
/// reflects it. The next online command lazily re-binds via `ensure_started`.
pub async fn shutdown(app: &AppHandle, state: &P2pState) {
    let mut guard = state.0.lock().await;
    if let Some(mut node) = guard.take() {
        if let Some(publisher) = &node.nick_publisher {
            publisher.abort();
        }
        let rooms: Vec<String> = node.rooms.keys().cloned().collect();
        for (_, handle) in node.rooms.drain() {
            handle.task.abort();
            abort_dht_tasks(&handle);
        }
        // Best-effort graceful close; dropping the endpoint would also terminate.
        node.endpoint.close().await;
        for room in rooms {
            emit_status(app, &room, "disconnected", 0, None);
        }
    }
}

pub async fn leave_room(state: &P2pState, room: &str) -> Result<()> {
    let mut guard = state.0.lock().await;
    if let Some(node) = guard.as_mut() {
        if let Some(handle) = node.rooms.remove(room) {
            handle.task.abort();
            abort_dht_tasks(&handle);
            // dropping `sender` leaves the gossip topic
        }
    }
    Ok(())
}

/// Stop a room's DHT rendezvous tasks with it — the publisher must never keep
/// announcing a room we've left (battery + metadata).
fn abort_dht_tasks(handle: &RoomHandle) {
    if let Some(publisher) = &handle.publisher {
        publisher.abort();
    }
    if let Some(resolver) = &handle.resolver {
        resolver.abort();
    }
}

/// Direct room invite to a contact (see p2p_invite.rs): mint a fresh ticket
/// (+ code when DHT discovery is on) for the room and offer it over the invite
/// ALPN, returning the contact's answer. The frontend opens the room before
/// calling this, so an accepting invitee finds a live member for MLS admission.
pub async fn invite_send(
    app: &AppHandle,
    state: &P2pState,
    node_id: &str,
    room: &str,
    name: &str,
) -> Result<bool> {
    ensure_started(app, state).await?;
    let (endpoint, ticket, code) = {
        let mut guard = state.0.lock().await;
        let node = guard.as_mut().ok_or_else(|| anyhow!("p2p not started"))?;
        // Fresh ticket every time — the embedded addresses are ours, right now.
        let ticket = Ticket {
            topic: topic_for(name),
            name: name.to_string(),
            peers: vec![node.endpoint.addr()],
        }
        .encode();
        let code = if node.dht.is_some() {
            let secret = crate::p2p_dht::load_or_create_room_secret(app, room)?;
            start_publisher(app, node, room);
            RoomCode { name: name.to_string(), secret }.encode()
        } else {
            String::new()
        };
        (node.endpoint.clone(), ticket, code)
    };
    crate::p2p_invite::send(app, endpoint, node_id, name.to_string(), ticket, code).await
}

// ── DHT command helpers (realtime.rs `dht_*`) ───────────────────────────────────

/// `(enabled, running, bootstrapped)` for the Settings/Contacts status line.
/// With `may_start`, the probe lazily binds the node first (same start every
/// room command does) — otherwise a freshly-applied toggle would always read
/// "unreachable" purely because `dht_apply` tore the node down. `running=false`
/// then means: not allowed to start (offline/Tor) or the DHT bind failed.
pub async fn dht_status(app: &AppHandle, state: &P2pState, may_start: bool) -> (bool, bool, bool) {
    if !crate::p2p_dht::discovery_enabled(app) {
        return (false, false, false);
    }
    if may_start {
        // Bind failure is non-fatal here — it reads as not-running below.
        let _ = ensure_started(app, state).await;
    }
    let dht = { state.0.lock().await.as_ref().and_then(|n| n.dht.clone()) };
    match dht {
        Some(dht) => (true, true, dht.bootstrapped().await),
        None => (true, false, false),
    }
}

/// "Recently online" per contact NodeId, via the pkarr records DHT-enabled
/// peers publish (dht.md). Starts the node lazily like every network command.
pub async fn dht_presence(
    app: &AppHandle,
    state: &P2pState,
    node_ids: Vec<String>,
) -> Result<Vec<(String, bool)>> {
    ensure_started(app, state).await?;
    let dht = { state.0.lock().await.as_ref().and_then(|n| n.dht.clone()) }
        .ok_or_else(|| anyhow!("DHT discovery is off"))?;
    Ok(dht.presence(node_ids).await)
}

/// One awaited nickname-claim publish (the Contacts "Publish" button): success
/// means the record reached the DHT's storage nodes.
pub async fn dht_publish_nick(app: &AppHandle, state: &P2pState) -> Result<()> {
    ensure_started(app, state).await?;
    let (dht, self_id) = {
        let guard = state.0.lock().await;
        let node = guard.as_ref().ok_or_else(|| anyhow!("p2p not started"))?;
        let dht = node
            .dht
            .as_ref()
            .map(|d| d.clone_dht())
            .ok_or_else(|| anyhow!("DHT discovery is off"))?;
        (dht, node.endpoint.id())
    };
    crate::p2p_dht::publish_nick_once(app, &dht, self_id).await
}

/// Nickname-directory search (Contacts "Find people"). Returns every fresh
/// CLAIM on the name — `(node_id, claimed display name, ts)` — freshest first.
pub async fn dht_find_nick(
    app: &AppHandle,
    state: &P2pState,
    nick: &str,
) -> Result<Vec<(String, String, u64)>> {
    ensure_started(app, state).await?;
    let dht = { state.0.lock().await.as_ref().and_then(|n| n.dht.clone()) }
        .ok_or_else(|| anyhow!("DHT discovery is off"))?;
    Ok(dht
        .find_nick(nick)
        .await
        .into_iter()
        .map(|(id, name, ts)| (id.to_string(), name, ts))
        .collect())
}

/// Mint (or re-surface) the ticketless-join code for a saved room — lets rooms
/// created before the toggle (or ticket-joined) become code-shareable. `None`
/// while discovery is off. Starts the node lazily like every room command, so
/// the Contacts invite flow works before any room is opened this session.
pub async fn dht_room_code(
    app: &AppHandle,
    state: &P2pState,
    room: &str,
    name: &str,
) -> Result<Option<String>> {
    ensure_started(app, state).await?;
    let mut guard = state.0.lock().await;
    let Some(node) = guard.as_mut() else { return Ok(None) };
    if node.dht.is_none() {
        return Ok(None);
    }
    let secret = crate::p2p_dht::load_or_create_room_secret(app, room)?;
    // Newly minted secret on an open room ⇒ start serving code-joiners now.
    start_publisher(app, node, room);
    Ok(Some(RoomCode { name: name.to_string(), secret }.encode()))
}

pub async fn broadcast(state: &P2pState, room: &str, payload: String) -> Result<()> {
    let guard = state.0.lock().await;
    let node = guard.as_ref().ok_or_else(|| anyhow!("p2p not started"))?;
    let handle = node.rooms.get(room).ok_or_else(|| anyhow!("no such p2p room"))?;
    handle
        .sender
        .broadcast(Bytes::from(payload.into_bytes()))
        .await
        .map_err(|e| anyhow!("broadcast failed: {e}"))
}

pub async fn node_info(app: &AppHandle, state: &P2pState) -> Result<String> {
    ensure_started(app, state).await?;
    let guard = state.0.lock().await;
    Ok(guard
        .as_ref()
        .ok_or_else(|| anyhow!("p2p not started"))?
        .endpoint
        .id()
        .to_string())
}

// ── receive loop ───────────────────────────────────────────────────────────────

fn spawn_receiver(
    app: AppHandle,
    room: String,
    mut receiver: GossipReceiver,
    neighbors: Arc<StdMutex<HashSet<EndpointId>>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        emit_status(&app, &room, "connecting", 0, None);
        while let Some(item) = receiver.next().await {
            let Ok(event) = item else { break };
            match event {
                Event::Received(msg) => {
                    if let Ok(text) = std::str::from_utf8(&msg.content) {
                        emit_message(&app, &room, text);
                    }
                }
                // The neighbor's NodeId rides the status event so the frontend can
                // persist it per room — that's the address book for reconnects.
                // The shared set additionally feeds the DHT rendezvous publisher
                // (records advertise a few neighbors) and stops the resolver.
                Event::NeighborUp(peer) => {
                    let peers = neighbors
                        .lock()
                        .map(|mut set| {
                            set.insert(peer);
                            set.len() as u32
                        })
                        .unwrap_or(0);
                    emit_status(&app, &room, "connected", peers, Some(peer.to_string()));
                }
                Event::NeighborDown(peer) => {
                    let peers = neighbors
                        .lock()
                        .map(|mut set| {
                            set.remove(&peer);
                            set.len() as u32
                        })
                        .unwrap_or(0);
                    let state = if peers > 0 { "connected" } else { "disconnected" };
                    emit_status(&app, &room, state, peers, None);
                }
                Event::Lagged => {}
            }
        }
        if let Ok(mut set) = neighbors.lock() {
            set.clear();
        }
        emit_status(&app, &room, "disconnected", 0, None);
    })
}

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
    fn ticket_round_trips_through_base32() {
        let topic = TopicId::from_bytes([7u8; 32]);
        let topic_s = topic.to_string();
        let ticket = Ticket { topic, name: "general".to_string(), peers: vec![] };

        let encoded = ticket.encode();
        assert!(!encoded.is_empty());
        assert_eq!(encoded, encoded.to_ascii_lowercase()); // tickets are lowercase

        let decoded = Ticket::decode(&encoded).expect("decode our own ticket");
        assert_eq!(decoded.topic.to_string(), topic_s);
        assert_eq!(decoded.name, "general");
        assert!(decoded.peers.is_empty());
    }

    #[test]
    fn ticket_decode_rejects_garbage() {
        assert!(Ticket::decode("not a valid ticket!!!").is_err());
    }

    #[test]
    fn topic_is_derived_deterministically_from_name() {
        assert_eq!(topic_for("room-a").to_string(), topic_for("room-a").to_string());
        assert_ne!(topic_for("room-a").to_string(), topic_for("room-b").to_string());
    }

    #[test]
    fn room_code_round_trips_through_base32() {
        let code = RoomCode { name: "general".to_string(), secret: [5u8; 32] };
        let encoded = code.encode();
        assert_eq!(encoded, encoded.to_ascii_lowercase()); // codes are lowercase

        let decoded = RoomCode::decode(&encoded).expect("decode our own code");
        assert_eq!(decoded.name, "general");
        assert_eq!(decoded.secret, [5u8; 32]);
    }

    #[test]
    fn room_code_decode_rejects_garbage_and_foreign_tags() {
        assert!(RoomCode::decode("not a valid code!!!").is_err());
        // An iroh ticket must not decode as a room code (routing depends on it).
        let ticket = Ticket {
            topic: TopicId::from_bytes([7u8; 32]),
            name: "general".to_string(),
            peers: vec![],
        };
        assert!(RoomCode::decode(&ticket.encode()).is_err());
    }

    #[test]
    fn code_sniff_routes_only_dht_codes() {
        let code = RoomCode { name: "general".to_string(), secret: [5u8; 32] }.encode();
        assert!(code_is_dht(&code));

        let ticket = Ticket {
            topic: TopicId::from_bytes([7u8; 32]),
            name: "general".to_string(),
            peers: vec![],
        };
        assert!(!code_is_dht(&ticket.encode()));
        assert!(!code_is_dht("not a valid code!!!"));
    }
}
