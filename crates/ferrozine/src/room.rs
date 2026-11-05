//! Rooms: many-to-many messages over iroh-gossip.
//!
//! A room is a gossip topic. Everyone who opens the same room name lands on the
//! same topic ([`topic_for`]), and bootstraps from the endpoint ids of members
//! it already knows. Gossip only moves bytes: **landing on a topic is not
//! membership**. Membership is the room's MLS group, which the app keeps —
//! persisted, because a group outlives a connection — and lends to ferrozine
//! to seal and open each message ([`Room::broadcast_sealed`], [`open_sealed`]).
//! So a relay, a gossip neighbor, or anyone else on the topic sees only MLS
//! ciphertext, and a message from outside the group does not open.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use futures_lite::StreamExt;
use iroh::{Endpoint, EndpointId};
use iroh_gossip::api::{Event, GossipReceiver, GossipSender};
use iroh_gossip::net::Gossip;
use rotor_core::RotorSession;

pub use iroh_gossip::net::GOSSIP_ALPN;
pub use iroh_gossip::proto::TopicId;

use crate::error::{Error, Result};

/// The topic of the room called `name`: `BLAKE3(name)`.
pub fn topic_for(name: &str) -> TopicId {
    TopicId::from_bytes(*blake3::hash(name.as_bytes()).as_bytes())
}

/// Start gossip on `endpoint`, accepting messages up to `max_message_size`
/// bytes (the default is a few KiB; a sealed image or voice note needs more).
/// Register the result on the endpoint's router under [`GOSSIP_ALPN`].
pub fn spawn_gossip(endpoint: Endpoint, max_message_size: usize) -> Gossip {
    Gossip::builder()
        .max_message_size(max_message_size)
        .spawn(endpoint)
}

/// Something that happened in a room.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomEvent {
    /// A message, as delivered by the neighbor `from` (not necessarily its author).
    Message {
        /// The neighbor that delivered it.
        from: EndpointId,
        /// The bytes broadcast (MLS ciphertext, if the room seals).
        payload: Bytes,
    },
    /// A direct neighbor joined; `neighbors` is the count afterwards.
    NeighborUp {
        /// The neighbor.
        peer: EndpointId,
        /// Direct neighbors now.
        neighbors: usize,
    },
    /// A direct neighbor left; `neighbors` is the count afterwards.
    NeighborDown {
        /// The neighbor.
        peer: EndpointId,
        /// Direct neighbors now.
        neighbors: usize,
    },
    /// This receiver fell behind and some messages were dropped.
    Lagged,
}

type Neighbors = Arc<Mutex<HashSet<EndpointId>>>;

/// The sending half of an open room.
#[derive(Clone)]
pub struct Room {
    topic: TopicId,
    sender: GossipSender,
    neighbors: Neighbors,
}

/// The receiving half of an open room. Dropping both halves leaves the topic.
pub struct RoomEvents {
    receiver: GossipReceiver,
    neighbors: Neighbors,
}

/// Open `topic`, bootstrapping from `peers`.
pub async fn join(
    gossip: &Gossip,
    topic: TopicId,
    peers: Vec<EndpointId>,
) -> Result<(Room, RoomEvents)> {
    let (sender, receiver) = gossip
        .subscribe(topic, peers)
        .await
        .map_err(Error::conn)?
        .split();
    let neighbors: Neighbors = Arc::default();
    Ok((
        Room {
            topic,
            sender,
            neighbors: neighbors.clone(),
        },
        RoomEvents {
            receiver,
            neighbors,
        },
    ))
}

impl Room {
    /// The room's topic.
    pub fn topic(&self) -> TopicId {
        self.topic
    }

    /// Broadcast bytes as they are. Use [`broadcast_sealed`](Self::broadcast_sealed)
    /// unless they are already ciphertext.
    pub async fn broadcast(&self, payload: Bytes) -> Result<()> {
        self.sender.broadcast(payload).await.map_err(Error::conn)
    }

    /// Seal `plaintext` with the room's MLS group and broadcast it.
    pub async fn broadcast_sealed(&self, group: &mut RotorSession, plaintext: &[u8]) -> Result<()> {
        let sealed = group.encrypt_app(plaintext).map_err(Error::Mls)?;
        self.broadcast(Bytes::from(sealed)).await
    }

    /// Dial more members (found later, e.g. through discovery). Known ones are ignored.
    pub async fn join_peers(&self, peers: Vec<EndpointId>) -> Result<()> {
        self.sender.join_peers(peers).await.map_err(Error::conn)
    }

    /// The current direct neighbors.
    pub fn neighbors(&self) -> Vec<EndpointId> {
        self.neighbors
            .lock()
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Whether the room has at least one live neighbor.
    pub fn is_connected(&self) -> bool {
        self.neighbors
            .lock()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }
}

impl RoomEvents {
    /// The next event, or `None` once the room is closed. Keeps the neighbor
    /// set [`Room::neighbors`] reads up to date.
    pub async fn next(&mut self) -> Option<RoomEvent> {
        let event = match self.receiver.next().await? {
            Ok(event) => event,
            Err(_) => {
                self.clear();
                return None;
            }
        };
        let set = |peer, up: bool| {
            self.neighbors
                .lock()
                .map(|mut s| {
                    if up {
                        s.insert(peer);
                    } else {
                        s.remove(&peer);
                    }
                    s.len()
                })
                .unwrap_or(0)
        };
        Some(match event {
            Event::Received(msg) => RoomEvent::Message {
                from: msg.delivered_from,
                payload: msg.content,
            },
            Event::NeighborUp(peer) => RoomEvent::NeighborUp {
                peer,
                neighbors: set(peer, true),
            },
            Event::NeighborDown(peer) => RoomEvent::NeighborDown {
                peer,
                neighbors: set(peer, false),
            },
            Event::Lagged => RoomEvent::Lagged,
        })
    }

    fn clear(&self) {
        if let Ok(mut s) = self.neighbors.lock() {
            s.clear();
        }
    }
}

impl Drop for RoomEvents {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Open a room message with the room's MLS group: `Some(plaintext)` for an
/// application message, `None` for a commit or proposal (the group itself
/// changed — the session has already applied it).
///
/// Anyone on the topic can broadcast; a forgery is an error here, never a
/// panic, in debug and release builds alike.
pub fn open_sealed(group: &mut RotorSession, payload: &[u8]) -> Result<Option<Vec<u8>>> {
    crate::pair::process(group, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_topic_is_blake3_of_the_room_name() {
        // Vesper's p2p_iroh derived it this way; keeping it keeps old and new
        // builds in one room.
        assert_eq!(
            topic_for("room-a"),
            TopicId::from_bytes(*blake3::hash(b"room-a").as_bytes())
        );
        assert_ne!(topic_for("room-a"), topic_for("room-b"));
    }
}
