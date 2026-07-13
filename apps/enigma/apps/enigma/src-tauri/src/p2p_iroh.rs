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
// Emits `realtime://message` / `realtime://status` events (room-tagged), keeping
// the frontend transport-agnostic.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use bytes::Bytes;
use futures_lite::StreamExt;
use iroh::{
    address_lookup::memory::MemoryLookup, endpoint::presets, protocol::Router, Endpoint,
    EndpointAddr, EndpointId, RelayMode, SecretKey,
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
}

struct RoomHandle {
    sender: GossipSender,
    #[allow(dead_code)]
    name: String,
    task: tauri::async_runtime::JoinHandle<()>,
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
    // presets::N0 keeps iroh's built-in n0 relay + discovery (pkarr/DNS): peers
    // publish their own addresses and NodeId-only dials resolve without any app
    // server. The QR ticket (EndpointAddr) is the bootstrap; discovery is the
    // auto-refresh when addresses change later.
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .address_lookup(lookup.clone()) // ticket path (QR bootstrap)
        .relay_mode(RelayMode::Default)
        .bind()
        .await
        .map_err(|e| anyhow!("iroh bind failed: {e}"))?;
    // Raise the gossip message cap (default is a few KB) so MLS-encrypted images
    // and voice notes fit in a single broadcast.
    let gossip = Gossip::builder()
        .max_message_size(16 * 1024 * 1024)
        .spawn(endpoint.clone());
    let router = Router::builder(endpoint.clone())
        .accept(GOSSIP_ALPN, gossip.clone())
        .spawn();
    *guard = Some(Node {
        endpoint,
        gossip,
        lookup,
        _router: router,
        rooms: HashMap::new(),
    });
    Ok(())
}

/// Open a room (we are the first member) and return `(room_id, ticket)`.
pub async fn create_room(app: &AppHandle, state: &P2pState, name: String) -> Result<(String, String)> {
    ensure_started(app, state).await?;
    let topic = topic_for(&name);
    let room = topic.to_string();

    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("p2p not started"))?;
    if !node.rooms.contains_key(&room) {
        let (sender, receiver) = node
            .gossip
            .subscribe(topic, vec![])
            .await
            .map_err(|e| anyhow!("subscribe failed: {e}"))?
            .split();
        let task = spawn_receiver(app.clone(), room.clone(), receiver);
        node.rooms.insert(room.clone(), RoomHandle { sender, name: name.clone(), task });
    }
    let ticket = Ticket {
        topic,
        name,
        peers: vec![node.endpoint.addr()],
    }
    .encode();
    Ok((room, ticket))
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
    if !node.rooms.contains_key(&room) {
        let (sender, receiver) = node
            .gossip
            .subscribe(topic, peer_ids)
            .await
            .map_err(|e| anyhow!("subscribe failed: {e}"))?
            .split();
        let task = spawn_receiver(app.clone(), room.clone(), receiver);
        node.rooms
            .insert(room.clone(), RoomHandle { sender, name: ticket.name.clone(), task });
    }
    Ok((room, ticket.name))
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
    if !node.rooms.contains_key(&room) {
        let (sender, receiver) = node
            .gossip
            .subscribe(topic, peer_ids)
            .await
            .map_err(|e| anyhow!("subscribe failed: {e}"))?
            .split();
        let task = spawn_receiver(app.clone(), room.clone(), receiver);
        node.rooms
            .insert(room.clone(), RoomHandle { sender, name: name.clone(), task });
    }
    Ok(room)
}

/// Airplane mode: tear the whole P2P node down — abort every room's receive loop,
/// close the iroh endpoint (drops the relay connection and stops discovery
/// publishing), and emit a disconnected status for each open room so the UI
/// reflects it. The next online command lazily re-binds via `ensure_started`.
pub async fn shutdown(app: &AppHandle, state: &P2pState) {
    let mut guard = state.0.lock().await;
    if let Some(mut node) = guard.take() {
        let rooms: Vec<String> = node.rooms.keys().cloned().collect();
        for (_, handle) in node.rooms.drain() {
            handle.task.abort();
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
            // dropping `sender` leaves the gossip topic
        }
    }
    Ok(())
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
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        emit_status(&app, &room, "connecting", 0, None);
        let mut peers: u32 = 0;
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
                Event::NeighborUp(peer) => {
                    peers += 1;
                    emit_status(&app, &room, "connected", peers, Some(peer.to_string()));
                }
                Event::NeighborDown(_) => {
                    peers = peers.saturating_sub(1);
                    let state = if peers > 0 { "connected" } else { "disconnected" };
                    emit_status(&app, &room, state, peers, None);
                }
                Event::Lagged => {}
            }
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
}
