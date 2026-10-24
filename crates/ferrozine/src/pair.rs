//! Pairwise MLS channels: rotor between exactly two endpoints, for the length
//! of one connection.
//!
//! A file transfer or a call needs its bytes sealed end to end, but not a
//! long-lived group: the two sides meet, talk, and part. So the handshake runs
//! in-band, on the stream it protects, and the session dies with it:
//!
//! ```text
//! caller                                  callee
//!   Caller::start ── KeyPackage ─────────▶ accept: create a 2-member group,
//!                                          add the caller
//!   Caller::join ◀──────────── Welcome ──
//!   Channel  ◀═════ MLS PrivateMessages ═════▶  Channel
//! ```
//!
//! Nothing here is persisted: each session uses rotor's in-memory storage and
//! is dropped with its [`Channel`]. There is no state to clean up after a
//! crash, and a stolen disk holds no transfer keys.
//!
//! **Authentication is not this module's job.** Whoever completes the
//! handshake gets a channel. What ties a channel to the *intended* peer is the
//! [`commitment`]: the caller publishes it over a channel that is already
//! authenticated (the room's own MLS group), and the callee refuses a
//! KeyPackage that does not match it. Only the holder of that KeyPackage's
//! private init key can then join.

use rotor_core::RotorSession;

use crate::error::{Error, Result};

fn mls(e: String) -> Error {
    Error::Mls(e)
}

/// `session.process_message(bytes)`, with the same result in every build.
///
/// openmls 0.7.4 `debug_assert!`s when a ciphertext fails to decrypt, on the
/// very path where a release build returns `AeadError`. A forged message from
/// anyone on the wire would therefore panic a debug build. The assert is the
/// only difference between the two paths, so catching its unwind leaves the
/// session exactly as the release build leaves it, and the caller gets the
/// release build's error.
pub(crate) fn process(session: &mut RotorSession, bytes: &[u8]) -> Result<Option<Vec<u8>>> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        session.process_message(bytes)
    })) {
        Ok(result) => result.map_err(mls),
        Err(_) => Err(Error::Mls("ciphertext decryption failed".into())),
    }
}

/// Base64 (standard, padded) — how KeyPackages and Welcomes travel in JSON.
pub fn b64(bytes: &[u8]) -> String {
    data_encoding::BASE64.encode(bytes)
}

/// Decode [`b64`].
pub fn unb64(text: &str) -> Result<Vec<u8>> {
    data_encoding::BASE64
        .decode(text.as_bytes())
        .map_err(|e| Error::Decode(format!("base64: {e}")))
}

/// The commitment to a KeyPackage: BLAKE3 of its base64 text, as hex.
///
/// It hashes the base64 text rather than the raw bytes because that is what
/// Enigma's peers have always published; changing it would refuse every
/// transfer between old and new builds.
pub fn commitment(key_package: &[u8]) -> String {
    blake3::hash(b64(key_package).as_bytes())
        .to_hex()
        .to_string()
}

/// The dialling side, between sending its KeyPackage and receiving the Welcome.
pub struct Caller {
    session: RotorSession,
    key_package: Vec<u8>,
    context: String,
}

impl Caller {
    /// A fresh session for `context` (an offer or call id, which also names the
    /// MLS group) and its KeyPackage.
    pub fn start(context: &str, identity: &str) -> Result<Self> {
        let mut session =
            RotorSession::new(context.to_owned(), identity.to_owned()).map_err(mls)?;
        let key_package = session.key_package().map_err(mls)?;
        Ok(Self {
            session,
            key_package,
            context: context.to_owned(),
        })
    }

    /// The KeyPackage to send.
    pub fn key_package(&self) -> &[u8] {
        &self.key_package
    }

    /// [`commitment`] to this caller's KeyPackage.
    pub fn commitment(&self) -> String {
        commitment(&self.key_package)
    }

    /// Finish the handshake with the callee's Welcome.
    pub fn join(mut self, welcome: &[u8]) -> Result<Channel> {
        self.session.join_from_welcome(welcome).map_err(mls)?;
        Ok(Channel {
            session: self.session,
            context: self.context,
        })
    }
}

