//! Reading the permanent room tickets that older builds saved — and nothing else.
//!
//! Enigma26 no longer mints room tickets: a room is entered by redeeming an
//! invitation, and every room is invite-only (technology.md §18). But saved rooms
//! written by earlier builds carry a `ticket` field, and for two kinds of room it
//! is the ONLY record of how to get back in:
//!
//! * **iroh** — the ticket holds the peer `EndpointAddr`s. The room record usually
//!   also has `peers`, but not always: a room joined and never revisited has an
//!   empty address book.
//! * **Tor** — the ticket holds the CAPTAIN's `.onion`. The record's own `onion`
//!   field is *ours*, not theirs, so without the ticket a Tor room we joined but
//!   did not host has no route back at all. This is the case that would otherwise
//!   be stranded permanently.
//!
//! So the decoder survives its own feature, deliberately and in one direction. It
//! is reachable through exactly one command, `legacy_ticket_decode`, called once
//! per record by the frontend's load-time backfill, which then deletes the field.
//! There is no encoder here and no join path: a ticket can be read into a room
//! record, never used to enter a room.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

/// Tag bytes of the retired ticket family, kept so a legacy blob still routes.
const IROH_TAG: u8 = 0x49; // 'I'
const TOR_TAG: u8 = 0x54; // 'T'

/// What a legacy ticket can tell us, flattened across both transports.
#[derive(Serialize, Default)]
pub struct LegacyTicket {
    /// True when this was a Tor ticket.
    pub tor: bool,
    /// The room's display name, from which the gossip topic re-derives as blake3(name).
    pub name: String,
    /// iroh only: peer node ids, for the record's `peers` address book.
    pub peers: Vec<String>,
    /// Tor only: the captain's onion — the address to dial to re-enter.
    pub captain_onion: String,
}

// Mirrors of the retired wire structs. Deliberately private and read-only: they
// exist to parse bytes already on disk, not to describe anything we still write.
#[derive(Deserialize)]
struct IrohTicket {
    topic: [u8; 32],
    name: String,
    peers: Vec<iroh::EndpointAddr>,
}

#[derive(Deserialize)]
struct TorTicket {
    onion: String,
    #[allow(dead_code)] // part of the on-disk shape; the port is not needed to dial
    port: u16,
    name: String,
}

fn base32(s: &str) -> Result<Vec<u8>> {
    Ok(data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?)
}

/// Decode one legacy ticket. Errors on anything that is not one — the caller
/// treats that as "nothing to recover" and drops the field regardless.
pub fn decode(ticket: &str) -> Result<LegacyTicket> {
    let bytes = base32(ticket)?;
    let (&tag, rest) = bytes.split_first().ok_or_else(|| anyhow!("empty ticket"))?;
    match tag {
        TOR_TAG => {
            let t: TorTicket = postcard::from_bytes(rest)?;
            Ok(LegacyTicket { tor: true, name: t.name, peers: vec![], captain_onion: t.onion })
        }
        // Untagged blobs predate the tag byte and are always iroh.
        IROH_TAG | _ => {
            let body = if tag == IROH_TAG { rest } else { &bytes[..] };
            let t: IrohTicket = postcard::from_bytes(body)?;
            let _ = t.topic; // re-derived from the name; read only to satisfy the shape
            Ok(LegacyTicket {
                tor: false,
                name: t.name,
                peers: t.peers.iter().map(|p| p.id.to_string()).collect(),
                captain_onion: String::new(),
            })
        }
    }
}

/// One-shot migration read. Called by the frontend once per saved room, after
/// which the `ticket` field is deleted from the record and never written again.
#[tauri::command]
pub async fn legacy_ticket_decode(ticket: String) -> Result<LegacyTicket, String> {
    decode(&ticket).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    struct TorOut { onion: String, port: u16, name: String }

    fn b32(tag: u8, body: &[u8]) -> String {
        let mut buf = vec![tag];
        buf.extend_from_slice(body);
        let mut s = data_encoding::BASE32_NOPAD.encode(&buf);
        s.make_ascii_lowercase();
        s
    }

    #[test]
    fn recovers_the_captain_onion_from_a_tor_ticket() {
        // The case that would otherwise strand a joined Tor room forever: the
        // captain's address exists nowhere else in the saved record.
        let body = postcard::to_stdvec(&TorOut {
            onion: "abcdefghij234567abcdefghij234567abcdefghij234567abcd.onion".into(),
            port: 9999,
            name: "weekly sync".into(),
        })
        .unwrap();
        let got = decode(&b32(TOR_TAG, &body)).unwrap();
        assert!(got.tor);
        assert_eq!(got.name, "weekly sync");
        assert!(got.captain_onion.ends_with(".onion"));
        assert!(got.peers.is_empty());
    }

    #[test]
    fn rejects_a_blob_that_is_not_a_ticket() {
        // Backfill treats an error as "nothing to recover" and drops the field, so
        // this must fail rather than return a plausible empty record.
        assert!(decode("this is not base32 at all !!!").is_err());
        assert!(decode("").is_err());
    }

    #[test]
    fn there_is_no_encoder() {
        // A guard against the obvious regression: someone adds `encode` here to
        // "round-trip the tests" and the retired credential quietly comes back.
        let src = include_str!("legacy_ticket.rs");
        let body = src.split("mod tests").next().unwrap();
        assert!(!body.contains("fn encode"), "legacy_ticket must never mint a ticket");
    }
}
