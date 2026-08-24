//! The QR an invitation travels as: format, encoding, and the sealing that makes
//! a Personal invite readable by exactly one person.
//!
//! ## What a ticket may and may not carry
//!
//! An ordinary room ticket carries the plaintext **room name**, the creator's
//! NodeId and — on clearnet — their IP addresses (technology.md §8). It never
//! expires and cannot be revoked, so in practice "everyone who has ever seen this
//! QR" is the room's access list.
//!
//! An invitation deliberately carries less. There is **no room name, no gossip
//! topic, no room code and no MLS material** in here: those are handed over only
//! after redemption, across an authenticated connection to the inviter. What a
//! photograph of the QR yields is a capability, an address to dial, and a
//! deadline — and for a Personal invite, not even that.
//!
//! ## Two kinds, two honest claims
//!
//! * **Personal** — the entire body is sealed to one contact's public key
//!   (`gervasius::seal_to`). Nobody else can read it, and crucially **no
//!   decryption key travels with it**: the recipient opens it with the secret
//!   behind their own NodeId, which was never in the QR. This is a real
//!   confidentiality claim.
//!
//! * **General** — a transferable bearer credential in **cleartext**. There is no
//!   recipient to seal to, so there is nothing to encrypt it with that the holder
//!   would not also need. It is not confidential, it is not claimed to be, and the
//!   UI and the MANA price both say so. Sealing it under a key printed beside it
//!   would be theatre.
//!
//! ## Wire format
//!
//! ```text
//! base32-nopad-lowercase( TAG(0x4E) || FORMAT_V(0x01) || KIND || body )
//!
//!   KIND = 0x50 'P' -> body = seal_to(recipient_x25519, AAD, postcard(InviteBody))
//!   KIND = 0x47 'G' -> body = postcard(InviteBody)
//!   AAD  = [TAG, FORMAT_V, KIND]      (so a Personal blob cannot be relabelled)
//! ```
//!
//! The leading tag joins the existing `IROH_TAG 0x49` / `TOR_TAG 0x54` /
//! `DHT_TAG 0x44` family, so `JoinRoomModal`'s single paste/scan field routes an
//! invitation by the same sniff it already uses for everything else.
//!
//! The **version byte sits outside the seal on purpose**: a v2 ticket handed to a
//! v1 build must report "this invitation needs a newer version" rather than
//! failing as corrupt, and that decision cannot wait on a key we may not have.
//!
//! ## `expires_at` here is advisory
//!
//! The deadline in the ticket drives the countdown in the UI and nothing else. A
//! bearer can edit their own copy — for a General invite it is not even
//! authenticated. The **authority is the inviter's own clock**, checked at
//! redemption against the sealed record in their vault (`invites.rs`). This field
//! exists so a holder knows when not to bother, not to enforce anything.

use anyhow::{anyhow, Result};
use iroh::EndpointAddr;
use serde::{Deserialize, Serialize};

/// Leading tag byte, joining the ticket family so one field routes them all.
pub const INVITE_TAG: u8 = 0x4E; // 'N'

/// Outer format version. Readable without any key (see the module note).
pub const FORMAT_V: u8 = 0x01;

const KIND_PERSONAL: u8 = 0x50; // 'P'
const KIND_GENERAL: u8 = 0x47; // 'G'

/// Bytes of the capability secret. 256 bits, so guessing is not a strategy.
pub const CAPABILITY_LEN: usize = 32;
/// Bytes of the invite id. Random, and meaningless on its own.
pub const INVITE_ID_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InviteKind {
    /// Sealed to one contact's key; only they can read it.
    Personal,
    /// Bearer credential in cleartext; anyone holding it can redeem it.
    General,
}

impl InviteKind {
    fn tag(self) -> u8 {
        match self {
            InviteKind::Personal => KIND_PERSONAL,
            InviteKind::General => KIND_GENERAL,
        }
    }
    fn from_tag(b: u8) -> Option<Self> {
        match b {
            KIND_PERSONAL => Some(InviteKind::Personal),
            KIND_GENERAL => Some(InviteKind::General),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            InviteKind::Personal => "personal",
            InviteKind::General => "general",
        }
    }
}

/// Where to reach the inviter to redeem. One variant per transport, so an
/// invitation works identically with Tor on or off and neither leaks the other's
/// address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum InviteAddr {
    /// Direct QUIC: the inviter's dialable addresses. Carries their IP, exactly
    /// as an ordinary clearnet ticket does — which is why the clearnet variants
    /// cost more Privacy MANA than the Tor ones.
    Iroh(Vec<EndpointAddr>),
    /// The inviter's onion address. No IP.
    Tor(String),
}

