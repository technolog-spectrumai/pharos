// The live session: two peers on one iroh-gossip topic.
//
// Adapted from enigma's `p2p_iroh.rs`, with everything app-specific left
// behind — no profile, no vault, no DHT, no Tor, no `AppHandle`. What arrives
// here is the ~280 lines that are actually about moving bytes between two
// endpoints, plus the three bounds a bearer ticket needs (see `ticket.rs`).
//
// TWO THINGS THIS DOES THAT ENIGMA DOES NOT, both deliberate:
//
//   * `Lagged` is SURFACED, not swallowed. Enigma's receive loop has
//     `Event::Lagged => {}` — an empty arm, no comment (`p2p_iroh.rs:637`).
//     Under backpressure gossip drops messages; for chat that loses a line,
//     for a document that must converge it means a board is silently missing
//     shapes. Here it becomes an `Event::Lagged` the caller answers with a
//     resync.
//
//   * The sender is KEPT. Enigma discards `delivered_from` (`p2p_iroh.rs:607`)
//     because a chat message carries its own author. A drawing needs to know
//     who drew what — per-author undo depends on it.
//
// THE ADMISSION RULES live here rather than in the frontend, because a rule the
// UI enforces is a rule an attacker skips: `PendingTicket` below is the state
// machine, and it is pure data, so every one of its properties is tested with
// no network at all.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iroh::address_lookup::memory::MemoryLookup;
use iroh::{protocol::Router, Endpoint, EndpointAddr, RelayMode};
use iroh_gossip::{api::Event as GossipEvent, net::Gossip, proto::TopicId, ALPN as GOSSIP_ALPN};
use tokio::sync::{mpsc, Mutex};

use crate::frame::{self, Frame, SeqTracker};
use crate::ticket::{TicketV1, TICKET_TTL_MS};

/// Milliseconds since the epoch. The host's clock is the authority for
/// admission; see `ticket.rs`.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How long to wait for a joiner's `Hello` after it lands on the topic. Past
/// this it is a peer that subscribed without pairing, and it is dropped.
const HELLO_WAIT: Duration = Duration::from_secs(20);

/// What a session is allowed to reach.
#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// n0's relays and discovery. On, a peer behind NAT can still be reached
    /// and the relay forwards QUIC packets it cannot read. Off, it is direct
    /// connections only — no third party, and two home routers will not meet.
    pub relays: bool,
    /// Cap on one gossip message. The default is a few KB; a snapshot of a
    /// full board needs more.
    pub max_message_size: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self { relays: true, max_message_size: 1024 * 1024 }
    }
}

/// What the caller learns. Deliberately not Tauri events: the app decides how
/// these reach a window, and a library that emitted them could only serve one.
#[derive(Debug, Clone)]
pub enum Event {
    /// A peer completed the handshake. Carries its endpoint id so the caller
    /// can derive the short-auth-string.
    PeerUp { peer: String },
    PeerDown { peer: String },
    /// A frame from a peer. `from` is kept — enigma drops it.
    Frame { from: String, frame: Frame },
    /// The receiver fell behind and messages were DROPPED. Answer with a
    /// resync; do not treat as informational.
    Lagged,
    Closed,
}

/// The host's side of the pairing bargain.
///
/// Pure data, no network — which is why single-use, TTL and nonce-echo are all
/// testable offline. Enigma's file offers enforced none of these: its header
/// admits *"the host does not authenticate the dialer, so anyone holding
/// {addr, offer_id} can complete the handshake."* That was safe there because
/// the offer travelled inside an encrypted chat. A QR has no such envelope.
#[derive(Debug)]
pub struct PendingTicket {
    nonce: [u8; 16],
    issued_at_ms: u64,
    /// Set by the first successful admission. A second joiner is refused even
    /// with the right nonce inside the window.
    consumed: Option<String>,
}

impl PendingTicket {
    pub fn new(nonce: [u8; 16], issued_at_ms: u64) -> Self {
        Self { nonce, issued_at_ms, consumed: None }
    }

