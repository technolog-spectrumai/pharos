//! The group key, and what it seals.
//!
//! Behind the `mls` feature. Without it a session is protected by iroh's QUIC
//! alone, which for TWO peers is genuinely end to end — a relay forwards
//! packets it cannot open. The measured case for turning it on anyway:
//!
//!   * **post-compromise security.** TLS gives forward secrecy; MLS adds
//!     recovery, so a key stolen today stops working after the next rekey.
//!   * **it is the price of a third peer.** On a gossip topic with three or
//!     more members, a peer FORWARDS for its neighbours — it decrypts and
//!     re-broadcasts. Transport encryption cannot survive that; one group key
//!     can. Step 31 needs this, so it is built now while the two-peer case is
//!     simple enough to reason about.
//!
//! Cost, measured on this machine in release: 116 µs per message one-way,
//! independent of size; +146 B per frame; 2.4 ms for the handshake, once. At
//! 20 Hz live strokes plus 5 Hz of ops that is ~2.9 ms of CPU per second —
//! 0.3% of one core.
//!
//! THE SHAPE, and why it is this way. The host creates the group before its QR
//! is ever shown; the joiner's key package rides in `Hello`; the host answers
//! with a Welcome inside the `Welcome` frame, which is also its Accept. So the
//! group is formed at exactly the moment a human compared six digits on two
//! screens — the SAS authenticates the handshake rather than sitting beside
//! it. Basic credentials, no PKI: identity here is the endpoint id, which the
//! SAS binds. This mirrors `vox.rs:322-347` in enigma, minus the vault.
//!
//! WHAT IS SEALED: `Op`, `Snapshot`, `Live` and `Cursor` — everything carrying
//! a shape, a stroke or a position. NOT `Hello`/`Welcome` (they carry the
//! handshake that bootstraps the key), and not `Resync`/`Bye`, which are bare
//! signals with no payload. An observer who breaks the transport still learns
//! only that a session exists and roughly how busy it is.
//!
//! Sessions live in memory only. `RotorSession` can `export_state`, and this
//! deliberately does not use it: a drawing session is minutes long, and a
//! group key persisted to disk outlives the reason it existed.

use rotor_core::RotorSession;

use crate::frame::Frame;

/// One side's view of the group.
pub struct Group {
    session: RotorSession,
    /// False until the group actually exists — the host between `new` and
    /// `create_group`, or a joiner that has not yet had its Welcome.
    ready: bool,
}

impl Group {
    /// The host's side: a group of one, created before the ticket is shown.
    ///
    /// `topic` scopes the group the way enigma scopes one per room; here the
    /// session IS the scope, so the topic bytes are the natural name.
    pub fn host(topic: &[u8; 32], identity: &str) -> Result<Self, String> {
        let mut session = RotorSession::new(name_for(topic), identity.to_string())
            .map_err(|e| format!("mls_init: {e}"))?;
        session.create_group().map_err(|e| format!("mls_create: {e}"))?;
        Ok(Self { session, ready: true })
    }

    /// The joiner's side: an identity and a key package, no group yet.
    pub fn joiner(topic: &[u8; 32], identity: &str) -> Result<(Self, Vec<u8>), String> {
        let mut session = RotorSession::new(name_for(topic), identity.to_string())
            .map_err(|e| format!("mls_init: {e}"))?;
        let kp = session.key_package().map_err(|e| format!("mls_key_package: {e}"))?;
        Ok((Self { session, ready: false }, kp))
    }

    /// HOST: admit a key package. Returns the Welcome to put in the `Welcome`
    /// frame. Called only for a peer the admission gate has already passed.
    pub fn admit(&mut self, key_package: &[u8]) -> Result<Vec<u8>, String> {
        if key_package.is_empty() {
            return Err("mls_missing: the peer sent no key package".into());
        }
        let (welcome, _commit) = self
            .session
            .add_member(key_package)
            .map_err(|e| format!("mls_add_member: {e}"))?;
        Ok(welcome)
    }

    /// JOINER: take the Welcome and become a member.
    pub fn accept(&mut self, welcome: &[u8]) -> Result<(), String> {
        if welcome.is_empty() {
            return Err("mls_missing: the host sent no welcome".into());
        }
        self.session
            .join_from_welcome(welcome)
            .map_err(|e| format!("mls_join: {e}"))?;
        self.ready = true;
        Ok(())
    }

