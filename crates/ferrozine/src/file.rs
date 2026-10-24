//! One-to-one file transfer, every chunk sealed by a pairwise MLS channel.
//!
//! The host registers a file as an *offer* and tells the intended downloader,
//! over a channel that is already authenticated (in Enigma, the room's MLS
//! group), the offer id and the host's address. The downloader [`prepare`]s a
//! KeyPackage and sends back its [`commitment`](crate::pair::commitment) the
//! same way; the host [`authorize`](FileHost::authorize)s it. Then:
//!
//! ```text
//! downloader                                       host
//!   connect(ALPN) ── Request { offer_id, KeyPackage, want_integrity } ──▶
//!                                       KeyPackage must match the commitment
//!   ◀── Header { name, size, mime, Welcome, chunk_size, chunk_count, integrity }
//!   ◀══ seal([0, seq, chunk]) … seal([1, count, chain root]) ══
//!   ── ack (1 byte) ──▶
//! ```
//!
//! - **Confidentiality** — chunks are MLS ciphertext, not merely QUIC-encrypted:
//!   a relay or a compromised transport sees nothing.
//! - **Authentication** — only the holder of the committed KeyPackage's private
//!   key can join the pairwise group, so knowing `{addr, offer_id}` is not enough.
//! - **Integrity** — the chunk kind and sequence number are inside the MLS
//!   plaintext, so a chunk cannot be reordered or replayed. A truncated stream is
//!   always caught (byte and chunk counts are checked against the header). With
//!   the integrity option (either side may insist), a BLAKE3 chain over every
//!   chunk is sent in a final trailer and checked before the file is kept.
//! - **Bounded memory** — both sides stream chunk by chunk; frame sizes are
//!   bounded before allocation.
//!
//! The wire format is Enigma's `enigma/file/1`, unchanged, so Enigma can move
//! onto this module without breaking transfers with older builds. Another app
//! (Pumex) uses the same protocol under its own ALPN.
//!
//! The protocol itself ([`FileHost::serve`], [`receive`]) runs over any tokio
//! byte stream; [`FileHost`] implements iroh's `ProtocolHandler` and
//! [`download`] dials, for the real network.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{Error, Result};
use crate::frame::{read_blob, read_control, write_blob, write_control};
use crate::pair::{self, b64, unb64, Caller, Channel};

/// The ALPN Enigma's transfers use. A new app picks its own (a peer that
/// cannot negotiate it fails to connect instead of misreading the stream).
pub const ENIGMA_ALPN: &[u8] = b"enigma/file/1";

const KIND_CHUNK: u8 = 0;
const KIND_TRAILER: u8 = 1;
/// MLS framing overhead allowed on top of a chunk (openmls's is well under 1 KiB).
const MLS_OVERHEAD: usize = 8 * 1024;

/// Which way bytes are moving, from this side's point of view.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// This side is the host.
    Send,
    /// This side is the downloader.
    Recv,
}

/// What a transfer reports while it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransferEvent {
    /// Progress, at most once per whole percent.
    Progress {
        /// The offer.
        offer_id: String,
        /// This side's role.
        direction: Direction,
        /// Bytes so far.
        transferred: u64,
        /// Bytes in the file.
        total: u64,
    },
    /// Finished and (on the receiving side) verified.
    Done {
        /// The offer.
        offer_id: String,
        /// This side's role.
        direction: Direction,
    },
    /// A downloader was turned away before it was admitted to the offer — an
    /// unknown offer, no authorization, the wrong KeyPackage or ticket secret.
    /// Not the offer's transfer failing: the offer is still open for the
    /// downloader it is meant for. Host side only.
    Refused {
        /// The offer the request named.
        offer_id: String,
        /// Why.
        message: String,
    },
    /// The admitted transfer failed; the receiving side has removed its
    /// partial file.
    Failed {
        /// The offer.
        offer_id: String,
        /// This side's role.
        direction: Direction,
        /// Why.
        message: String,
    },
}

/// Where transfer events go. Called from the transfer's task; keep it quick.
pub type Observer = Arc<dyn Fn(TransferEvent) + Send + Sync>;

/// An observer that drops every event.
pub fn ignore_events() -> Observer {
    Arc::new(|_| {})
}

/// Chunk size bounds. Both sides must agree on `max`: the receiver refuses a
/// header announcing larger chunks, and sizes its frame cap from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// The smallest chunk a host will use.
    pub min_chunk: usize,
    /// The largest chunk either side accepts.
    pub max_chunk: usize,
}

impl Limits {
    /// Enigma's bounds: 16 KiB to 4 MiB.
    pub const ENIGMA: Self = Self {
        min_chunk: 16 * 1024,
        max_chunk: 4096 * 1024,
    };