    /// Decide whether a joiner may have the board.
    ///
    /// Three refusals, each with its own prefix so the UI can say which:
    /// a wrong nonce (a stale or foreign ticket), an expired one, or a ticket
    /// already spent.
    pub fn admit(&mut self, nonce: &[u8; 16], peer: &str, now_ms: u64) -> Result<(), String> {
        if let Some(taken) = &self.consumed {
            // Idempotent for the peer that already holds it: a re-sent Hello
            // after a reconnect must not lock out the legitimate peer.
            return if taken == peer {
                Ok(())
            } else {
                Err("ticket_spent: someone has already joined with this code".into())
            };
        }
        if nonce != &self.nonce {
            return Err("bad_nonce: that code is not for this session".into());
        }
        if now_ms < self.issued_at_ms || now_ms - self.issued_at_ms > TICKET_TTL_MS {
            return Err("ticket_expired: that code has run out — show a new one".into());
        }
        self.consumed = Some(peer.to_string());
        Ok(())
    }

    /// Who holds it, if anyone.
    pub fn holder(&self) -> Option<&str> {
        self.consumed.as_deref()
    }
}

/// A live session. Dropping it closes the endpoint.
pub struct Session {
    endpoint: Endpoint,
    _router: Router,
    sender: iroh_gossip::api::GossipSender,
    events: Option<mpsc::Receiver<Event>>,
    /// Per-author sequence, for the frames that claim reliability.
    seq: Arc<Mutex<u64>>,
}

impl Session {
    /// Build the endpoint both sides use.
    ///
    /// Ephemeral identity, deliberately — enigma's file transfer makes the same
    /// choice for the same reason (`file_xfer.rs:33-35`): *"the offer addr is
    /// relayed fresh per offer, so no reconnect-by-NodeId is ever needed, and
    /// an ephemeral identity avoids linkability across transfers."* A drawing
    /// session is equally short-lived, and a stable id would let two sessions
    /// be tied to one machine.
    async fn endpoint(cfg: Config, lookup: MemoryLookup) -> Result<Endpoint, String> {
        // `presets::N0` keeps iroh's own relay and pkarr/DNS discovery; the
        // ticket is the bootstrap and discovery is the refresh when addresses
        // change. `Minimal` + `Disabled` is direct QUIC only — no third party,
        // and no reachability across two NATs.
        let builder = if cfg.relays {
            Endpoint::builder(iroh::endpoint::presets::N0).relay_mode(RelayMode::Default)
        } else {
            Endpoint::builder(iroh::endpoint::presets::Minimal).relay_mode(RelayMode::Disabled)
        };
        // The ticket path: `join` puts the host's address here, and iroh
        // resolves the dial from it without any discovery service.
        builder
            .address_lookup(lookup)
            .bind()
            .await
            .map_err(|e| format!("bind_failed: {e}"))
    }

    /// Start a session and mint the ticket that joins it.
    pub async fn host(cfg: Config) -> Result<(Self, TicketV1), String> {
        let endpoint = Self::endpoint(cfg, MemoryLookup::new()).await?;
        // A fresh random topic per session: two sessions from one machine must
        // not collide, and a topic derived from anything guessable would let a
        // stranger subscribe without a ticket.
        let mut topic_bytes = [0u8; 32];
        let mut nonce = [0u8; 16];
        fill_random(&mut topic_bytes);
        fill_random(&mut nonce);

        let addr = endpoint.addr();
        let addr_bytes = postcard::to_stdvec(&addr).map_err(|e| format!("bad_addr: {e}"))?;
        let ticket = TicketV1 {
            topic: topic_bytes,
            addr_bytes,
            nonce,
            issued_at_ms: now_ms(),
        };
        let session = Self::start(endpoint, cfg, TopicId::from_bytes(topic_bytes), vec![]).await?;
        Ok((session, ticket))
    }

