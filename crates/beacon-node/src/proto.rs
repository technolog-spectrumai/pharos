//! The client link and the Beacon mesh (PROTOCOL.md Part C): hellos, ops, what is
//! signed, route ids.

use serde::{Deserialize, Serialize};

/// How far a hello's signed time may be from ours.
pub const SKEW_SECS: u64 = 15 * 60;

/// Cover on a client link.
pub const CLIENT_COVER: &str = r#"{"op":"cover"}"#;

/// The first frame on a client link or a Beacon link.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LinkHello {
    /// A device attaching to its Beacon.
    Client {
        /// The device id (64 hex, Ed25519).
        device: String,
        /// Unix seconds.
        ts: u64,
        /// Hex Ed25519 by the device over [`client_message`].
        sig: String,
    },
    /// Another Beacon, for one room.
    Beacon {
        /// The dialling Beacon's onion.
        onion: String,
        /// Its node key (64 hex, Ed25519).
        node: String,
        /// The room's route id.
        room: String,
        /// Unix seconds.
        ts: u64,
        /// Hex Ed25519 by the node key over [`beacon_message`].
        sig: String,
    },
}

/// What a client hello is signed over.
#[must_use]
pub fn client_message(beacon_onion: &str, ts: u64) -> Vec<u8> {
    format!("enigma27-client\0{beacon_onion}\0{ts}").into_bytes()
}

/// What a Beacon hello is signed over.
#[must_use]
pub fn beacon_message(listener: &str, dialler: &str, room: &str, ts: u64) -> Vec<u8> {
    format!("enigma27-beacon\0{listener}\0{dialler}\0{room}\0{ts}").into_bytes()
}

/// A room's route id: what Beacons know the room by. Every member derives it from the
/// slug, so they agree; the slug (and so the name) is not on the wire.
#[must_use]
pub fn route_id(slug: &str) -> String {
    hex::encode(blake3::derive_key("enigma27 b2 room route v1", slug.as_bytes()))
}

/// Whether `s` is 64 lowercase hex digits (a device id, node key or route id).
#[must_use]
pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Client → Beacon.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClientOp {
    /// Be in a room (idempotent; `peers` replaces the last list): keep links to these
    /// Beacons, keep frames while offline, deliver live while this link is up.
    Join {
        /// Route id.
        room: String,
        /// Beacon onions of the room's other members.
        #[serde(default)]
        peers: Vec<String>,
    },
    /// Stop live delivery on this link; stay a member (frames are kept).
    Close {
        /// Route id.
        room: String,
    },
    /// Leave the room on this Beacon: no more frames kept.
    Leave {
        /// Route id.
        room: String,
    },
    /// A sealed frame for the room. `n` is answered with [`BeaconOp::Sent`].
    Send {
        /// Route id.
        room: String,
        /// The frame (JSON text).
        frame: String,
        /// The client's own counter.
        n: u64,
    },
    /// Frames up to `upto` arrived; the Beacon drops them.
    Ack {
        /// Route id.
        room: String,
        /// The last seq received.
        upto: u64,
    },
    /// An invitation redemption for `inviter_device` (a client of this Beacon).
    Redeem {
        /// The redeemer's id for this redemption (hex, 16..64 digits).
        id: String,
        /// Who it is for.
        inviter_device: String,
        /// The redeemer's home Beacon (the inviter lists it for the room at once).
        #[serde(default)]
        home: String,
        /// Opaque to the Beacon.
        payload: String,
        /// Answered with [`BeaconOp::Sent`].
        n: u64,
    },
    /// The inviter's answer to a redemption.
    RedeemAnswer {
        /// The redemption.
        id: String,
        /// Opaque to the Beacon.
        payload: String,
        /// Answered with [`BeaconOp::Sent`].
        n: u64,
    },
}

/// Beacon → client.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BeaconOp {
    /// A frame for the room, numbered per (device, room).
    Frame {
        /// Route id.
        room: String,
        /// Its number.
        seq: u64,
        /// The frame.
        frame: String,
    },
    /// The room's links on this Beacon.
    Status {
        /// Route id.
        room: String,
        /// The other Beacons linked for the room.
        linked: Vec<String>,
        /// Other clients of this Beacon in the room, online now.
        local: u32,
    },
    /// The client's op `n` was taken.
    Sent {
        /// Its counter.
        n: u64,
    },
    /// A redemption for this device.
    Redeem {
        /// The redemption.
        id: String,
        /// The redeemer's device id (from its signed hello).
        from: String,
        /// The redeemer's home Beacon, as it said.
        #[serde(default)]
        home: String,
        /// Opaque.
        payload: String,
    },
    /// The answer to our redemption.
    RedeemAnswer {
        /// The redemption.
        id: String,
        /// Opaque.
        payload: String,
    },
    /// An op was refused (why, short).
    Refused {
        /// The op's counter, if it had one.
        #[serde(default)]
        n: u64,
        /// Why.
        why: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hellos_and_ops_have_the_documented_shape() {
        let h = LinkHello::Client { device: "d".into(), ts: 1, sig: "s".into() };
        assert_eq!(serde_json::to_string(&h).unwrap(), r#"{"kind":"client","device":"d","ts":1,"sig":"s"}"#);
        let j = ClientOp::Join { room: "r".into(), peers: vec!["b.onion".into()] };
        assert_eq!(serde_json::to_string(&j).unwrap(), r#"{"op":"join","room":"r","peers":["b.onion"]}"#);
        let f: BeaconOp = serde_json::from_str(r#"{"op":"frame","room":"r","seq":3,"frame":"x"}   "#).unwrap();
        assert_eq!(f, BeaconOp::Frame { room: "r".into(), seq: 3, frame: "x".into() });
    }

    #[test]
    fn route_ids_are_not_the_slug_and_agree() {
        let slug = crate::room_for("Room");
        assert_eq!(route_id(&slug), route_id(&slug));
        assert_ne!(route_id(&slug), slug);
        assert!(is_hex64(&route_id(&slug)));
    }

    #[test]
    fn signatures_bind_the_listener() {
        assert_ne!(client_message("a.onion", 1), client_message("b.onion", 1));
        assert_ne!(beacon_message("a", "b", "r", 1), beacon_message("a", "b", "s", 1));
    }
}