    fn max_frame(&self) -> usize {
        self.max_chunk + MLS_OVERHEAD
    }

    fn clamp(&self, chunk: usize) -> usize {
        // Robust to limits a caller built by hand: never 0 (a zero chunk would
        // divide by zero), never min > max (`clamp` would panic).
        let max = self.max_chunk.max(1);
        let min = self.min_chunk.clamp(1, max);
        chunk.clamp(min, max)
    }
}

/// The host's choices for one transfer, read when the downloader connects
/// (so a settings change applies to the next transfer, never mid-file).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostSettings {
    /// Chunk size in bytes; clamped to the [`Limits`].
    pub chunk_size: usize,
    /// Whether this side insists on the hash chain.
    pub integrity: bool,
}

/// A file being offered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Offer {
    /// The one-time id the downloader names.
    pub offer_id: String,
    /// The file's name (no directories).
    pub name: String,
    /// Its size in bytes.
    pub size: u64,
    /// Its MIME type, guessed from the extension.
    pub mime: String,
}

#[derive(Serialize, Deserialize)]
struct Request {
    offer_id: String,
    key_package: String,
    want_integrity: bool,
    /// Proof of the offer's one-time secret, for offers authorized by a
    /// [`Ticket`]. Absent (and not serialized) otherwise, so a request is
    /// byte-identical to what peers that predate tickets send and expect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claim: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Header {
    name: String,
    size: u64,
    mime: String,
    welcome: String,
    chunk_size: u32,
    chunk_count: u64,
    integrity: bool,
}

// ── shared pieces ────────────────────────────────────────────────────────────

static ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// Counts a transfer for as long as it lives, however it ends.
struct Active;

impl Active {
    fn new() -> Self {
        ACTIVE.fetch_add(1, Ordering::Relaxed);
        Self
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Whether any transfer in this process is moving bytes (either direction) —
/// for an app that must not, say, lock itself mid-transfer.
pub fn transfers_active() -> bool {
    ACTIVE.load(Ordering::Relaxed) > 0
}

/// The chain seed, bound to the offer so a chunk cannot be replayed into
/// another transfer. The domain string is part of the v1 wire format.
fn chain_seed(offer_id: &str) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"enigma/file/chain/v1");
    h.update(offer_id.as_bytes());
    *h.finalize().as_bytes()
}

/// `h_i = BLAKE3(h_{i-1} ‖ seq_be ‖ chunk)`.
fn chain_step(prev: &[u8; 32], seq: u64, chunk: &[u8]) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(prev);
    h.update(&seq.to_be_bytes());
    h.update(chunk);
    *h.finalize().as_bytes()
}

/// Fires once per whole percent.
struct Ticker(i64);

impl Ticker {
    fn new() -> Self {
        Self(-1)
    }

    fn tick(&mut self, done: u64, total: u64) -> bool {
        let pct = done
            .saturating_mul(100)
            .checked_div(total)
            .map_or(100, |p| p as i64);
        let fire = pct != self.0;
        self.0 = pct;
        fire
    }
}

/// Fill `buf` unless EOF, so every chunk but the last is full (the receiver's
/// chain and counts depend on it).
async fn read_full<R: AsyncRead + Unpin>(r: &mut R, buf: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = r.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// The MIME type for a file name, from its extension.
pub fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
    .to_owned()
}

// ── host ─────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct OfferedFile {
    path: PathBuf,
    offer: Offer,
}

/// Who may fetch an offer.
#[derive(Clone)]
enum Authorization {
    /// The downloader whose KeyPackage hashes to this commitment.
    Commitment(String),
    /// Whoever proves a ticket's secret. One downloader at a time is
    /// admitted (`in_use`); if its transfer fails the offer is claimable
    /// again, so a retry works; once one succeeds the offer is withdrawn.
    Ticket {
        secret: [u8; 32],
        /// Unix seconds after which nobody is admitted. Wall-clock time, so a
        /// machine that slept past it does not serve a link the UI already
        /// shows as closed.
        deadline: Option<u64>,
        /// Whether a transfer under this ticket is running.
        in_use: bool,
    },
}

/// How a downloader was admitted, which decides what its outcome does.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Admitted {
    No,
    ByCommitment,
    ByTicket,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Connections served at once for one remote endpoint. Anyone who has a
/// ticket's address can dial it; this keeps one peer from holding every
/// serving slot.
pub const MAX_SERVES_PER_PEER: usize = 2;

