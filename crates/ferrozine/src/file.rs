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
use std::sync::atomic::{AtomicUsize, Ordering};
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
    /// Failed; the receiving side has removed its partial file.
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
        chunk.clamp(self.min_chunk, self.max_chunk)
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

struct HostInner {
    offers: Mutex<HashMap<String, OfferedFile>>,
    authorized: Mutex<HashMap<String, String>>,
    settings: Box<dyn Fn() -> HostSettings + Send + Sync>,
    observer: Observer,
    limits: Limits,
    authorize_wait: Duration,
}

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
            authorize_wait: Duration::from_secs(20),
        }))
    }

    /// How long a connection waits for its authorization to arrive. The
    /// downloader sends its commitment and dials at once, so the dial can win
    /// the race; the wait absorbs that. Default 20 s.
    pub fn with_authorize_wait(self, wait: Duration) -> Self {
        let inner = Arc::try_unwrap(self.0)
            .unwrap_or_else(|_| panic!("configure a FileHost before cloning it"));
        Self(Arc::new(HostInner {
            authorize_wait: wait,
            ..inner
        }))
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
        self.0
            .authorized
            .lock()
            .expect("authorized lock")
            .insert(offer_id.to_owned(), commitment.to_owned());
    }

    async fn wait_for_authorization(&self, offer_id: &str) -> Option<String> {
        let deadline = tokio::time::Instant::now() + self.0.authorize_wait;
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
        let _active = Active::new();
        let req: Request = read_control(&mut recv).await?;
        let offer_id = req.offer_id.clone();
        let result = self.serve_request(req, &mut recv, &mut send).await;
        let event = match &result {
            Ok(()) => TransferEvent::Done {
                offer_id,
                direction: Direction::Send,
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

    async fn serve_request<R, W>(&self, req: Request, recv: &mut R, send: &mut W) -> Result<()>
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
        let expected = self
            .wait_for_authorization(&req.offer_id)
            .await
            .ok_or_else(|| {
                Error::Unauthorized(format!("no peer was authorized for offer {}", req.offer_id))
            })?;
        let key_package = unb64(&req.key_package)?;
        if pair::commitment(&key_package) != expected {
            return Err(Error::Unauthorized(
                "KeyPackage does not match the authorized peer".into(),
            ));
        }
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
        send.shutdown().await?;
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
        // Errors before the request names an offer have no one to report to;
        // after that, `serve` has reported them.
        if let Ok((send, recv)) = conn.accept_bi().await {
            let _ = self.serve(recv, send).await;
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
}

/// Make the KeyPackage for fetching `offer_id`. Send
/// [`commitment`](Prepared::commitment) to the host over an authenticated
/// channel, then [`download`] (or [`receive`]).
pub fn prepare(offer_id: &str) -> Result<Prepared> {
    Ok(Prepared {
        offer_id: offer_id.to_owned(),
        caller: Caller::start(offer_id, "peer")?,
    })
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
    let result = receive_inner(
        prepared,
        &mut recv,
        &mut send,
        dest,
        want_integrity,
        limits,
        &observer,
    )
    .await;
    match &result {
        Ok(()) => observer(TransferEvent::Done {
            offer_id,
            direction: Direction::Recv,
        }),
        Err(e) => {
            let _ = tokio::fs::remove_file(dest).await;
            observer(TransferEvent::Failed {
                offer_id,
                direction: Direction::Recv,
                message: e.to_string(),
            });
        }
    }
    result
}

async fn receive_inner<R, W>(
    prepared: Prepared,
    recv: &mut R,
    send: &mut W,
    dest: &Path,
    want_integrity: bool,
    limits: Limits,
    observer: &Observer,
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
    };
    write_control(send, &request).await?;
    let header: Header = read_control(recv).await?;
    if want_integrity && !header.integrity {
        return Err(Error::Integrity(
            "the sender did not provide an integrity manifest".into(),
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
            "got {seq} of {} announced chunks",
            header.chunk_count
        )));
    }
    if header.integrity {
        let (count, root) =
            trailer.ok_or_else(|| Error::Integrity("integrity manifest missing".into()))?;
        if count != seq {
            return Err(Error::Integrity(format!(
                "manifest counts {count} chunks, received {seq}"
            )));
        }
        if root != chain {
            return Err(Error::Integrity("the file was altered in transit".into()));
        }
    }
    send.write_all(&[1u8]).await?;
    send.shutdown().await?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn limits_clamp_and_leave_room_for_mls() {
        let l = Limits::ENIGMA;
        assert_eq!(l.clamp(1), 16 * 1024);
        assert_eq!(l.clamp(usize::MAX), 4096 * 1024);
        assert!(l.max_frame() > l.max_chunk);
    }
}
