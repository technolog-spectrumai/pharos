// Direct peer-to-peer chat backend using iroh-gossip (QUIC).
//
// A room is an iroh-gossip topic (blake3 of the room name). Peers bootstrap from
// a `Ticket` (topic + name + our endpoint addresses, base32-encoded) shared out
// of band. Messages are the same JSON payloads the WS backend carries, so the
// MLS handshake + message protocol in the chat store is reused unchanged — even
// a relay only ever sees MLS ciphertext.
//
// This emits the same `realtime://message` / `realtime://status` events as the
// WS backend, so the frontend stays transport-agnostic.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use bytes::Bytes;
use futures_lite::StreamExt;
use iroh::{
    address_lookup::memory::MemoryLookup, endpoint::presets, protocol::Router, Endpoint,
    EndpointAddr, RelayMode,
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

#[derive(Serialize, Deserialize)]
struct Ticket {
    topic: TopicId,
    name: String,
    peers: Vec<EndpointAddr>,
}

impl Ticket {
    fn encode(&self) -> String {
        let bytes = postcard::to_stdvec(self).expect("postcard::to_stdvec is infallible");
        let mut text = data_encoding::BASE32_NOPAD.encode(&bytes);
        text.make_ascii_lowercase();
        text
    }
    fn decode(s: &str) -> Result<Self> {
        let bytes = data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?;
        Ok(postcard::from_bytes(&bytes)?)
    }
}

fn topic_for(name: &str) -> TopicId {
    TopicId::from_bytes(*blake3::hash(name.as_bytes()).as_bytes())
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

async fn ensure_started(state: &P2pState) -> Result<()> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let lookup = MemoryLookup::new();
    let endpoint = Endpoint::builder(presets::N0)
        .address_lookup(lookup.clone())
        .relay_mode(RelayMode::Default)
        .bind()
        .await
        .map_err(|e| anyhow!("iroh bind failed: {e}"))?;
    let gossip = Gossip::builder().spawn(endpoint.clone());
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
    ensure_started(state).await?;
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
pub async fn join_room(app: &AppHandle, state: &P2pState, ticket: String) -> Result<(String, String)> {
    ensure_started(state).await?;
    let ticket = Ticket::decode(&ticket).map_err(|e| anyhow!("invalid ticket: {e}"))?;
    let topic = ticket.topic;
    let room = topic.to_string();
    let peer_ids = ticket.peers.iter().map(|p| p.id).collect::<Vec<_>>();

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

pub async fn has_room(state: &P2pState, room: &str) -> bool {
    let guard = state.0.lock().await;
    guard.as_ref().is_some_and(|n| n.rooms.contains_key(room))
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

pub async fn node_info(state: &P2pState) -> Result<String> {
    ensure_started(state).await?;
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
        emit_status(&app, &room, "connecting", 0);
        let mut peers: u32 = 0;
        while let Some(item) = receiver.next().await {
            let Ok(event) = item else { break };
            match event {
                Event::Received(msg) => {
                    if let Ok(text) = std::str::from_utf8(&msg.content) {
                        emit_message(&app, &room, text);
                    }
                }
                Event::NeighborUp(_) => {
                    peers += 1;
                    emit_status(&app, &room, "connected", peers);
                }
                Event::NeighborDown(_) => {
                    peers = peers.saturating_sub(1);
                    let state = if peers > 0 { "connected" } else { "disconnected" };
                    emit_status(&app, &room, state, peers);
                }
                Event::Lagged => {}
            }
        }
        emit_status(&app, &room, "disconnected", 0);
    })
}

fn emit_message(app: &AppHandle, room: &str, payload: &str) {
    let _ = app.emit("realtime://message", serde_json::json!({ "room": room, "payload": payload }));
}

fn emit_status(app: &AppHandle, room: &str, state: &str, peers: u32) {
    let _ = app.emit(
        "realtime://status",
        serde_json::json!({ "room": room, "state": state, "peers": peers }),
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
