//! Offline delivery through a Beacon's room mailbox (port of `mailbox.ts`). Wire format
//! `{"kind":"demio-room","room":<slug>,"frame":<frame JSON text>}`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::traits::Mailbox;

/// The envelope's kind.
pub const MAILBOX_KIND: &str = "demio-room";
/// An endpoint id for a room (read and ignored: nothing is dialled from the mailbox).
pub const NODE_KIND: &str = "teutates-chat-node";
/// The server's page size.
pub const MAILBOX_PAGE: usize = 100;
const SEEN_MAX: usize = 4000;

/// FNV-1a, 2x32 bits: a local id for a frame without `msg_id` (same as the TS, over UTF-16
/// units for ASCII-only JSON; it never goes on the wire).
fn hash(s: &str) -> String {
    let (mut a, mut b): (u32, u32) = (0x811c_9dc5, 0x0100_0193 ^ 0x5bd1_e995);
    for c in s.encode_utf16() {
        let c = u32::from(c);
        a = (a ^ c).wrapping_mul(0x0100_0193);
        b = (b ^ c).wrapping_mul(0x5bd1_e995);
    }
    format!("h{a:x}{b:x}")
}

/// The id of a frame that goes through the mailbox; `None` for the rest.
#[must_use]
pub fn frame_id(frame: &str) -> Option<String> {
    let v: Value = serde_json::from_str(frame).ok()?;
    match v.get("type")?.as_str()? {
        "mls_app" | "mls_commit" => Some(match v.get("msg_id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => hash(frame),
        }),
        "mls_key_package" | "mls_welcome" => Some(hash(frame)),
        _ => None,
    }
}

/// The envelope of an outgoing frame, if it goes to the mailbox.
#[must_use]
pub fn envelope(room: &str, frame: &str) -> Option<Value> {
    frame_id(frame).map(|_| json!({ "kind": MAILBOX_KIND, "room": room, "frame": frame }))
}

/// A room's place in the mailbox.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    /// Frame ids seen.
    pub seen: Vec<String>,
    /// `None` until the first catch-up of a fresh room.
    pub cursor: Option<u64>,
}

/// Notes a frame's id; whether it is new.
pub fn note(place: &mut Place, frame: &str) -> bool {
    let Some(id) = frame_id(frame) else { return false };
    if place.seen.contains(&id) {
        return false;
    }
    place.seen.push(id);
    if place.seen.len() > SEEN_MAX {
        let n = place.seen.len() - SEEN_MAX;
        place.seen.drain(..n);
    }
    true
}

/// What arrived for `room` since the cursor and was not seen. The first call of a fresh room
/// only moves the cursor to the end.
///
/// # Errors
/// The server does not answer.
pub fn catch_up(place: &mut Place, mb: &dyn Mailbox, room: &str) -> Result<Vec<String>, String> {
    let deliver = place.cursor.is_some();
    let mut after = place.cursor.unwrap_or(0);
    let mut frames = Vec::new();
    loop {
        let page = mb.fetch(after, room)?;
        for (id, body) in &page {
            after = after.max(*id);
            let Ok(v) = serde_json::from_str::<Value>(body) else { continue };
            if v.get("room").and_then(Value::as_str) != Some(room) {
                continue;
            }
            if v.get("kind").and_then(Value::as_str) != Some(MAILBOX_KIND) {
                continue;
            }
            let Some(frame) = v.get("frame").and_then(Value::as_str) else { continue };
            if note(place, frame) && deliver {
                frames.push(frame.to_string());
            }
        }
        if page.len() < MAILBOX_PAGE {
            break;
        }
    }
    place.cursor = Some(after);
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_have_ids_and_presence_does_not() {
        assert_eq!(frame_id(r#"{"type":"mls_app","msg_id":"m1","ciphertext":"x"}"#).as_deref(), Some("m1"));
        let a = frame_id(r#"{"type":"mls_app","ciphertext":"x"}"#).unwrap();
        assert!(a.starts_with('h'));
        assert_eq!(a, frame_id(r#"{"type":"mls_app","ciphertext":"x"}"#).unwrap());
        assert!(frame_id(r#"{"type":"mls_welcome","welcome":"w"}"#).is_some());
        assert!(frame_id(r#"{"type":"mls_reset_request"}"#).is_none());
        assert!(frame_id("not json").is_none());
        assert!(envelope("r", r#"{"type":"cover"}"#).is_none());
        let mut p = Place::default();
        assert!(note(&mut p, r#"{"type":"mls_app","msg_id":"m1"}"#));
        assert!(!note(&mut p, r#"{"type":"mls_app","msg_id":"m1"}"#));
    }
}
