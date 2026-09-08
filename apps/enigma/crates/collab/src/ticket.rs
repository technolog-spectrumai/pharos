// The pairing ticket — what a QR code carries.
//
// Enigma DELETED its equivalent, and the reason is worth stating because this
// re-adds one. Its `p2p_iroh.rs:76-81` says: *"Room tickets and DHT room codes
// both used to live here … They are gone. A room is entered only by redeeming
// an invitation, which is bounded, revocable and bound to one redeemer, so
// there is nothing left to mint or to sniff a tag byte from."* A bearer
// credential that never expires, cannot be revoked and admits whoever holds it
// is a bad way to run a chat room whose membership must outlive a session.
//
// A drawing session is the opposite case: it is one pairing, in one room, for
// as long as two people are drawing. So a bearer ticket is the right shape —
// but only with the three bounds enigma's room tickets lacked, all enforced in
// RUST rather than by the frontend:
//
//   * SINGLE USE  — the host accepts the first joiner and refuses the rest.
//   * TTL         — an unused ticket dies (default 5 minutes).
//   * NONCE ECHO  — the joiner proves it read THIS ticket, so a QR photographed
//                   and replayed after the real peer paired is refused.
//
// None of that defends against a photograph taken and used within the window,
// before the real peer joins. That is what the short-auth-string is for, and it
// is the UI's half of the contract: both screens show six digits derived from
// the two endpoint ids, and the host taps Accept only if they match.
//
// The wire format, deliberately compact — a camera has to resolve every module:
//
//   base32-nopad-lowercase( postcard( TicketV1 ) )
//
// with a tag byte first so a future format is distinguishable rather than
// misparsed, which is the one thing enigma's legacy_ticket.rs proves you want.

use serde::{Deserialize, Serialize};

/// This format. A reader that meets a different tag refuses rather than
/// guessing — `legacy_ticket.rs` in enigma exists because that guess was once
/// made and had to be unpicked.
pub const TICKET_TAG: u8 = 0x43; // 'C' for collab

/// How long an unused ticket stays good, in milliseconds. Five minutes: long
/// enough to walk a laptop across a room, short enough that a screenshot in a
/// chat log is worthless by the time anyone finds it.
pub const TICKET_TTL_MS: u64 = 5 * 60 * 1000;

/// What the QR carries.
///
/// `addr_bytes` is an opaque, postcard-encoded `iroh::EndpointAddr` — node id,
/// relay url and direct addresses. It is kept as bytes so this module (and its
/// tests) need no iroh dependency: the ticket is data, and the transport
/// decodes it. That is what lets every property below be tested offline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketV1 {
    /// The gossip topic both peers subscribe to.
    pub topic: [u8; 32],
    /// postcard(EndpointAddr) — how to reach the host.
    pub addr_bytes: Vec<u8>,
    /// Echoed by the joiner in its first frame. Proves it read THIS ticket and
    /// not an older one for the same host.
    pub nonce: [u8; 16],
    /// Milliseconds since the epoch, from the host's clock.
    pub issued_at_ms: u64,
}

impl TicketV1 {
    /// Whether this ticket is still within its window, judged against a clock
    /// the CALLER supplies.
    ///
    /// The host's own clock is the authority, and it checks at accept time — a
    /// bearer can edit its copy of `issued_at_ms`, so this is advice to the
    /// holder ("do not bother") and an assertion on the host ("too late"). The
    /// same split enigma documents for its invitations: *"The authority is the
    /// inviter's own clock, checked at redemption."*
    pub fn is_fresh(&self, now_ms: u64) -> bool {
        // A ticket stamped in the future is not fresh, it is wrong: either a
        // skewed clock or a forged field, and neither deserves the benefit of
        // the doubt.
        now_ms >= self.issued_at_ms && now_ms - self.issued_at_ms <= TICKET_TTL_MS
    }

    /// Milliseconds left, saturating at zero — what a countdown renders.
    pub fn remaining_ms(&self, now_ms: u64) -> u64 {
        if now_ms < self.issued_at_ms {
            return 0;
        }
        TICKET_TTL_MS.saturating_sub(now_ms - self.issued_at_ms)
    }
}

/// Encode for a QR: tag, then postcard, then lowercase base32 with no padding.
///
/// Lowercase and unpadded for the same reason enigma chose it: alphanumeric QR
/// mode is uppercase-only and denser, so a reader can uppercase this before
/// encoding and the code stays small, while the string a human might paste
/// stays unshouty.
pub fn encode(ticket: &TicketV1) -> Result<String, String> {
    let mut bytes = vec![TICKET_TAG];
    bytes.extend_from_slice(
        &postcard::to_stdvec(ticket).map_err(|e| format!("bad_ticket: {e}"))?,
    );
    let mut text = data_encoding::BASE32_NOPAD.encode(&bytes);
    text.make_ascii_lowercase();
    Ok(text)
}

/// Decode a scanned or pasted ticket.
///
/// Accepts either case: a QR reader that used alphanumeric mode hands back
/// uppercase, and a human pasting from a chat may have either.
pub fn decode(text: &str) -> Result<TicketV1, String> {
    let cleaned: String = text.trim().to_ascii_uppercase();
    let bytes = data_encoding::BASE32_NOPAD
        .decode(cleaned.as_bytes())
        .map_err(|_| "bad_ticket: not a valid code".to_string())?;
    let (&tag, rest) = bytes
        .split_first()
        .ok_or_else(|| "bad_ticket: empty".to_string())?;
    if tag != TICKET_TAG {
        // Named rather than guessed: a wrong tag is someone pasting a
        // different kind of code, and saying so beats a parse error.
        return Err("bad_ticket: not a collab ticket".into());
    }
    postcard::from_bytes(rest).map_err(|_| "bad_ticket: damaged or truncated".to_string())
}