impl InviteAddr {
    pub fn is_tor(&self) -> bool {
        matches!(self, InviteAddr::Tor(_))
    }
}

/// Everything the redeemer needs, and nothing more.
///
/// Note what is absent and must stay absent: room name, gossip topic, room code,
/// MLS key material, the recipient's identity (a Personal ticket must not name its
/// own recipient — that would tell whoever photographs it who was invited).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteBody {
    /// Names the record in the inviter's vault. Random; reveals nothing alone.
    pub invite_id: [u8; INVITE_ID_LEN],
    /// The secret proven (never transmitted) at redemption.
    pub capability: [u8; CAPABILITY_LEN],
    /// The inviter's NodeId, so the redeemer knows who they are about to dial.
    pub inviter: String,
    pub addr: InviteAddr,
    /// Unix ms. Display only — see the module note on advisory deadlines.
    pub issued_at: u64,
    pub expires_at: u64,
}

fn aad(kind: InviteKind) -> [u8; 3] {
    [INVITE_TAG, FORMAT_V, kind.tag()]
}

fn base32(buf: &[u8]) -> String {
    let mut text = data_encoding::BASE32_NOPAD.encode(buf);
    text.make_ascii_lowercase();
    text
}

fn unbase32(s: &str) -> Result<Vec<u8>> {
    Ok(data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?)
}

/// Encode a **General** (bearer, cleartext) invitation.
pub fn encode_general(body: &InviteBody) -> String {
    let mut buf = vec![INVITE_TAG, FORMAT_V, KIND_GENERAL];
    buf.extend_from_slice(&postcard::to_stdvec(body).expect("postcard::to_stdvec is infallible"));
    base32(&buf)
}

/// Encode a **Personal** invitation, sealed to `recipient_ed25519` — the raw bytes
/// of the contact's NodeId.
///
/// Fails if that NodeId is not a usable public key (off-curve, or small-order —
/// see `gervasius::x25519_from_ed25519_pk`), because sealing to it would produce
/// something that only looks sealed.
pub fn encode_personal(body: &InviteBody, recipient_ed25519: &[u8; 32]) -> Result<String> {
    let recipient_x = gervasius::x25519_from_ed25519_pk(recipient_ed25519)
        .map_err(|e| anyhow!("invite recipient key is unusable: {e}"))?;
    let plain = postcard::to_stdvec(body).expect("postcard::to_stdvec is infallible");
    let sealed = gervasius::seal_to(&recipient_x, &aad(InviteKind::Personal), &plain)
        .map_err(|e| anyhow!("sealing the invite failed: {e}"))?;

    let mut buf = vec![INVITE_TAG, FORMAT_V, KIND_PERSONAL];
    buf.extend_from_slice(&sealed);
    Ok(base32(&buf))
}

/// What a decode produced: the body, plus which kind it turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedInvite {
    pub kind: InviteKind,
    pub body: InviteBody,
}

/// Decode a ticket. `my_ed25519_seed` is this device's identity secret, needed
/// only to open a Personal invitation.
///
/// A Personal invitation addressed to somebody else fails here and is
/// indistinguishable from a corrupt one — deliberately: learning "this is a valid
/// invite, just not for you" would tell a stranger that a QR they photographed is
/// live, which is a fact they have no business having.
pub fn decode(s: &str, my_ed25519_seed: Option<&[u8; 32]>) -> Result<DecodedInvite> {
    let bytes = unbase32(s)?;
    if bytes.len() < 3 {
        return Err(anyhow!("not an invitation"));
    }
    if bytes[0] != INVITE_TAG {
        return Err(anyhow!("not an invitation"));
    }
    if bytes[1] != FORMAT_V {
        // The one case worth distinguishing: a newer format is not corruption,
        // and telling the user to update is actionable where "invalid" is not.
        return Err(anyhow!(
            "INVITE_VERSION: this invitation was made by a newer version of Enigma26"
        ));
    }
    let kind = InviteKind::from_tag(bytes[2]).ok_or_else(|| anyhow!("not an invitation"))?;
    let rest = &bytes[3..];

    let body: InviteBody = match kind {
        InviteKind::General => postcard::from_bytes(rest)?,
        InviteKind::Personal => {
            let seed = my_ed25519_seed
                .ok_or_else(|| anyhow!("this invitation is addressed to a specific device"))?;
            let my_x = gervasius::x25519_from_ed25519_sk(seed);
            let plain = gervasius::open_sealed(&my_x, &aad(InviteKind::Personal), rest)
                .map_err(|_| anyhow!("this invitation is not addressed to this device"))?;
            postcard::from_bytes(&plain)?
        }
    };
    Ok(DecodedInvite { kind, body })
}

