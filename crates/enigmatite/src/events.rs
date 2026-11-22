//! The events rakotis' chat transport (`chatTransport.ts`) listens to, as Enigma has always
//! emitted them: `realtime://message` `{room, payload}` and `realtime://status`
//! `{room, state, peers, peer_id}`. An app hands [`pump`] a sink that emits them as Tauri events.

use ferrozine::room::{RoomEvent, RoomEvents};
use serde_json::{json, Value};

/// The message event's name.
pub const MESSAGE: &str = "realtime://message";
/// The status event's name.
pub const STATUS: &str = "realtime://status";

/// One event for the window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A frame arrived in a room (JSON text, as sent).
    Message {
        /// The room's slug.
        room: String,
        /// The frame.
        payload: String,
    },
    /// A room's connection changed.
    Status {
        /// The room's slug.
        room: String,
        /// `connecting`, `connected` or `disconnected`.
        state: &'static str,
        /// Live gossip neighbors.
        peers: u32,
        /// The neighbor that just came up (the reconnect address book keeps it).
        peer_id: Option<String>,
    },
}

impl Event {
    /// The event's name.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Event::Message { .. } => MESSAGE,
            Event::Status { .. } => STATUS,
        }
    }

    /// The event's payload, as the window reads it.
    #[must_use]
    pub fn json(&self) -> Value {
        match self {
            Event::Message { room, payload } => json!({ "room": room, "payload": payload }),
            Event::Status { room, state, peers, peer_id } => json!({ "room": room, "state": state, "peers": peers, "peer_id": peer_id }),
        }
    }

    /// A status event.
    #[must_use]
    pub fn status(room: &str, state: &'static str, peers: u32, peer_id: Option<String>) -> Event {
        Event::Status { room: room.to_string(), state, peers, peer_id }
    }
}

/// Turns a room's events into window events until the room closes: `connecting` first,
/// `connected` with each neighbor that comes up, `disconnected` when the last goes and at the end.
pub async fn pump(room: String, mut events: RoomEvents, sink: impl Fn(Event)) {
    sink(Event::status(&room, "connecting", 0, None));
    while let Some(event) = events.next().await {
        match event {
            RoomEvent::Message { payload, .. } => {
                if let Ok(text) = std::str::from_utf8(&payload) {
                    sink(Event::Message { room: room.clone(), payload: text.to_string() });
                }
            }
            RoomEvent::NeighborUp { peer, neighbors } => {
                sink(Event::status(&room, "connected", neighbors as u32, Some(peer.to_string())));
            }
            RoomEvent::NeighborDown { neighbors, .. } => {
                let state = if neighbors > 0 { "connected" } else { "disconnected" };
                sink(Event::status(&room, state, neighbors as u32, None));
            }
            RoomEvent::Lagged => {}
        }
    }
    sink(Event::status(&room, "disconnected", 0, None));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shapes_are_enigmas() {
        let m = Event::Message { room: "r".into(), payload: "{}".into() };
        assert_eq!(m.name(), "realtime://message");
        assert_eq!(m.json(), json!({ "room": "r", "payload": "{}" }));
        let s = Event::status("r", "connected", 2, Some("p".into()));
        assert_eq!(s.json(), json!({ "room": "r", "state": "connected", "peers": 2, "peer_id": "p" }));
    }
}