struct HostInner {
    offers: Mutex<HashMap<String, OfferedFile>>,
    authorized: Mutex<HashMap<String, Authorization>>,
    settings: Box<dyn Fn() -> HostSettings + Send + Sync>,
    observer: Observer,
    limits: Limits,
    /// Milliseconds; see [`FileHost::set_authorize_wait`].
    authorize_wait_ms: AtomicU64,
    /// One permit per connection being served.
    serving: Arc<tokio::sync::Semaphore>,
    /// Connections being served, per remote endpoint (iroh connections only).
    per_peer: Mutex<HashMap<iroh::EndpointId, usize>>,
}

/// How long a connection may take to send its request. A peer that opens a
/// stream and sends nothing must not hold a serving slot (or keep
/// [`transfers_active`] true) for ever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Connections served at once; more are refused until one finishes.
pub const MAX_CONCURRENT_SERVES: usize = 16;

/// The serving side: a set of offers, who may fetch each, and the protocol
/// handler that serves them. Clone it freely; clones share their offers.
#[derive(Clone)]
pub struct FileHost(Arc<HostInner>);

impl std::fmt::Debug for FileHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FileHost")
    }
}

impl FileHost {
    /// A host whose per-transfer choices come from `settings` (called once per
    /// transfer) and whose events go to `observer`.
    pub fn new(
        limits: Limits,
        settings: impl Fn() -> HostSettings + Send + Sync + 'static,
        observer: Observer,
    ) -> Self {
        Self(Arc::new(HostInner {
            offers: Mutex::default(),
            authorized: Mutex::default(),
            settings: Box::new(settings),
            observer,
            limits,
            authorize_wait_ms: AtomicU64::new(20_000),
            serving: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_SERVES)),
            per_peer: Mutex::default(),
        }))
    }

    /// How long a connection waits for its authorization to arrive. The
    /// downloader sends its commitment and dials at once, so the dial can win
    /// the race; the wait absorbs that. Default 20 s. Applies to every clone.
    pub fn set_authorize_wait(&self, wait: Duration) {
        let ms = u64::try_from(wait.as_millis()).unwrap_or(u64::MAX);
        self.0.authorize_wait_ms.store(ms, Ordering::Relaxed);
    }

    /// Offer the file at `path`.
    pub fn offer(&self, path: impl Into<PathBuf>) -> Result<Offer> {
        let path = path.into();
        let size = std::fs::metadata(&path)?.len();
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        let offer = Offer {
            offer_id: uuid::Uuid::new_v4().to_string(),
            mime: mime_for(&name),
            name,
            size,
        };
        self.0.offers.lock().expect("offers lock").insert(
            offer.offer_id.clone(),
            OfferedFile {
                path,
                offer: offer.clone(),
            },
        );
        Ok(offer)
    }

    /// Withdraw an offer and its authorization. A transfer already running
    /// finishes; a new one is refused.
    pub fn cancel(&self, offer_id: &str) {
        self.0.offers.lock().expect("offers lock").remove(offer_id);
        self.0
            .authorized
            .lock()
            .expect("authorized lock")
            .remove(offer_id);
    }

    /// Let the downloader whose KeyPackage hashes to `commitment` fetch `offer_id`.
    pub fn authorize(&self, offer_id: &str, commitment: &str) {
        self.0.authorized.lock().expect("authorized lock").insert(
            offer_id.to_owned(),
            Authorization::Commitment(commitment.to_owned()),
        );
    }

    /// Let whoever holds `secret` fetch `offer_id`, once. This is how a
    /// [`Ticket`] — a link or QR code — stands in for an authenticated
    /// channel:
    ///
    /// - one downloader at a time is admitted, and only by proving the secret;
    /// - if its transfer fails, the offer is claimable again (a retry works);
    /// - once a transfer succeeds, the offer and its authorization are
    ///   withdrawn: the ticket never works again.
    pub fn authorize_with_secret(&self, offer_id: &str, secret: &[u8; 32]) {
        self.authorize_ticket(offer_id, secret, None);
    }

    /// [`authorize_with_secret`](Self::authorize_with_secret), refusing
    /// everyone after `deadline` (Unix seconds, wall clock).
    pub fn authorize_with_secret_until(&self, offer_id: &str, secret: &[u8; 32], deadline: u64) {
        self.authorize_ticket(offer_id, secret, Some(deadline));
    }

    fn authorize_ticket(&self, offer_id: &str, secret: &[u8; 32], deadline: Option<u64>) {
        self.0.authorized.lock().expect("authorized lock").insert(
            offer_id.to_owned(),
            Authorization::Ticket {
                secret: *secret,
                deadline,
                in_use: false,
            },
        );
    }

    /// What a ticket offer's outcome does: success withdraws it (one-time),
    /// failure makes it claimable again.
    fn ticket_finished(&self, offer_id: &str, success: bool) {
        if success {
            self.cancel(offer_id);
        } else if let Some(Authorization::Ticket { in_use, .. }) = self
            .0
            .authorized
            .lock()
            .expect("authorized lock")
            .get_mut(offer_id)
        {
            *in_use = false;
        }
    }

    /// Check `commitment` (and, for a secret, `claim`) against the offer's
    /// authorization. A valid secret claim rebinds the offer to `commitment`
    /// in the same critical section, so two holders of one ticket cannot
    /// both pass.
    fn admit(&self, offer_id: &str, commitment: &str, claim: Option<&str>) -> Result<Admitted> {
        let mut map = self.0.authorized.lock().expect("authorized lock");
        match map.get_mut(offer_id) {
            Some(Authorization::Commitment(c)) if c == commitment => Ok(Admitted::ByCommitment),
            Some(Authorization::Commitment(_)) => Err(Error::Unauthorized(
                "KeyPackage does not match the authorized peer".into(),
            )),
            Some(Authorization::Ticket {
                secret,
                deadline,
                in_use,
            }) => {
                if deadline.is_some_and(|d| unix_now() >= d) {
                    return Err(Error::Unauthorized("this link has expired".into()));
                }
                if *in_use {
                    return Err(Error::Unauthorized(
                        "this link is being used right now".into(),
                    ));
                }
                let claim = claim.ok_or_else(|| {
                    Error::Unauthorized("this offer needs its link's secret".into())
                })?;
                if !claim_matches(secret, offer_id, commitment, claim) {
                    return Err(Error::Unauthorized(
                        "the link's secret does not match".into(),
                    ));
                }
                *in_use = true;
                Ok(Admitted::ByTicket)
            }
            None => Err(Error::Unauthorized(format!(
                "no peer was authorized for offer {offer_id}"
            ))),
        }
    }

    async fn wait_for_authorization(&self, offer_id: &str) -> Option<Authorization> {
        let wait = Duration::from_millis(self.0.authorize_wait_ms.load(Ordering::Relaxed));
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Some(c) = self
                .0
                .authorized
                .lock()
                .expect("authorized lock")
                .get(offer_id)
                .cloned()
            {
                return Some(c);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Serve one downloader on an accepted bi-stream. Reports `Done` or
    /// `Failed` to the observer once the offer is known.
    pub async fn serve<R, W>(&self, mut recv: R, mut send: W) -> Result<()>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let _permit = self
            .0
            .serving
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Connection("too many transfers at once".into()))?;
        let req: Request = tokio::time::timeout(REQUEST_TIMEOUT, read_control(&mut recv))
            .await
            .map_err(|_| Error::Protocol("no request within the timeout".into()))??;
        let offer_id = req.offer_id.clone();
        let mut admitted = Admitted::No;
        let result = self
            .serve_request(req, &mut recv, &mut send, &mut admitted)
            .await;
        if admitted == Admitted::ByTicket {
            self.ticket_finished(&offer_id, result.is_ok());
        }
        let event = match &result {
            Ok(()) => TransferEvent::Done {
                offer_id,
                direction: Direction::Send,
            },
            Err(e) if admitted == Admitted::No => TransferEvent::Refused {
                offer_id,
                message: e.to_string(),
            },
            Err(e) => TransferEvent::Failed {
                offer_id,
                direction: Direction::Send,
                message: e.to_string(),
            },
        };
        (self.0.observer)(event);
        result
    }

    async fn serve_request<R, W>(
        &self,
        req: Request,
        recv: &mut R,
        send: &mut W,
        admitted: &mut Admitted,
    ) -> Result<()>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let offered = self
            .0
            .offers
            .lock()
            .expect("offers lock")
            .get(&req.offer_id)
            .cloned();
        let offered = offered
            .ok_or_else(|| Error::Unauthorized(format!("unknown offer {}", req.offer_id)))?;

        // Authenticate before any metadata leaves.
        self.wait_for_authorization(&req.offer_id)
            .await
            .ok_or_else(|| {
                Error::Unauthorized(format!("no peer was authorized for offer {}", req.offer_id))
            })?;
        let key_package = unb64(&req.key_package)?;
        *admitted = self.admit(
            &req.offer_id,
            &pair::commitment(&key_package),
            req.claim.as_deref(),
        )?;
        // Counted from here: an authorized peer is a transfer, a stranger
        // probing the port is not.
        let _active = Active::new();
        let (mut channel, welcome) = pair::accept(&req.offer_id, "host", &key_package)?;

        let settings = (self.0.settings)();
        let chunk_size = self.0.limits.clamp(settings.chunk_size);
        let integrity = settings.integrity || req.want_integrity;
        let offer = &offered.offer;
        let chunk_count = offer.size.div_ceil(chunk_size as u64);
        write_control(
            send,
            &Header {
                name: offer.name.clone(),
                size: offer.size,
                mime: offer.mime.clone(),
                welcome: b64(&welcome),
                chunk_size: chunk_size as u32,
                chunk_count,
                integrity,
            },
        )
        .await?;

        let mut file = tokio::fs::File::open(&offered.path).await?;
        let mut buf = vec![0u8; chunk_size];
        let (mut sent, mut seq, mut chain, mut ticks) =
            (0u64, 0u64, chain_seed(&req.offer_id), Ticker::new());
        loop {
            let n = read_full(&mut file, &mut buf).await?;
            if n == 0 {
                break;
            }
            if integrity {
                chain = chain_step(&chain, seq, &buf[..n]);
            }
            let mut plain = Vec::with_capacity(n + 9);
            plain.push(KIND_CHUNK);
            plain.extend_from_slice(&seq.to_be_bytes());
            plain.extend_from_slice(&buf[..n]);
            write_blob(send, &channel.seal(&plain)?).await?;
            sent += n as u64;
            seq += 1;
            if ticks.tick(sent, offer.size) {
                self.progress(&req.offer_id, Direction::Send, sent, offer.size);
            }
        }
        if sent != offer.size {
            // The file changed size after it was offered; the receiver would
            // refuse it anyway, so say why here.
            return Err(Error::Integrity(format!(
                "file is now {sent} bytes, offered as {}",
                offer.size
            )));
        }
        self.progress(&req.offer_id, Direction::Send, sent, offer.size);
        if integrity {
            let mut plain = Vec::with_capacity(41);
            plain.push(KIND_TRAILER);
            plain.extend_from_slice(&seq.to_be_bytes());
            plain.extend_from_slice(&chain);
            write_blob(send, &channel.seal(&plain)?).await?;
        }
        // Closing our half can fail if the peer has already gone; every byte
        // is written by then, so that is not a failed transfer.
        let _ = send.shutdown().await;
        // Wait for the downloader's ack, so everything is read before we close.
        let mut ack = [0u8; 1];
        let _ = recv.read_exact(&mut ack).await;
        Ok(())
    }

    fn progress(&self, offer_id: &str, direction: Direction, transferred: u64, total: u64) {
        (self.0.observer)(TransferEvent::Progress {
            offer_id: offer_id.to_owned(),
            direction,
            transferred,
            total,
        });
    }
}

