//! An Enigma device's identity and the two things it shows a friend (D1).
//!
//! - [`DeviceKey`]: a long-term ed25519 key. Its [`Fingerprint`] (16 bytes) is
//!   what both people compare by eye: [`fingerprint_words`] prints it as eight
//!   groups of four base32 letters.
//! - [`ContactCard`]: "here is me" — name, device key, an MLS key package,
//!   optionally the address of a Proteus that keeps a mailbox for me, and a
//!   one-time pairing token. Signed by the device key.
//! - [`PairReply`]: the scanner's answer — its own card plus the MLS welcome
//!   that starts the friendship. Shown back as a second QR / text, or, when the
//!   first card names a Proteus, left there under the pairing token.
//!
//! - [`ProteusCode`]: "here is a Proteus" — its onion and its name. Proteus
//!   shows it on its own page (and `proteus code` prints it); Enigma takes it
//!   to connect, so nobody types a 56-character address on a phone.
//!
//! All travel as text: a prefix (`pharos-card:` / `pharos-reply:` / `pharos-proteus:`) and
//! base32 of the postcard bytes, which fits in a QR code and survives being
//! pasted into a chat.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use pharos_rendezvous::{fingerprint, Fingerprint};
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;

pub const CARD_PREFIX: &str = "pharos-card:";
pub const REPLY_PREFIX: &str = "pharos-reply:";
pub const PROTEUS_PREFIX: &str = "pharos-proteus:";
const VERSION: u8 = 1;
/// A card older than this is refused, so a photographed QR goes stale.
pub const CARD_TTL_SECS: u64 = 7 * 24 * 3600;
const MAX_NAME_CHARS: usize = 64;
const MAX_TEXT: usize = 16 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IdError {
    #[error("not a Pharos {0}")]
    Prefix(&'static str),
    #[error("malformed: {0}")]
    Malformed(String),
    #[error("unsupported version {0}")]
    Version(u8),
    #[error("signature does not verify")]
    Signature,
    #[error("the card has expired")]
    Expired,
    #[error("the name is empty or longer than {MAX_NAME_CHARS} characters")]
    Name,
}

pub type Result<T> = std::result::Result<T, IdError>;

/// This device's long-term key.
pub struct DeviceKey(SigningKey);

impl DeviceKey {
    pub fn generate() -> Self {
        DeviceKey(SigningKey::generate(&mut rand_core::OsRng))
    }
    pub fn from_bytes(secret: &[u8; 32]) -> Self {
        DeviceKey(SigningKey::from_bytes(secret))
    }
    pub fn to_bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }
    pub fn public(&self) -> [u8; 32] {
        self.0.verifying_key().to_bytes()
    }
    pub fn fingerprint(&self) -> Fingerprint {
        fingerprint(&self.public())
    }
    /// The MLS identity string for this device (hex of the fingerprint).
    pub fn mls_identity(&self) -> String {
        hex(&self.fingerprint())
    }
    fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.0.sign(msg).to_bytes()
    }
}

pub fn hex(b: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(b)
}