    pub fn ready(&self) -> bool {
        self.ready
    }

    /// Seal a frame's payload in place. A frame with nothing to hide is
    /// returned untouched — see the header for which those are and why.
    pub fn seal(&mut self, frame: Frame) -> Result<Frame, String> {
        if !self.ready {
            return Ok(frame);
        }
        Ok(match frame {
            Frame::Op { seq, bytes } => Frame::Op { seq, bytes: self.encrypt(&bytes)? },
            Frame::Snapshot { seq, width, height, bytes } => {
                Frame::Snapshot { seq, width, height, bytes: self.encrypt(&bytes)? }
            }
            Frame::Live { bytes } => Frame::Live { bytes: self.encrypt(&bytes)? },
            // A cursor is two floats; sealing it means carrying them as bytes.
            Frame::Cursor { x, y } => {
                let plain = [x.to_le_bytes(), y.to_le_bytes()].concat();
                Frame::Live { bytes: self.encrypt(&cursor_tag(&plain))? }
            }
            other => other,
        })
    }

    /// Open a sealed frame. Fails loudly: a frame that will not decrypt is not
    /// noise to skip past, it is a peer that is not in this group.
    pub fn open(&mut self, frame: Frame) -> Result<Frame, String> {
        if !self.ready {
            return Ok(frame);
        }
        Ok(match frame {
            Frame::Op { seq, bytes } => Frame::Op { seq, bytes: self.decrypt(&bytes)? },
            Frame::Snapshot { seq, width, height, bytes } => {
                Frame::Snapshot { seq, width, height, bytes: self.decrypt(&bytes)? }
            }
            Frame::Live { bytes } => {
                let plain = self.decrypt(&bytes)?;
                match untag_cursor(&plain) {
                    Some((x, y)) => Frame::Cursor { x, y },
                    None => Frame::Live { bytes: plain },
                }
            }
            other => other,
        })
    }

    fn encrypt(&mut self, plain: &[u8]) -> Result<Vec<u8>, String> {
        self.session.encrypt_app(plain).map_err(|e| format!("mls_encrypt: {e}"))
    }

    fn decrypt(&mut self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        match self.session.process_message(sealed) {
            Ok(Some(plain)) => Ok(plain),
            // A handshake message (a commit, a rekey) — real traffic, but it
            // carries no application payload for the caller.
            Ok(None) => Ok(Vec::new()),
            Err(e) => Err(format!("mls_decrypt: {e}")),
        }
    }
}

/// A cursor sealed as a `Live` frame is tagged so the far side can tell the
/// two apart after decryption. One byte, and it must not collide with the
/// JSON a real `Live` payload carries — which always starts with `{` or `n`.
const CURSOR_TAG: u8 = 0x01;

fn cursor_tag(coords: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(coords.len() + 1);
    out.push(CURSOR_TAG);
    out.extend_from_slice(coords);
    out
}

fn untag_cursor(plain: &[u8]) -> Option<(f32, f32)> {
    if plain.len() != 9 || plain[0] != CURSOR_TAG {
        return None;
    }
    let x = f32::from_le_bytes(plain[1..5].try_into().ok()?);
    let y = f32::from_le_bytes(plain[5..9].try_into().ok()?);
    Some((x, y))
}