    /// Join the session a ticket describes.
    pub async fn join(cfg: Config, ticket: &TicketV1) -> Result<Self, String> {
        // Advice, not enforcement: the host checks again on admission, because
        // a bearer can edit its own copy of this field.
        if !ticket.is_fresh(now_ms()) {
            return Err("ticket_expired: that code has run out — ask for a new one".into());
        }
        let addr: EndpointAddr =
            postcard::from_bytes(&ticket.addr_bytes).map_err(|_| "bad_ticket: damaged".to_string())?;
        let bootstrap = vec![addr.id];
        // Hand the host's address to the endpoint BEFORE binding, so the dial
        // resolves from the ticket rather than needing discovery.
        let lookup = MemoryLookup::new();
        lookup.add_endpoint_info(addr);
        let endpoint = Self::endpoint(cfg, lookup).await?;
        Self::start(endpoint, cfg, TopicId::from_bytes(ticket.topic), bootstrap).await
    }

    async fn start(
        endpoint: Endpoint,
        cfg: Config,
        topic: TopicId,
        bootstrap: Vec<iroh::EndpointId>,
    ) -> Result<Self, String> {
        let gossip = Gossip::builder()
            .max_message_size(cfg.max_message_size)
            .spawn(endpoint.clone());
        let router = Router::builder(endpoint.clone())
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();

        let (sender, mut receiver) = gossip
            .subscribe(topic, bootstrap)
            .await
            .map_err(|e| format!("subscribe_failed: {e}"))?
            .split();

        let (tx, rx) = mpsc::channel(256);
        tokio::spawn(async move {
            use futures_lite::StreamExt;
            let mut tracker = SeqTracker::new();
            while let Some(item) = receiver.next().await {
                let event = match item {
                    Ok(GossipEvent::Received(msg)) => {
                        // `delivered_from` is KEPT. Enigma discards it; a
                        // drawing needs to know who drew what.
                        let from = msg.delivered_from.to_string();
                        match frame::decode(&msg.content) {
                            Ok(f) => {
                                if let Some(seq) = f.seq() {
                                    if tracker.observe(seq) {
                                        let _ = tx.send(Event::Lagged).await;
                                    }
                                }
                                Event::Frame { from, frame: f }
                            }
                            // A frame we cannot parse is a version skew or a
                            // corrupt message; dropping it silently would hide
                            // a real incompatibility.
                            Err(_) => continue,
                        }
                    }
                    Ok(GossipEvent::NeighborUp(id)) => Event::PeerUp { peer: id.to_string() },
                    Ok(GossipEvent::NeighborDown(id)) => Event::PeerDown { peer: id.to_string() },
                    // NOT an empty arm. Messages were dropped; the caller must
                    // resync or the two boards diverge in silence.
                    Ok(GossipEvent::Lagged) => Event::Lagged,
                    Err(_) => break,
                };
                if tx.send(event).await.is_err() {
                    break;
                }
            }
            let _ = tx.send(Event::Closed).await;
        });

        Ok(Self {
            endpoint,
            _router: router,
            sender,
            events: Some(rx),
            seq: Arc::new(Mutex::new(0)),
        })
    }

    /// This endpoint's id — half of the short-auth-string.
    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Broadcast a frame. Committed frames get the next sequence number.
    pub async fn send(&self, mut f: Frame) -> Result<(), String> {
        if f.is_committed() {
            let mut guard = self.seq.lock().await;
            *guard += 1;
            match &mut f {
                Frame::Op { seq, .. } | Frame::Snapshot { seq, .. } => *seq = *guard,
                _ => {}
            }
        }
        let bytes = frame::encode(&f)?;
        self.sender
            .broadcast(bytes.into())
            .await
            .map_err(|e| format!("send_failed: {e}"))
    }

    /// The event stream. Taken once — a second caller gets `None`, because two
    /// consumers of one stream would each see half the frames.
    pub fn events(&mut self) -> Option<mpsc::Receiver<Event>> {
        self.events.take()
    }