/// The accepting side: form the two-member group from the caller's
/// KeyPackage. Returns the channel and the Welcome to send back.
pub fn accept(context: &str, identity: &str, key_package: &[u8]) -> Result<(Channel, Vec<u8>)> {
    let mut session = RotorSession::new(context.to_owned(), identity.to_owned()).map_err(mls)?;
    session.create_group().map_err(mls)?;
    let (welcome, _commit) = session.add_member(key_package).map_err(mls)?;
    Ok((
        Channel {
            session,
            context: context.to_owned(),
        },
        welcome,
    ))
}

/// An established pairwise channel. Every message is an MLS PrivateMessage:
/// confidential, authenticated as coming from the other member, and refused
/// if replayed.
pub struct Channel {
    session: RotorSession,
    context: String,
}

impl Channel {
    /// Seal `plaintext` for the other side.
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        self.session.encrypt_app(plaintext).map_err(mls)
    }

    /// Open a message from the other side. Anything that is not an application
    /// message (a commit, a proposal) is refused: a pairwise channel never
    /// changes its membership.
    pub fn open(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        process(&mut self.session, ciphertext)?
            .ok_or_else(|| Error::Mls("not an application message".into()))
    }

    /// A key both sides derive identically (RFC 9420 exporter), bound to
    /// `label` and this channel's context — for media that is too fast to send
    /// through MLS frame by frame, such as call audio.
    pub fn export_secret(&self, label: &str, length: usize) -> Result<Vec<u8>> {
        self.session
            .export_secret(label, self.context.as_bytes(), length)
            .map_err(mls)
    }

    /// The context (offer or call id) the channel was made for.
    pub fn context(&self) -> &str {
        &self.context
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(ctx: &str) -> (Channel, Channel) {
        let caller = Caller::start(ctx, "peer").unwrap();
        let (callee, welcome) = accept(ctx, "host", caller.key_package()).unwrap();
        (caller.join(&welcome).unwrap(), callee)
    }

    #[test]
    fn both_directions_seal_and_open() {
        let (mut a, mut b) = pair("offer-1");
        let ct = a.seal(b"to b").unwrap();
        assert!(!ct.windows(4).any(|w| w == b"to b"), "nothing in the clear");
        assert_eq!(b.open(&ct).unwrap(), b"to b");
        let ct = b.seal(b"to a").unwrap();
        assert_eq!(a.open(&ct).unwrap(), b"to a");
    }

    #[test]
    fn a_replay_and_a_foreign_channel_are_refused() {
        let (mut a, mut b) = pair("offer-1");
        let ct = a.seal(b"once").unwrap();
        b.open(&ct).unwrap();
        assert!(b.open(&ct).is_err(), "replay");
        let (_c, mut d) = pair("offer-1");
        let ct = a.seal(b"for b").unwrap();
        assert!(d.open(&ct).is_err(), "another pair with the same context");
    }

    #[test]
    fn exported_secrets_match_across_the_pair_and_differ_by_label_and_context() {
        let (a, b) = pair("call-1");
        let ka = a.export_secret("x/c2s", 32).unwrap();
        assert_eq!(ka, b.export_secret("x/c2s", 32).unwrap());
        assert_ne!(ka, a.export_secret("x/s2c", 32).unwrap());
        let (c, _) = pair("call-2");
        assert_ne!(ka, c.export_secret("x/c2s", 32).unwrap());
    }

    #[test]
    fn the_commitment_is_enigmas_kp_hash() {
        // file_xfer.rs: blake3(base64(kp)).to_hex() — pinned so old and new
        // builds keep authorizing each other.
        let caller = Caller::start("o", "peer").unwrap();
        let expected = blake3::hash(
            data_encoding::BASE64
                .encode(caller.key_package())
                .as_bytes(),
        )
        .to_hex()
        .to_string();
        assert_eq!(caller.commitment(), expected);
        assert_eq!(caller.commitment().len(), 64);
        let other = Caller::start("o", "peer").unwrap();
        assert_ne!(caller.commitment(), other.commitment());
    }

    #[test]
    fn a_welcome_for_another_caller_does_not_join() {
        let alice = Caller::start("o", "peer").unwrap();
        let eve = Caller::start("o", "peer").unwrap();
        let (_host, welcome) = accept("o", "host", alice.key_package()).unwrap();
        assert!(eve.join(&welcome).is_err());
    }
}
