//! A gossip endpoint with rooms by name — Enigma's `p2p_iroh.rs` without Tor, the DHT,
//! invitations or calls: one iroh endpoint (Ferrozine), gossip on its ALPN, one topic per room
//! (`blake3(name)`, so every app meets in the same room), events through [`crate::events`].
//! Frames are already MLS ciphertext when they get here.

use std::collections::HashMap;
use std::sync::Arc;

use bytes::Bytes;
use ferrozine::endpoint::{EndpointConfig, Node, Relays};
use ferrozine::room::{self, Room};
use iroh::protocol::Router;
use iroh::EndpointId;
use tokio::sync::Mutex;

use crate::events::{pump, Event};

/// Gossip frames up to this size (a 256 KiB file inline, in base64, sealed).
pub const MAX_FRAME: usize = 1 << 20;

/// Where the gateway's events go (the app emits them to its window).
pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// One endpoint for every room of this device.
pub struct Gateway {
    node: Node,
    gossip: iroh_gossip::net::Gossip,
    _router: Router,
    rooms: Mutex<HashMap<String, (Room, tokio::task::JoinHandle<()>)>>,
    sink: Sink,
}

/// The slug (gossip topic, hex) of a room's name — what rakotis calls the room.
#[must_use]
pub fn slug_for(name: &str) -> String {
    room::topic_for(name).to_string()
}

impl Gateway {
    /// Binds the endpoint (`hosted`: iroh's public relays and discovery; off for tests on
    /// loopback) with this device's endpoint secret, if it keeps one.
    ///
    /// # Errors
    /// When the endpoint cannot bind.
    pub async fn start(hosted: bool, secret: Option<[u8; 32]>, sink: Sink) -> Result<Arc<Gateway>, String> {
        let relays = if hosted { Relays::Hosted } else { Relays::None };
        let cfg = match secret {
            Some(s) => EndpointConfig::stable(relays, s),
            None => EndpointConfig::ephemeral(relays),
        };
        let node = Node::bind(cfg).await.map_err(|e| e.to_string())?;
        let gossip = room::spawn_gossip(node.endpoint.clone(), MAX_FRAME);
        let router = Router::builder(node.endpoint.clone()).accept(room::GOSSIP_ALPN, gossip.clone()).spawn();
        Ok(Arc::new(Gateway { node, gossip, _router: router, rooms: Mutex::new(HashMap::new()), sink }))
    }

    /// This endpoint's address as text (for a peer with no discovery: tests).
    #[must_use]
    pub fn addr_text(&self) -> String {
        self.node.addr_text()
    }

    /// This endpoint's id as text.
    #[must_use]
    pub fn node_id(&self) -> String {
        self.node.endpoint.id().to_string()
    }

    /// Learns a peer's address (tests on loopback, with no discovery).
    ///
    /// # Errors
    /// When the text is not an address.
    pub fn learn(&self, addr: &str) -> Result<(), String> {
        self.node.learn(ferrozine::addr::decode(addr).map_err(|e| e.to_string())?);
        Ok(())
    }

    /// Joins a room by its name, dialing `peers` (endpoint ids); answers its slug. Joining a
    /// room already open dials the new peers (Enigma's ticketless reconnect, idempotent).
    ///
    /// # Errors
    /// When gossip refuses.
    pub async fn join(&self, name: &str, peers: &[String]) -> Result<String, String> {
        let slug = slug_for(name);
        let ids: Vec<EndpointId> = peers.iter().filter_map(|p| p.parse().ok()).filter(|p| *p != self.node.endpoint.id()).collect();
        let mut rooms = self.rooms.lock().await;
        if let Some((r, _)) = rooms.get(&slug) {
            if !ids.is_empty() {
                r.join_peers(ids).await.map_err(|e| e.to_string())?;
            }
            return Ok(slug);
        }
        let (r, events) = room::join(&self.gossip, room::topic_for(name), ids).await.map_err(|e| e.to_string())?;
        let sink = Arc::clone(&self.sink);
        let task = tokio::spawn(pump(slug.clone(), events, move |e| sink(e)));
        rooms.insert(slug.clone(), (r, task));
        Ok(slug)
    }

    /// Leaves a room (no-op when not in it).
    pub async fn leave(&self, slug: &str) {
        if let Some((_, task)) = self.rooms.lock().await.remove(slug) {
            task.abort();
            (self.sink)(Event::status(slug, "disconnected", 0, None));
        }
    }

    /// Sends a frame to everyone in the room who is online.
    ///
    /// # Errors
    /// When not in the room, or gossip refuses.
    pub async fn broadcast(&self, slug: &str, payload: String) -> Result<(), String> {
        let r = self.rooms.lock().await.get(slug).map(|(r, _)| r.clone()).ok_or("not in that room")?;
        r.broadcast(Bytes::from(payload.into_bytes())).await.map_err(|e| e.to_string())
    }
}