/// The six digits both screens show, from the two endpoint ids.
///
/// The ORDER is fixed by sorting, not by who is host: both sides must derive
/// the same string without agreeing who speaks first. Domain-separated so this
/// hash can never collide with another use of the same two ids.
///
/// What it defends: a QR photographed over a shoulder and used to join before
/// the real peer does. The attacker completes the pairing, but their endpoint
/// id is not the one on the other person's screen, so the digits differ and the
/// host declines. What it does NOT defend: nobody comparing the digits.
pub fn short_auth_string(a: &[u8], b: &[u8]) -> String {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut h = blake3::Hasher::new();
    h.update(b"zinnia/collab/sas/v1");
    h.update(&(lo.len() as u32).to_le_bytes()); // length-prefixed: no ambiguity
    h.update(lo);
    h.update(hi);
    let digest = h.finalize();
    let n = u32::from_le_bytes(digest.as_bytes()[..4].try_into().unwrap());
    format!("{:06}", n % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket() -> TicketV1 {
        TicketV1 {
            topic: [7u8; 32],
            addr_bytes: vec![1, 2, 3, 4],
            nonce: [9u8; 16],
            issued_at_ms: 1_000_000,
        }
    }

    #[test]
    fn a_ticket_round_trips() {
        let t = ticket();
        assert_eq!(decode(&encode(&t).unwrap()).unwrap(), t);
    }

    #[test]
    fn the_encoding_survives_a_qr_reader_upcasing_it() {
        // Alphanumeric QR mode is uppercase-only, so a scanner legitimately
        // hands back a different case than was encoded.
        let t = ticket();
        let s = encode(&t).unwrap();
        assert_eq!(s, s.to_ascii_lowercase(), "encoded form is lowercase");
        assert_eq!(decode(&s.to_ascii_uppercase()).unwrap(), t);
        assert_eq!(decode(&format!("  {s}  ")).unwrap(), t, "and tolerates whitespace");
    }

    #[test]
    fn a_foreign_code_is_named_not_guessed() {
        let mut bytes = vec![0x49]; // enigma's old room-ticket tag
        bytes.extend_from_slice(&postcard::to_stdvec(&ticket()).unwrap());
        let mut text = data_encoding::BASE32_NOPAD.encode(&bytes);
        text.make_ascii_lowercase();
        let err = decode(&text).unwrap_err();
        assert!(err.starts_with("bad_ticket"), "{err}");
        assert!(err.contains("not a collab ticket"), "{err}");
    }

    #[test]
    fn rubbish_is_refused_rather_than_panicking() {
        for bad in ["", "!!!!", "zzzz", "abc"] {
            assert!(decode(bad).is_err(), "{bad:?} must not decode");
        }
        // A truncated but well-formed prefix must not panic either.
        let s = encode(&ticket()).unwrap();
        assert!(decode(&s[..s.len() / 2]).is_err());
    }

    #[test]
    fn a_ticket_expires() {
        let t = ticket();
        assert!(t.is_fresh(t.issued_at_ms), "fresh at issue");
        assert!(t.is_fresh(t.issued_at_ms + TICKET_TTL_MS), "fresh at the edge");
        assert!(!t.is_fresh(t.issued_at_ms + TICKET_TTL_MS + 1), "stale one ms later");
    }

    #[test]
    fn a_ticket_from_the_future_is_not_trusted() {
        // A forged or skewed `issued_at_ms` must not buy a longer life.
        let t = ticket();
        assert!(!t.is_fresh(t.issued_at_ms - 1));
        assert_eq!(t.remaining_ms(t.issued_at_ms - 1), 0);
    }

    #[test]
    fn the_countdown_saturates_rather_than_underflowing() {
        let t = ticket();
        assert_eq!(t.remaining_ms(t.issued_at_ms), TICKET_TTL_MS);
        assert_eq!(t.remaining_ms(t.issued_at_ms + TICKET_TTL_MS * 2), 0);
    }

    #[test]
    fn the_auth_string_is_six_digits_and_order_independent() {
        let a = b"endpoint-a";
        let b = b"endpoint-b";
        let s = short_auth_string(a, b);
        assert_eq!(s.len(), 6, "{s}");
        assert!(s.chars().all(|c| c.is_ascii_digit()), "{s}");
        // Both sides derive it without agreeing who is host.
        assert_eq!(s, short_auth_string(b, a));
    }

    #[test]
    fn a_different_peer_gives_a_different_auth_string() {
        // The whole defence: an attacker who joins with a photographed ticket
        // has a different endpoint id, so the digits do not match.
        let host = b"host";
        let real = short_auth_string(host, b"the-real-peer");
        let imposter = short_auth_string(host, b"an-imposter!!");
        assert_ne!(real, imposter);
    }

    #[test]
    fn the_auth_string_is_not_confusable_by_shifting_the_boundary() {
        // Length-prefixing is why: without it, ("ab","c") and ("a","bc") would
        // hash the same bytes and collide.
        assert_ne!(short_auth_string(b"ab", b"c"), short_auth_string(b"a", b"bc"));
    }
}