/// Tag sniff for the join router, mirroring `p2p_tor::ticket_is_tor` and
/// `p2p_iroh::code_is_dht`. Cheap and key-free: it answers "is this an
/// invitation?", never "is it valid" or "is it mine".
pub fn is_invite_ticket(s: &str) -> bool {
    match unbase32(s) {
        Ok(bytes) => bytes.first() == Some(&INVITE_TAG),
        Err(_) => false,
    }
}

/// The kind of an invitation without opening it. A Personal invite's kind is
/// public by construction (it is the outer header byte); what stays hidden is its
/// contents and its recipient.
pub fn peek_kind(s: &str) -> Option<InviteKind> {
    let bytes = unbase32(s).ok()?;
    if bytes.first() != Some(&INVITE_TAG) || bytes.get(1) != Some(&FORMAT_V) {
        return None;
    }
    InviteKind::from_tag(*bytes.get(2)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8032 test vector 1 — a real Ed25519 pair, standing in for a NodeId.
    const SEED: [u8; 32] = [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ];
    const PK: [u8; 32] = [
        0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07,
        0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07,
        0x51, 0x1a,
    ];
    /// A second, unrelated pair — "somebody else".
    const OTHER_SEED: [u8; 32] = [
        0x4c, 0xcd, 0x08, 0x9b, 0x28, 0xff, 0x96, 0xda, 0x9d, 0xb6, 0xc3, 0x46, 0xec, 0x11, 0x4e,
        0x0f, 0x5b, 0x8a, 0x31, 0x9f, 0x35, 0xab, 0xa6, 0x24, 0xda, 0x8c, 0xf6, 0xed, 0x4f, 0xb8,
        0xa6, 0xfb,
    ];

    fn body() -> InviteBody {
        InviteBody {
            invite_id: [7u8; INVITE_ID_LEN],
            capability: [9u8; CAPABILITY_LEN],
            inviter: "inviter-node-id".to_string(),
            addr: InviteAddr::Tor("abcdefghij.onion".to_string()),
            issued_at: 1_700_000_000_000,
            expires_at: 1_700_003_600_000,
        }
    }

    // ── round trips ──────────────────────────────────────────────────────────

    #[test]
    fn a_general_invite_round_trips_without_any_key() {
        let text = encode_general(&body());
        let got = decode(&text, None).unwrap();
        assert_eq!(got.kind, InviteKind::General);
        assert_eq!(got.body, body());
    }

    #[test]
    fn a_personal_invite_round_trips_for_its_recipient() {
        let text = encode_personal(&body(), &PK).unwrap();
        let got = decode(&text, Some(&SEED)).unwrap();
        assert_eq!(got.kind, InviteKind::Personal);
        assert_eq!(got.body, body());
    }

    #[test]
    fn a_personal_invite_is_opaque_to_everyone_else() {
        let text = encode_personal(&body(), &PK).unwrap();
        assert!(decode(&text, Some(&OTHER_SEED)).is_err());
        assert!(decode(&text, None).is_err());
    }

    #[test]
    fn a_personal_invite_leaks_nothing_in_its_encoding() {
        // The capability, the inviter and the address must not be readable from
        // the ticket text by anyone but the recipient.
        let text = encode_personal(&body(), &PK).unwrap();
        let raw = unbase32(&text).unwrap();
        assert!(!raw.windows(4).any(|w| w == [9u8; 4]), "capability bytes visible");
        assert!(!raw.windows(7).any(|w| w == b"inviter"), "inviter visible");
        assert!(!raw.windows(5).any(|w| w == b"onion"), "address visible");
        // And it does not name its own recipient.
        assert!(!raw.windows(8).any(|w| w == &PK[..8]), "recipient visible");
    }

    #[test]
    fn a_general_invite_is_readable_by_anyone_and_says_so() {
        // The counterpart claim, pinned so nobody later assumes otherwise: a
        // bearer invite really is cleartext.
        let text = encode_general(&body());
        let raw = unbase32(&text).unwrap();
        assert!(raw.windows(7).any(|w| w == b"inviter"));
        assert_eq!(decode(&text, None).unwrap().body, body());
    }

    // ── routing ──────────────────────────────────────────────────────────────

    #[test]
    fn the_tag_routes_an_invitation_and_nothing_else() {
        assert!(is_invite_ticket(&encode_general(&body())));
        assert!(is_invite_ticket(&encode_personal(&body(), &PK).unwrap()));
        // Base32 of the other tag families must not be claimed.
        for tag in [0x49u8, 0x54, 0x44] {
            let text = base32(&[tag, 0x00, 0x01]);
            assert!(!is_invite_ticket(&text), "tag {tag:#x} misrouted");
        }
        assert!(!is_invite_ticket("not base32 at all !!!"));
        assert!(!is_invite_ticket(""));
    }

    #[test]
    fn whitespace_and_case_are_tolerated_like_every_other_ticket() {
        let text = encode_general(&body());
        assert!(is_invite_ticket(&format!("  {}  ", text.to_uppercase())));
        assert_eq!(decode(&format!("  {text}  "), None).unwrap().body, body());
    }

    #[test]
    fn the_kind_is_visible_without_opening_it() {
        assert_eq!(peek_kind(&encode_general(&body())), Some(InviteKind::General));
        assert_eq!(
            peek_kind(&encode_personal(&body(), &PK).unwrap()),
            Some(InviteKind::Personal)
        );
        assert_eq!(peek_kind("zzzz"), None);
    }

    // ── tampering ────────────────────────────────────────────────────────────

    #[test]
    fn a_tampered_personal_invite_fails_closed() {
        let text = encode_personal(&body(), &PK).unwrap();
        let raw = unbase32(&text).unwrap();
        // Header, ephemeral key, nonce and ciphertext respectively.
        for idx in [2usize, 5, 40, raw.len() - 1] {
            let mut bad = raw.clone();
            bad[idx] ^= 0x01;
            assert!(decode(&base32(&bad), Some(&SEED)).is_err(), "tamper at {idx} accepted");
        }
    }

    #[test]
    fn a_personal_body_cannot_be_relabelled_as_general() {
        // The kind byte is in the AAD, so swapping it breaks the seal instead of
        // handing an attacker a bearer credential.
        let text = encode_personal(&body(), &PK).unwrap();
        let mut raw = unbase32(&text).unwrap();
        raw[2] = KIND_GENERAL;
        assert!(decode(&base32(&raw), Some(&SEED)).is_err());
    }

    #[test]
    fn a_truncated_ticket_is_rejected() {
        let text = encode_general(&body());
        let raw = unbase32(&text).unwrap();
        assert!(decode(&base32(&raw[..2]), None).is_err());
        assert!(decode(&base32(&raw[..raw.len() / 2]), None).is_err());
    }

    // ── versioning ───────────────────────────────────────────────────────────

    #[test]
    fn a_future_version_asks_the_user_to_update_rather_than_calling_it_corrupt() {
        let mut raw = unbase32(&encode_general(&body())).unwrap();
        raw[1] = FORMAT_V + 1;
        let err = decode(&base32(&raw), None).unwrap_err().to_string();
        assert!(err.contains("INVITE_VERSION"), "got: {err}");
        // And peeking gives nothing rather than a wrong answer.
        assert_eq!(peek_kind(&base32(&raw)), None);
    }

    #[test]
    fn an_unknown_kind_byte_is_not_guessed_at() {
        let mut raw = unbase32(&encode_general(&body())).unwrap();
        raw[2] = 0x5A;
        assert!(decode(&base32(&raw), None).is_err());
    }

    // ── what must never be in a ticket ───────────────────────────────────────

    #[test]
    fn the_body_has_no_field_for_room_name_topic_or_mls_material() {
        // A structural guard: postcard is positional, so adding a field here
        // silently changes the wire format AND could smuggle room data into a QR.
        // If this assertion has to change, that is the moment to re-read the
        // module doc about what a ticket may carry.
        let encoded = postcard::to_stdvec(&body()).unwrap();
        let round: InviteBody = postcard::from_bytes(&encoded).unwrap();
        assert_eq!(round, body());
        // 16 id + 32 capability + a short string + a short onion + 2 varint times.
        assert!(encoded.len() < 128, "body unexpectedly large: {}", encoded.len());
    }

    #[test]
    fn an_unusable_recipient_key_is_refused_at_encode_time() {
        // Small-order: sealing to it would produce a blob anyone could open.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(encode_personal(&body(), &identity).is_err());
    }

    #[test]
    fn both_transports_survive_the_round_trip() {
        let mut b = body();
        b.addr = InviteAddr::Iroh(vec![]);
        let got = decode(&encode_general(&b), None).unwrap();
        assert_eq!(got.body.addr, InviteAddr::Iroh(vec![]));
        assert!(!got.body.addr.is_tor());
        assert!(body().addr.is_tor());
    }
}
