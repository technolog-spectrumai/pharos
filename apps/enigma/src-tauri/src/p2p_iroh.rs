// Direct peer-to-peer chat backend using iroh-gossip (QUIC) — the app's ONLY
// transport (the WebSocket relay backend was removed in the serverless rework).
//
// A room is an iroh-gossip topic (blake3 of the room name). Peers bootstrap from
// a `Ticket` (topic + name + our endpoint addresses, base32-encoded) shared out
// of band — in practice as a QR code. Reconnects after the one-time pairing go by
// persisted peer addresses. There is no relay and no discovery service: a peer
// is reached at the addresses an invitation or a ticket carried. The MLS
// handshake + message protocol ride the gossip topic.
//
// Emits `realtime://message` / `realtime://status` events (room-tagged), keeping
// the frontend transport-agnostic.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use bytes::Bytes;
use ferrozine::room::{self, Room, RoomEvents, TopicId, GOSSIP_ALPN};
use iroh::{
    address_lookup::memory::MemoryLookup,
    endpoint::presets,
    protocol::Router,
    Endpoint, EndpointAddr, EndpointId, RelayMode, SecretKey,
};
use iroh_gossip::net::Gossip;
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
    /// The room's sending half (ferrozine).
    room: Room,
    #[allow(dead_code)]
    name: String,
    task: tauri::async_runtime::JoinHandle<()>,
}

// ── ticket ────────────────────────────────────────────────────────────────────

// Room tickets and DHT room codes both used to live here: base32 blobs, tagged
// `0x49` / `0x54` / `0x44`, that named a room and admitted whoever held one. They
// are gone. A room is entered only by redeeming an invitation (§18), which is
// bounded, revocable and bound to one redeemer, so there is nothing left to mint
// or to sniff a tag byte from. `legacy_ticket.rs` still READS the old blobs, once,
// to migrate saved rooms — it cannot make one.


/// `blake3(name)`, ferrozine's room topic — unchanged, so every build meets in
/// the same room.
fn topic_for(name: &str) -> TopicId {
    room::topic_for(name)
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
    // No hosted infrastructure: no n0 relays, no pkarr/DNS discovery — direct
    // QUIC to the addresses a ticket carries (MemoryLookup), or Tor.
    let mut builder = Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled);
    builder = builder
        .secret_key(secret)
        .address_lookup(lookup.clone()); // ticket path (QR bootstrap)
    let endpoint = builder.bind().await.map_err(|e| anyhow!("iroh bind failed: {e}"))?;
    // Raise the gossip message cap (default is a few KB) so MLS-encrypted images
    // and voice notes fit in a single broadcast.
    let gossip = room::spawn_gossip(endpoint.clone(), crate::build_config::network::MAX_FRAME_BYTES);
    // Gossip is the chat channel itself; invitation redemption is the only other
    // protocol on this endpoint.
    let mut router = Router::builder(endpoint.clone()).accept(GOSSIP_ALPN, gossip.clone());
    // Invitation redemption: an invitation is how someone joins a room.
    router = router.accept(
        crate::invite_redeem::REDEEM_ALPN,
        crate::invite_redeem::RedeemProtocol::new(
            app.clone(),
            tauri::Manager::state::<crate::invite_redeem::RedeemState>(app).inner().clone(),
        ),
    );
    let router = router.spawn();
    *guard = Some(Node {
        endpoint,
        gossip,
        lookup,
        _router: router,
        rooms: HashMap::new(),
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
    let (handle, events) = room::join(&node.gossip, topic, peer_ids)
        .await
        .map_err(|e| anyhow!("subscribe failed: {e}"))?;
    let task = spawn_receiver(app.clone(), room.to_string(), events);
    node.rooms.insert(
        room.to_string(),
        RoomHandle { room: handle, name: name.to_string(), task },
    );
    Ok(())
}

/// Open a room (we are the first member) and return its `room_id`.
///
/// It used to also mint a permanent ticket and a DHT room code. Both were bearer
/// credentials that never expired and could not be withdrawn, and both are gone:
/// a room is entered by redeeming an invitation, which is minted separately and
/// on demand (`invite_api::mint`). Creating a room now produces no shareable
/// credential at all — that is a deliberate second step.
pub async fn create_room(app: &AppHandle, state: &P2pState, name: String) -> Result<String> {
    ensure_started(app, state).await?;
    let topic = topic_for(&name);
    let room = topic.to_string();

    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("p2p not started"))?;
    open_room(app, node, topic, &room, &name, vec![]).await?;
    Ok(room)
}

/// Join a room by name, bootstrapping from peer NodeIds — the ONLY way into an
/// iroh room now that tickets and room codes are gone.
///
/// The topic is `blake3(name)`, so everyone who opens the same room lands on the
/// same gossip topic. With no discovery service, a peer is reachable only at an
/// address this node already holds (from an invitation or an earlier session).
/// Two callers: reopening a saved room from its persisted
/// address book, and completing a redeemed invitation, whose grant carries the
/// inviter's NodeId.
///
/// Note this is a TRANSPORT-level join. Landing on the topic is not membership:
/// every member refuses gossip key packages outright, so nothing but a redeemed
/// invitation adds anyone to the MLS group.
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
    // The payload is already MLS ciphertext (the frontend sealed it with the
    // room's group via the mls_* commands), so it goes out as it is.
    handle
        .room
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

/// This node's own dialable address, for embedding in an invitation.
///
/// Same value a room ticket carries in `peers` — which is why a clearnet
/// invitation costs Privacy HP for the IP it exposes, exactly as a ticket does.
pub async fn local_addr(app: &AppHandle, state: &P2pState) -> Result<EndpointAddr> {
    ensure_started(app, state).await?;
    let guard = state.0.lock().await;
    Ok(guard.as_ref().ok_or_else(|| anyhow!("p2p not started"))?.endpoint.addr())
}

/// A clone of the live endpoint, plus the invitation's embedded addresses folded
/// into the address book so a dial-by-NodeId can actually reach the inviter
/// (mirrors what a ticket join does with `ticket.peers`).
pub async fn endpoint_for_dial(
    app: &AppHandle,
    state: &P2pState,
    hints: &[EndpointAddr],
) -> Result<Endpoint> {
    ensure_started(app, state).await?;
    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("p2p not started"))?;
    for hint in hints {
        node.lookup.add_endpoint_info(hint.clone());
    }
    Ok(node.endpoint.clone())
}

// ── receive loop ───────────────────────────────────────────────────────────────

/// The room's events to the window, through the shared engine's loop (crates/enigmatite), so
/// every app that runs rakotis emits the same `realtime://*` events.
fn spawn_receiver(app: AppHandle, room: String, events: RoomEvents) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(enigmatite::events::pump(room, events, move |ev| {
        let _ = app.emit(ev.name(), ev.json());
    }))
}

fn emit_status(app: &AppHandle, room: &str, state: &'static str, peers: u32, peer_id: Option<String>) {
    let ev = enigmatite::events::Event::status(room, state, peers, peer_id);
    let _ = app.emit(ev.name(), ev.json());
}

#[cfg(test)]
mod tests {
    use super::*;



    #[test]
    fn topic_is_derived_deterministically_from_name() {
        assert_eq!(topic_for("room-a").to_string(), topic_for("room-a").to_string());
        assert_ne!(topic_for("room-a").to_string(), topic_for("room-b").to_string());
    }



}