/// "ABCD EFGH …": six groups of four (120 of the 128 bits), for reading aloud or comparing.
pub fn fingerprint_words(fp: &Fingerprint) -> String {
    let s = data_encoding::BASE32_NOPAD.encode(fp);
    s.as_bytes()[..24].chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardBody {
    pub v: u8,
    pub name: String,
    pub device: [u8; 32],
    pub key_package: Vec<u8>,
    /// A Proteus onion that will hold this person's mailbox and accept a pairing reply.
    pub proteus: Option<String>,
    /// One-time: a reply left on Proteus under this token reaches the card's owner.
    pub pairing_token: [u8; 16],
    pub issued_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContactCard {
    pub body: CardBody,
    #[serde(with = "BigArray")]
    pub sig: [u8; 64],
}

fn check_name(name: &str) -> Result<()> {
    let n = name.trim().chars().count();
    if n == 0 || n > MAX_NAME_CHARS {
        return Err(IdError::Name);
    }
    Ok(())
}

fn to_text(prefix: &str, bytes: &[u8]) -> String {
    format!("{prefix}{}", data_encoding::BASE32_NOPAD.encode(bytes))
}

fn from_text(prefix: &'static str, text: &str) -> Result<Vec<u8>> {
    let t: String = text.trim().chars().filter(|c| !c.is_whitespace()).collect();
    if t.len() > MAX_TEXT * 2 {
        return Err(IdError::Malformed("too long".into()));
    }
    // The prefix in any case: a QR reader or a person may upper-case it all.
    let rest = match t.get(..prefix.len()) {
        Some(p) if p.eq_ignore_ascii_case(prefix) => &t[prefix.len()..],
        _ => return Err(IdError::Prefix(prefix)),
    };
    data_encoding::BASE32_NOPAD
        .decode(rest.to_uppercase().as_bytes())
        .map_err(|e| IdError::Malformed(e.to_string()))
}

impl ContactCard {
    pub fn new(
        key: &DeviceKey,
        name: &str,
        key_package: Vec<u8>,
        proteus: Option<String>,
        pairing_token: [u8; 16],
        now_secs: u64,
    ) -> Result<Self> {
        check_name(name)?;
        let body = CardBody {
            v: VERSION,
            name: name.trim().to_string(),
            device: key.public(),
            key_package,
            proteus,
            pairing_token,
            issued_secs: now_secs,
        };
        let sig = key.sign(&postcard::to_stdvec(&body).unwrap());
        Ok(ContactCard { body, sig })
    }

    pub fn fingerprint(&self) -> Fingerprint {
        fingerprint(&self.body.device)
    }

    pub fn to_text(&self) -> String {
        to_text(CARD_PREFIX, &postcard::to_stdvec(self).unwrap())
    }

    /// Parse and verify: prefix, version, name, signature, age.
    pub fn from_text(text: &str, now_secs: u64) -> Result<Self> {
        let bytes = from_text(CARD_PREFIX, text)?;
        let c: ContactCard = postcard::from_bytes(&bytes).map_err(|e| IdError::Malformed(e.to_string()))?;
        c.verify(now_secs)?;
        Ok(c)
    }

    pub fn verify(&self, now_secs: u64) -> Result<()> {
        if self.body.v != VERSION {
            return Err(IdError::Version(self.body.v));
        }
        check_name(&self.body.name)?;
        let vk = VerifyingKey::from_bytes(&self.body.device).map_err(|_| IdError::Signature)?;
        vk.verify(&postcard::to_stdvec(&self.body).unwrap(), &Signature::from_bytes(&self.sig))
            .map_err(|_| IdError::Signature)?;
        if now_secs.saturating_sub(self.body.issued_secs) > CARD_TTL_SECS
            || self.body.issued_secs > now_secs + 3600
        {
            return Err(IdError::Expired);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyBody {
    pub card: ContactCard,
    /// Binds the reply to the card it answers.
    pub to_fingerprint: Fingerprint,
    pub welcome: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairReply {
    pub body: ReplyBody,
    #[serde(with = "BigArray")]
    pub sig: [u8; 64],
}

impl PairReply {
    pub fn new(key: &DeviceKey, my_card: ContactCard, to: &ContactCard, welcome: Vec<u8>) -> Self {
        let body = ReplyBody { card: my_card, to_fingerprint: to.fingerprint(), welcome };
        let sig = key.sign(&postcard::to_stdvec(&body).unwrap());
        PairReply { body, sig }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        postcard::to_stdvec(self).unwrap()
    }

    pub fn to_text(&self) -> String {
        to_text(REPLY_PREFIX, &self.to_bytes())
    }

    pub fn from_bytes(bytes: &[u8], me: &Fingerprint, now_secs: u64) -> Result<Self> {
        let r: PairReply = postcard::from_bytes(bytes).map_err(|e| IdError::Malformed(e.to_string()))?;
        r.body.card.verify(now_secs)?;
        if &r.body.to_fingerprint != me {
            return Err(IdError::Malformed("this reply is for someone else".into()));
        }
        let vk = VerifyingKey::from_bytes(&r.body.card.body.device).map_err(|_| IdError::Signature)?;
        vk.verify(&postcard::to_stdvec(&r.body).unwrap(), &Signature::from_bytes(&r.sig))
            .map_err(|_| IdError::Signature)?;
        Ok(r)
    }

    pub fn from_text(text: &str, me: &Fingerprint, now_secs: u64) -> Result<Self> {
        Self::from_bytes(&from_text(REPLY_PREFIX, text)?, me, now_secs)
    }
}

/// A Proteus, as its page shows it: the onion service's identity key and a name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProteusCode {
    pub v: u8,
    /// The onion's ed25519 identity key; the address is derived from it, so a
    /// code cannot carry a mistyped address.
    pub onion: [u8; 32],
    pub name: String,
}

impl ProteusCode {
    /// The code for the Proteus at `onion_address`, called `name`.
    pub fn new(onion_address: &str, name: &str) -> Result<Self> {
        check_name(name)?;
        let onion = pharos_rendezvous::parse_onion(onion_address)
            .ok_or_else(|| IdError::Malformed("not a Tor v3 onion address".into()))?;
        Ok(ProteusCode { v: VERSION, onion, name: name.trim().to_string() })
    }

    pub fn onion_address(&self) -> String {
        pharos_rendezvous::onion_address(&self.onion)
    }

    pub fn to_text(&self) -> String {
        to_text(PROTEUS_PREFIX, &postcard::to_stdvec(self).unwrap())
    }

    pub fn from_text(text: &str) -> Result<Self> {
        let bytes = from_text(PROTEUS_PREFIX, text)?;
        let c: ProteusCode = postcard::from_bytes(&bytes).map_err(|e| IdError::Malformed(e.to_string()))?;
        if c.v != VERSION {
            return Err(IdError::Version(c.v));
        }
        check_name(&c.name)?;
        Ok(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_790_000_000;

    fn card(k: &DeviceKey, name: &str) -> ContactCard {
        ContactCard::new(k, name, vec![1, 2, 3], Some("x.onion".into()), [5; 16], NOW).unwrap()
    }

    #[test]
    fn card_round_trips_as_text() {
        let k = DeviceKey::generate();
        let c = card(&k, "Alice");
        let t = c.to_text();
        assert!(t.starts_with(CARD_PREFIX));
        assert_eq!(ContactCard::from_text(&t, NOW + 60).unwrap(), c);
        // Lower-case and line breaks (a chat app re-wrapping it) still parse.
        let body = t[CARD_PREFIX.len()..].to_lowercase();
        let mangled = format!("{CARD_PREFIX}{}\n  {}", &body[..20], &body[20..]);
        assert_eq!(ContactCard::from_text(&mangled, NOW).unwrap(), c);
    }

    #[test]
    fn tampered_expired_or_foreign_cards_are_refused() {
        let k = DeviceKey::generate();
        let mut c = card(&k, "Alice");
        c.body.name = "Mallory".into();
        assert_eq!(ContactCard::from_text(&c.to_text(), NOW).unwrap_err(), IdError::Signature);
        let c = card(&k, "Alice");
        assert_eq!(ContactCard::from_text(&c.to_text(), NOW + CARD_TTL_SECS + 1).unwrap_err(), IdError::Expired);
        assert_eq!(ContactCard::from_text("hello", NOW).unwrap_err(), IdError::Prefix(CARD_PREFIX));
        assert!(ContactCard::new(&k, "  ", vec![], None, [0; 16], NOW).is_err());
        assert!(ContactCard::new(&k, &"n".repeat(65), vec![], None, [0; 16], NOW).is_err());
    }

    #[test]
    fn reply_is_bound_to_the_card_it_answers() {
        let (a, b) = (DeviceKey::generate(), DeviceKey::generate());
        let ca = card(&a, "Alice");
        let r = PairReply::new(&b, card(&b, "Bob"), &ca, vec![9; 100]);
        let got = PairReply::from_text(&r.to_text(), &a.fingerprint(), NOW).unwrap();
        assert_eq!(got.body.welcome, vec![9; 100]);
        assert_eq!(got.body.card.body.name, "Bob");
        let carol = DeviceKey::generate();
        assert!(PairReply::from_text(&r.to_text(), &carol.fingerprint(), NOW).is_err());
        // A reply re-signed by someone else than the card inside it is refused.
        let mut forged = r.clone();
        forged.sig = PairReply::new(&carol, card(&b, "Bob"), &ca, vec![9; 100]).sig;
        assert_eq!(PairReply::from_bytes(&forged.to_bytes(), &a.fingerprint(), NOW).unwrap_err(), IdError::Signature);
    }

    #[test]
    fn proteus_codes_round_trip_and_carry_a_checked_address() {
        let onion = pharos_rendezvous::onion_address(&[7u8; 32]);
        let c = ProteusCode::new(&onion, "  Alice's Pi ").unwrap();
        assert_eq!(c.name, "Alice's Pi");
        assert_eq!(c.onion_address(), onion);
        let t = c.to_text();
        assert!(t.starts_with(PROTEUS_PREFIX));
        assert_eq!(ProteusCode::from_text(&t).unwrap(), c);
        // Upper-cased whole (a QR reader in alphanumeric mode), wrapped, padded.
        let shouty = format!("  {}\n", t.to_uppercase());
        assert_eq!(ProteusCode::from_text(&shouty).unwrap(), c);
        // Not a code, a card, a mistyped address, a nameless one.
        assert_eq!(ProteusCode::from_text("hello").unwrap_err(), IdError::Prefix(PROTEUS_PREFIX));
        assert!(ProteusCode::from_text(&format!("{PROTEUS_PREFIX}AAAA")).is_err());
        let mut typo = onion.into_bytes();
        typo[3] = if typo[3] == b'a' { b'b' } else { b'a' };
        assert!(ProteusCode::new(std::str::from_utf8(&typo).unwrap(), "x").is_err());
        assert!(ProteusCode::new(&pharos_rendezvous::onion_address(&[1; 32]), " ").is_err());
        let k = DeviceKey::generate();
        assert!(ProteusCode::from_text(&card(&k, "Alice").to_text()).is_err());
    }

    #[test]
    fn fingerprint_words_are_six_groups() {
        let k = DeviceKey::from_bytes(&[1; 32]);
        let w = fingerprint_words(&k.fingerprint());
        assert_eq!(w.split(' ').count(), 6);
        assert!(w.split(' ').all(|g| g.len() == 4));
        assert_eq!(k.mls_identity().len(), 32);
        assert_eq!(DeviceKey::from_bytes(&k.to_bytes()).public(), k.public());
    }
}