/// A stable group name from the topic. Hex rather than the raw bytes because
/// rotor takes a String and the topic is not valid UTF-8.
fn name_for(topic: &[u8; 32]) -> String {
    topic.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOPIC: [u8; 32] = [7u8; 32];

    /// Host and joiner, through the full handshake — the `vox.rs` pattern.
    fn pair() -> (Group, Group) {
        let mut host = Group::host(&TOPIC, "host-id").expect("host group");
        let (mut joiner, kp) = Group::joiner(&TOPIC, "joiner-id").expect("joiner");
        assert!(!joiner.ready(), "no group until the Welcome arrives");
        let welcome = host.admit(&kp).expect("admit");
        joiner.accept(&welcome).expect("accept");
        assert!(joiner.ready());
        (host, joiner)
    }

    #[test]
    fn a_sealed_op_round_trips() {
        let (mut host, mut joiner) = pair();
        let sealed = host.seal(Frame::Op { seq: 3, bytes: b"{\"k\":\"up\"}".to_vec() }).unwrap();
        match &sealed {
            Frame::Op { seq, bytes } => {
                assert_eq!(*seq, 3, "the sequence stays in the clear — the receiver needs it");
                assert_ne!(bytes.as_slice(), b"{\"k\":\"up\"}", "the payload is not plaintext");
            }
            other => panic!("expected Op, got {other:?}"),
        }
        assert_eq!(
            joiner.open(sealed).unwrap(),
            Frame::Op { seq: 3, bytes: b"{\"k\":\"up\"}".to_vec() },
        );
    }

    #[test]
    fn a_snapshot_keeps_its_board_size_in_the_clear() {
        // Width and height are how the joiner sizes its canvas before it can
        // read anything; sealing them would be a chicken and egg.
        let (mut host, mut joiner) = pair();
        let sealed = host
            .seal(Frame::Snapshot { seq: 1, width: 1920, height: 1080, bytes: b"doc".to_vec() })
            .unwrap();
        assert!(matches!(sealed, Frame::Snapshot { width: 1920, height: 1080, .. }));
        assert_eq!(
            joiner.open(sealed).unwrap(),
            Frame::Snapshot { seq: 1, width: 1920, height: 1080, bytes: b"doc".to_vec() },
        );
    }

    #[test]
    fn a_cursor_survives_being_sealed_as_a_live_frame() {
        let (mut host, mut joiner) = pair();
        let sealed = host.seal(Frame::Cursor { x: 12.5, y: -3.25 }).unwrap();
        assert!(matches!(sealed, Frame::Live { .. }), "on the wire it is indistinguishable");
        assert_eq!(joiner.open(sealed).unwrap(), Frame::Cursor { x: 12.5, y: -3.25 });
    }

    #[test]
    fn a_live_stroke_is_not_mistaken_for_a_cursor() {
        // The tag byte must not collide with a real payload — a 9-byte stroke
        // starting with 0x01 would otherwise decode as a pointer position.
        let (mut host, mut joiner) = pair();
        let stroke = b"{\"pts\":[]}".to_vec();
        let sealed = host.seal(Frame::Live { bytes: stroke.clone() }).unwrap();
        assert_eq!(joiner.open(sealed).unwrap(), Frame::Live { bytes: stroke });
    }

    #[test]
    fn signals_are_left_alone() {
        // Resync and Bye carry nothing; sealing them would cost a rekey and
        // hide nothing that the timing does not already reveal.
        let (mut host, _joiner) = pair();
        assert_eq!(host.seal(Frame::Resync).unwrap(), Frame::Resync);
        assert_eq!(host.seal(Frame::Bye).unwrap(), Frame::Bye);
    }

    #[test]
    fn a_foreign_group_cannot_read_the_traffic() {
        // The property the whole feature exists for. Lifted from enigma's
        // `file_xfer.rs:943`, which pins the same thing for a file transfer.
        let (mut host, _joiner) = pair();
        let (mut outsider, _) = pair(); // a different group entirely
        let sealed = host.seal(Frame::Op { seq: 1, bytes: b"secret".to_vec() }).unwrap();
        let err = outsider.open(sealed).unwrap_err();
        assert!(err.starts_with("mls_decrypt"), "{err}");
    }

    #[test]
    fn an_empty_key_package_is_refused_rather_than_fed_to_openmls() {
        let mut host = Group::host(&TOPIC, "host-id").unwrap();
        let err = host.admit(&[]).unwrap_err();
        assert!(err.starts_with("mls_missing"), "{err}");
    }

    #[test]
    fn nothing_is_sealed_before_the_group_exists() {
        // A joiner that has not had its Welcome must pass frames through
        // untouched rather than encrypt to a group it is not in.
        let (joiner, _kp) = Group::joiner(&TOPIC, "joiner-id").unwrap();
        let mut joiner = joiner;
        assert!(!joiner.ready());
        let f = Frame::Op { seq: 1, bytes: b"plain".to_vec() };
        assert_eq!(joiner.seal(f.clone()).unwrap(), f);
    }
}