impl ProtocolHandler for FileHost {
    async fn accept(&self, conn: Connection) -> std::result::Result<(), AcceptError> {
        let peer = conn.remote_id();
        {
            let mut per_peer = self.0.per_peer.lock().expect("per-peer lock");
            let n = per_peer.entry(peer).or_insert(0);
            if *n >= MAX_SERVES_PER_PEER {
                return Ok(());
            }
            *n += 1;
        }
        // Errors before the request names an offer have no one to report to;
        // after that, `serve` has reported them.
        if let Ok((send, recv)) = conn.accept_bi().await {
            let _ = self.serve(recv, send).await;
        }
        let mut per_peer = self.0.per_peer.lock().expect("per-peer lock");
        if let Some(n) = per_peer.get_mut(&peer) {
            *n -= 1;
            if *n == 0 {
                per_peer.remove(&peer);
            }
        }
        Ok(())
    }
}

// ── downloader ───────────────────────────────────────────────────────────────

/// A downloader's half of the handshake, made before dialling so its
/// commitment can be sent to the host first.
pub struct Prepared {
    offer_id: String,
    caller: Caller,
    claim: Option<String>,
}

/// Make the KeyPackage for fetching `offer_id`. Send
/// [`commitment`](Prepared::commitment) to the host over an authenticated
/// channel, then [`download`] (or [`receive`]).
pub fn prepare(offer_id: &str) -> Result<Prepared> {
    Ok(Prepared {
        offer_id: offer_id.to_owned(),
        caller: Caller::start(offer_id, "peer")?,
        claim: None,
    })
}