    /// Say goodbye, so the peer clears its cursor at once rather than waiting
    /// out iroh's ~15s idle timeout.
    pub async fn close(self) {
        let _ = self.send(Frame::Bye).await;
        self.endpoint.close().await;
    }
}

/// Random bytes without pulling in `rand`: iroh already depends on a CSPRNG
/// through its TLS stack, and `getrandom` is what that resolves to.
fn fill_random(buf: &mut [u8]) {
    // `SecretKey::generate` is iroh's own path to the OS RNG; hashing its
    // bytes gives us as many as we need without a new dependency.
    let key = iroh::SecretKey::generate();
    let seed = blake3::hash(&key.to_bytes());
    let mut out = blake3::Hasher::new_keyed(seed.as_bytes()).finalize_xof();
    out.fill(buf);
}

pub const HELLO_TIMEOUT: Duration = HELLO_WAIT;

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: [u8; 16] = [4u8; 16];
    const T0: u64 = 1_000_000;

    #[test]
    fn the_first_joiner_is_admitted() {
        let mut p = PendingTicket::new(NONCE, T0);
        assert!(p.admit(&NONCE, "peer-a", T0 + 1000).is_ok());
        assert_eq!(p.holder(), Some("peer-a"));
    }

    #[test]
    fn a_ticket_is_single_use() {
        // The bound enigma's file offers lacked: possession of a valid code is
        // not enough once someone has already joined with it.
        let mut p = PendingTicket::new(NONCE, T0);
        p.admit(&NONCE, "peer-a", T0).unwrap();
        let err = p.admit(&NONCE, "peer-b", T0).unwrap_err();
        assert!(err.starts_with("ticket_spent"), "{err}");
        assert_eq!(p.holder(), Some("peer-a"), "the first holder keeps it");
    }

    #[test]
    fn the_holder_may_say_hello_twice() {
        // A reconnect re-sends Hello. If that were refused, a dropped
        // connection would lock the legitimate peer out of its own session.
        let mut p = PendingTicket::new(NONCE, T0);
        p.admit(&NONCE, "peer-a", T0).unwrap();
        assert!(p.admit(&NONCE, "peer-a", T0 + 5000).is_ok());
    }

    #[test]
    fn a_wrong_nonce_is_refused() {
        // What stops a QR photographed from an OLDER session of the same host.
        let mut p = PendingTicket::new(NONCE, T0);
        let err = p.admit(&[9u8; 16], "peer-b", T0).unwrap_err();
        assert!(err.starts_with("bad_nonce"), "{err}");
        assert_eq!(p.holder(), None, "a refusal must not consume the ticket");
    }

    #[test]
    fn an_expired_ticket_is_refused_by_the_host() {
        // The holder's own check is advice; this is the assertion. A bearer
        // can edit `issued_at_ms` in its copy — it cannot edit the host's.
        let mut p = PendingTicket::new(NONCE, T0);
        let err = p.admit(&NONCE, "peer-b", T0 + TICKET_TTL_MS + 1).unwrap_err();
        assert!(err.starts_with("ticket_expired"), "{err}");
        assert!(p.admit(&NONCE, "peer-b", T0 + TICKET_TTL_MS).is_ok(), "and fresh at the edge");
    }

    #[test]
    fn a_ticket_from_the_future_is_refused() {
        let mut p = PendingTicket::new(NONCE, T0);
        assert!(p.admit(&NONCE, "peer-b", T0 - 1).is_err());
    }

    #[test]
    fn refusals_do_not_burn_the_ticket() {
        // A stranger guessing nonces must not be able to deny the real peer
        // its session by consuming the single use.
        let mut p = PendingTicket::new(NONCE, T0);
        for _ in 0..5 {
            let _ = p.admit(&[0u8; 16], "attacker", T0);
        }
        assert!(p.admit(&NONCE, "peer-a", T0).is_ok());
    }
}