/// Make the KeyPackage for fetching the offer a [`Ticket`] names, with the
/// proof of the ticket's secret bound to it. Nothing needs sending first:
/// [`download`] straight away.
pub fn prepare_for_ticket(ticket: &Ticket) -> Result<Prepared> {
    let mut prepared = prepare(&ticket.offer_id)?;
    prepared.claim = Some(claim_for(
        &ticket.secret,
        &ticket.offer_id,
        &prepared.commitment(),
    ));
    Ok(prepared)
}

impl Prepared {
    /// What the host must [`authorize`](FileHost::authorize).
    pub fn commitment(&self) -> String {
        self.caller.commitment()
    }

    /// The offer this is for.
    pub fn offer_id(&self) -> &str {
        &self.offer_id
    }
}

/// Fetch an offer over a bi-stream into `dest`. On any failure the partial
/// file is removed; `Done`/`Failed` are reported to `observer`.
pub async fn receive<R, W>(
    prepared: Prepared,
    mut recv: R,
    mut send: W,
    dest: &Path,
    want_integrity: bool,
    limits: Limits,
    observer: Observer,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let _active = Active::new();
    let offer_id = prepared.offer_id.clone();
    let mut created = false;
    let result = receive_inner(
        prepared,
        &mut recv,
        &mut send,
        dest,
        want_integrity,
        limits,
        &observer,
        &mut created,
    )
    .await;
    match &result {
        Ok(()) => observer(TransferEvent::Done {
            offer_id,
            direction: Direction::Recv,
        }),
        Err(e) => {
            // Only what this transfer wrote: a failure before the file was
            // created must not delete a file the user already had there.
            if created {
                let _ = tokio::fs::remove_file(dest).await;
            }
            observer(TransferEvent::Failed {
                offer_id,
                direction: Direction::Recv,
                message: e.to_string(),
            });
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn receive_inner<R, W>(
    prepared: Prepared,
    recv: &mut R,
    send: &mut W,
    dest: &Path,
    want_integrity: bool,
    limits: Limits,
    observer: &Observer,
    created: &mut bool,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let offer_id = prepared.offer_id.clone();
    let request = Request {
        offer_id: offer_id.clone(),
        key_package: b64(prepared.caller.key_package()),
        want_integrity,
        claim: prepared.claim.clone(),
    };
    write_control(send, &request).await?;
    let header: Header = read_control(recv).await?;
    if want_integrity && !header.integrity {
        return Err(Error::Integrity(
            "the sender did not provide an integrity manifest (verification is on for this device)"
                .into(),
        ));
    }
    if header.chunk_size as usize > limits.max_chunk || header.chunk_size == 0 {
        return Err(Error::Protocol(format!(
            "chunk size {} is outside this side's limits",
            header.chunk_size
        )));
    }
    let mut channel: Channel = prepared.caller.join(&unb64(&header.welcome)?)?;

    let mut file = tokio::fs::File::create(dest).await?;
    *created = true;
    let (mut got, mut seq, mut chain, mut ticks) =
        (0u64, 0u64, chain_seed(&offer_id), Ticker::new());
    let mut trailer: Option<(u64, [u8; 32])> = None;
    let progress = |done| {
        observer(TransferEvent::Progress {
            offer_id: offer_id.clone(),
            direction: Direction::Recv,
            transferred: done,
            total: header.size,
        })
    };
    while let Some(sealed) = read_blob(recv, limits.max_frame()).await? {
        let plain = channel.open(&sealed)?;
        match plain.first().copied() {
            Some(KIND_CHUNK) if plain.len() >= 9 => {
                let n = u64::from_be_bytes(plain[1..9].try_into().expect("8 bytes"));
                if n != seq {
                    return Err(Error::Protocol(format!(
                        "chunk out of order: expected {seq}, got {n}"
                    )));
                }
                let body = &plain[9..];
                got += body.len() as u64;
                if got > header.size {
                    return Err(Error::Integrity(format!(
                        "more bytes than the {} announced",
                        header.size
                    )));
                }
                if header.integrity {
                    chain = chain_step(&chain, seq, body);
                }
                file.write_all(body).await?;
                seq += 1;
                if ticks.tick(got, header.size) {
                    progress(got);
                }
            }
            Some(KIND_TRAILER) if plain.len() >= 41 => {
                let count = u64::from_be_bytes(plain[1..9].try_into().expect("8 bytes"));
                trailer = Some((count, plain[9..41].try_into().expect("32 bytes")));
                break;
            }
            Some(KIND_CHUNK | KIND_TRAILER) => return Err(Error::Protocol("short frame".into())),
            _ => return Err(Error::Protocol("unknown frame kind".into())),
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    progress(got);

    if got != header.size {
        return Err(Error::Integrity(format!(
            "incomplete transfer: got {got} of {} bytes",
            header.size
        )));
    }
    if seq != header.chunk_count {
        return Err(Error::Integrity(format!(
            "missing chunks: got {seq} of {} announced",
            header.chunk_count
        )));
    }
    if header.integrity {
        let (count, root) = trailer.ok_or_else(|| {
            Error::Integrity("integrity manifest missing — transfer was cut short".into())
        })?;
        if count != seq {
            return Err(Error::Integrity(format!(
                "manifest counts {count} chunks, received {seq}"
            )));
        }
        if root != chain {
            return Err(Error::Integrity(
                "integrity check failed — the file was altered in transit".into(),
            ));
        }
    }
    // The file is complete and verified: an ack that cannot be delivered (the
    // host already hung up) must not turn that into a failure.
    let _ = send.write_all(&[1u8]).await;
    let _ = send.shutdown().await;
    Ok(())
}

/// Dial `addr` on `alpn` and [`receive`] the offer into `dest`.
#[allow(clippy::too_many_arguments)]
pub async fn download(
    endpoint: &Endpoint,
    addr: EndpointAddr,
    alpn: &[u8],
    prepared: Prepared,
    dest: &Path,
    want_integrity: bool,
    limits: Limits,
    observer: Observer,
) -> Result<()> {
    // Counted from before the dial: a slow connect is a transfer in progress.
    let _active = Active::new();
    let offer_id = prepared.offer_id.clone();
    let fail = |e: Error| {
        observer(TransferEvent::Failed {
            offer_id: offer_id.clone(),
            direction: Direction::Recv,
            message: e.to_string(),
        });
        e
    };
    let conn = endpoint
        .connect(addr, alpn)
        .await
        .map_err(|e| fail(Error::conn(e)))?;
    let (send, recv) = conn.open_bi().await.map_err(|e| fail(Error::conn(e)))?;
    let result = receive(
        prepared,
        recv,
        send,
        dest,
        want_integrity,
        limits,
        observer.clone(),
    )
    .await;
    conn.close(0u32.into(), b"done");
    result
}

// ── tickets ──────────────────────────────────────────────────────────────────

const CLAIM_DOMAIN: &[u8] = b"ferrozine/file/claim/v1";

/// `BLAKE3-keyed(secret, domain ‖ 0 ‖ offer_id ‖ 0 ‖ commitment)`, as hex.
/// Binds the downloader's KeyPackage to the ticket: the secret alone, seen
/// in a later request, cannot be replayed for another KeyPackage.
fn claim_for(secret: &[u8; 32], offer_id: &str, commitment: &str) -> String {
    claim_hash(secret, offer_id, commitment)
        .to_hex()
        .to_string()
}

fn claim_hash(secret: &[u8; 32], offer_id: &str, commitment: &str) -> blake3::Hash {
    let mut h = blake3::Hasher::new_keyed(secret);
    h.update(CLAIM_DOMAIN);
    h.update(&[0]);
    h.update(offer_id.as_bytes());
    h.update(&[0]);
    h.update(commitment.as_bytes());
    h.finalize()
}

/// Constant-time: `blake3::Hash` equality does not short-circuit.
fn claim_matches(secret: &[u8; 32], offer_id: &str, commitment: &str, claim: &str) -> bool {
    blake3::Hash::from_hex(claim).is_ok_and(|c| c == claim_hash(secret, offer_id, commitment))
}

/// The ticket format version this crate writes and reads.
pub const TICKET_VERSION: u8 = 1;
/// The longest ticket text accepted (an address with relays is well under 1 KiB).
pub const MAX_TICKET_CHARS: usize = 4096;

/// Everything a downloader needs to fetch one offer: where the host is, which
/// offer, and the one-time secret that authorizes it. As text (a link, a QR
/// code) it *is* the authorization — whoever holds it first gets the file —
/// so it must reach only the intended person, and it works once.
///
/// `name` and `size` are the host's description, for showing before the
/// download; what arrives is checked against the host's header, not these.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    /// [`TICKET_VERSION`].
    pub version: u8,
    /// The host's dialable address.
    pub addr: EndpointAddr,
    /// The offer.
    pub offer_id: String,
    /// The one-time secret.
    pub secret: [u8; 32],
    /// The file's name, as the host describes it.
    pub name: String,
    /// Its size in bytes, as the host describes it.
    pub size: u64,
}

impl std::fmt::Debug for Ticket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the secret: a ticket in a log is a stolen file.
        f.debug_struct("Ticket")
            .field("offer_id", &self.offer_id)
            .field("name", &self.name)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

impl Ticket {
    /// A ticket for `offer` at `addr`, with a fresh secret. Authorize it on the
    /// host with [`FileHost::authorize_with_secret`]`(&offer.offer_id, &ticket.secret)`.
    pub fn new(addr: EndpointAddr, offer: &Offer) -> Result<Self> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|e| Error::Protocol(format!("no randomness: {e}")))?;
        Ok(Self {
            version: TICKET_VERSION,
            addr,
            offer_id: offer.offer_id.clone(),
            secret,
            name: offer.name.clone(),
            size: offer.size,
        })
    }

    /// Lowercase unpadded base32 of the postcard encoding.
    pub fn encode(&self) -> String {
        let bytes = postcard::to_stdvec(self).expect("postcard into a Vec is infallible");
        let mut text = data_encoding::BASE32_NOPAD.encode(&bytes);
        text.make_ascii_lowercase();
        text
    }

    /// Decode [`encode`](Self::encode)'s output, in either case, surrounding
    /// whitespace ignored.
    pub fn decode(text: &str) -> Result<Self> {
        let text = text.trim();
        if text.len() > MAX_TICKET_CHARS {
            return Err(Error::Decode("ticket too long".into()));
        }
        let bytes = data_encoding::BASE32_NOPAD
            .decode(text.to_ascii_uppercase().as_bytes())
            .map_err(|e| Error::Decode(format!("ticket: {e}")))?;
        let ticket: Self =
            postcard::from_bytes(&bytes).map_err(|e| Error::Decode(format!("ticket: {e}")))?;
        if ticket.version != TICKET_VERSION {
            return Err(Error::Decode(format!(
                "unsupported ticket version {}",
                ticket.version
            )));
        }
        Ok(ticket)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_round_trips_and_its_debug_hides_the_secret() {
        let id = iroh::SecretKey::from_bytes(&[3; 32]).public();
        let offer = Offer {
            offer_id: "o-1".into(),
            name: "a.pdf".into(),
            size: 9,
            mime: "application/pdf".into(),
        };
        let t = Ticket::new(EndpointAddr::new(id), &offer).unwrap();
        assert_ne!(t.secret, [0; 32]);
        assert_eq!(Ticket::decode(&t.encode()).unwrap(), t);
        assert_eq!(
            Ticket::decode(&format!(" {}\n", t.encode().to_ascii_uppercase())).unwrap(),
            t
        );
        let shown = format!("{t:?}");
        assert!(!shown.contains(&format!("{:?}", t.secret)) && !shown.contains("secret"));
        assert!(Ticket::decode("junk!").is_err());
        assert!(Ticket::decode(&"a".repeat(MAX_TICKET_CHARS + 1)).is_err());
    }

    #[test]
    fn a_request_without_a_claim_is_byte_identical_to_the_v1_wire_format() {
        // Enigma peers that predate tickets send exactly these three fields.
        let r = Request {
            offer_id: "o".into(),
            key_package: "kp".into(),
            want_integrity: true,
            claim: None,
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"offer_id":"o","key_package":"kp","want_integrity":true}"#
        );
        let old: Request =
            serde_json::from_str(r#"{"offer_id":"o","key_package":"kp","want_integrity":false}"#)
                .unwrap();
        assert!(old.claim.is_none());
    }

    #[test]
    fn a_claim_is_bound_to_secret_offer_and_keypackage() {
        let (s, other) = ([1u8; 32], [2u8; 32]);
        let c = claim_for(&s, "o", "kp1");
        assert!(claim_matches(&s, "o", "kp1", &c));
        assert!(!claim_matches(&other, "o", "kp1", &c), "another secret");
        assert!(!claim_matches(&s, "o2", "kp1", &c), "another offer");
        assert!(!claim_matches(&s, "o", "kp2", &c), "another KeyPackage");
        assert!(!claim_matches(&s, "o", "kp1", "not hex"));
    }

    #[test]
    fn mime_maps_known_extensions_and_defaults() {
        assert_eq!(mime_for("photo.PNG"), "image/png");
        assert_eq!(mime_for("archive.zip"), "application/zip");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }

    #[test]
    fn the_chain_is_order_content_and_offer_sensitive() {
        let seed = chain_seed("offer-1");
        let ab = chain_step(&chain_step(&seed, 0, b"alpha"), 1, b"beta");
        let ba = chain_step(&chain_step(&seed, 0, b"beta"), 1, b"alpha");
        assert_ne!(ab, ba);
        assert_ne!(ab, chain_step(&chain_step(&seed, 0, b"alpha"), 1, b"betb"));
        assert_ne!(
            chain_step(&chain_seed("offer-1"), 0, b"x"),
            chain_step(&chain_seed("offer-2"), 0, b"x")
        );
    }

    #[test]
    fn the_ticker_fires_once_per_whole_percent() {
        let mut t = Ticker::new();
        assert_eq!((0..=10_000u64).filter(|d| t.tick(*d, 10_000)).count(), 101);
        let mut t = Ticker::new();
        assert!(t.tick(0, 0), "an empty file reports complete");
    }

    #[test]
    fn hand_built_limits_never_make_a_zero_or_inverted_chunk() {
        assert_eq!(
            Limits {
                min_chunk: 0,
                max_chunk: 0
            }
            .clamp(0),
            1
        );
        assert_eq!(
            Limits {
                min_chunk: 9,
                max_chunk: 4
            }
            .clamp(100),
            4
        );
    }

    #[test]
    fn limits_clamp_and_leave_room_for_mls() {
        let l = Limits::ENIGMA;
        assert_eq!(l.clamp(1), 16 * 1024);
        assert_eq!(l.clamp(usize::MAX), 4096 * 1024);
        assert!(l.max_frame() > l.max_chunk);
    }
}
