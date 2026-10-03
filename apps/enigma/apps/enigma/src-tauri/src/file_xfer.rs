// Direct 1:1 peer-to-peer file transfer over iroh (QUIC). A dedicated iroh node
// accepts a custom ALPN (`enigma/file/1`); the file owner (host) registers a file
// and shares its `EndpointAddr` + a one-time `offer_id` out of band — the frontend
// relays them as an MLS-encrypted `file_offer` chat message. The recipient
// `endpoint.connect()`s and opens one bi-stream.
//
// THE BYTES THEMSELVES ARE MLS-ENCRYPTED (protocol v1). Before any data moves the
// two sides run an MLS handshake in-stream — the downloader is the caller (sends a
// KeyPackage in the Request), the host is the callee (creates the 2-member group
// and returns the Welcome in the Header), copying Vox verbatim (vox.rs mls_callee /
// mls_caller_start / mls_caller_join). The session is per-transfer, in-memory
// (MemoryStorage), and dropped with the connection — nothing to persist or clean up.
// Every chunk is then sealed with `encrypt_app`, exactly like a chat message, so the
// payload is protected by MLS and not merely by the QUIC transport.
//
// INTEGRITY. Each chunk extends a BLAKE3 hash chain (h_i = BLAKE3(h_{i-1} || seq ||
// chunk)); the host sends the root in a trailer frame and the receiver, having
// recomputed the chain as it wrote, refuses the file on any mismatch — which also
// catches a dropped chunk or a truncated stream (a real gap before: the old code
// never compared the received byte count to the announced size). The check is a
// user setting; either side enabling it turns it on for the transfer.
//
// Both sides stream in chunks (never buffering the whole file in memory), so
// arbitrarily large files transfer with bounded memory. Progress is reported via
// `file://progress` — throttled to whole-percent ticks, since that is all the UI
// renders; completion/failure via `file://done` / `file://error`.
//
// AUTHENTICATION is unchanged and possession-based: the host does not authenticate
// the dialer, so anyone holding {addr, offer_id} can complete the handshake. Those
// stay secret because each feature relays them inside its own MLS-encrypted
// signalling. The MLS layer here buys confidentiality of the bytes, not peer auth.
//
// The endpoint is deliberately ephemeral (no `load_or_create_secret`): the offer
// addr is relayed fresh per offer, so no reconnect-by-NodeId is ever needed, and an
// ephemeral identity avoids linkability across transfers.
//
// Network-policy gates (both checked in `file_offer_create` / `file_download`):
// airplane mode blocks all networking; Tor-exclusive mode blocks file transfer
// entirely because it is iroh-only — a direct QUIC connection from a Tor-routed
// profile would leak the user's IP outside Tor.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, RelayMode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use rotor_core::RotorSession;

use crate::{active_config, load_profile_state, AppConfigState};

// v1: chunks are MLS ciphertext. A v0 peer cannot negotiate this ALPN, so a
// version skew fails to connect instead of misreading the stream.
const FILE_ALPN: &[u8] = b"enigma/file/1";
/// The user's "file chunk size" setting, bytes. Re-read per transfer (the
/// connect-timeout discipline: Settings edits apply live, never a baked
/// literal). The HOST's value governs a transfer.
pub(crate) fn file_chunk_bytes(app: &AppHandle) -> usize {
    use crate::build_config::settings as s;
    let kib = crate::vault::kv_get_raw(app, "p2p:settings", "default", "file_chunk_kib")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(s::FILE_CHUNK_MIN_KIB, s::FILE_CHUNK_MAX_KIB))
        .unwrap_or(s::FILE_CHUNK_DEFAULT_KIB);
    (kib as usize) * 1024
}

/// The user's integrity-check toggle (Settings), default from the build config.
pub(crate) fn file_integrity_enabled(app: &AppHandle) -> bool {
    match crate::vault::kv_get_raw(app, "p2p:settings", "default", "file_integrity").as_deref() {
        Some("on") => true,
        Some("off") => false,
        _ => crate::build_config::defaults::FILE_INTEGRITY_DEFAULT,
    }
}

// Every networked feature reports airplane mode with this same string.
pub(crate) const OFFLINE_BLOCKED: &str = "Offline — all network connections are blocked.";
const TOR_BLOCKED: &str = "File transfer is unavailable in Tor mode.";

// ── network-policy gates ──────────────────────────────────────────────────────

/// Airplane mode: true when the offline switch is on (blocks all P2P networking).
fn offline(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg)))
}

/// True when this profile routes over the Tor onion transport instead of iroh.
fn use_tor(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_use_tor(&load_profile_state(app, &cfg)))
}

/// Both gates at once — every networked file command runs this first.
fn check_network_policy(app: &AppHandle, config: &State<'_, AppConfigState>) -> Result<(), String> {
    if offline(app, config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    if use_tor(app, config) {
        return Err(TOR_BLOCKED.to_string());
    }
    Ok(())
}

// ── state ────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct FileXferState(pub Mutex<Option<FileNode>>);

/// Transfers currently moving bytes, in either direction. The lock watchdog
/// (vault.rs) reads this as presence: a frozen webview sends no heartbeats, and
/// the fallback must not cut a transfer that is still running. Chat files, map
/// regions and Files → Devices sync all ride this path, so counting it here
/// covers every one of them.
static ACTIVE_TRANSFERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Counts a transfer for as long as it lives — Drop runs however it ends
/// (finished, errored, or aborted when `shutdown` closes the endpoint).
struct TransferGuard;

impl TransferGuard {
    fn new() -> Self {
        ACTIVE_TRANSFERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        ACTIVE_TRANSFERS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

pub fn transfers_active() -> bool {
    ACTIVE_TRANSFERS.load(std::sync::atomic::Ordering::Relaxed) > 0
}

/// Sessions minted by `file_prepare`, awaiting their `file_download`. Global
/// rather than on FileNode because an airplane/Tor toggle can rebind the node
/// between the two calls.
static PREPARED: std::sync::OnceLock<Prepared> = std::sync::OnceLock::new();

fn prepared() -> &'static Prepared {
    PREPARED.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

pub struct FileNode {
    endpoint: Endpoint,
    _router: Router,
    /// Files we are currently hosting, keyed by `offer_id`.
    offers: Arc<Mutex<HashMap<String, OfferedFile>>>,
    expectations: Expectations,
}

/// Everything the inbound protocol handler needs, behind `Arc`s so it can be cloned
/// into the router.
#[derive(Clone)]
struct FileShared {
    app: AppHandle,
    offers: Arc<Mutex<HashMap<String, OfferedFile>>>,
    expectations: Expectations,
}

#[derive(Clone)]
struct OfferedFile {
    path: PathBuf,
    name: String,
    size: u64,
    mime: String,
}

// ── wire frames (length-prefixed JSON over the bi-stream) ─────────────────────

/// Downloader sessions minted by `file_prepare`, awaiting their `file_download`.
/// Keyed by offer_id; consumed by the download or dropped on cancel.
type Prepared = Arc<Mutex<HashMap<String, (RotorSession, String)>>>;

/// Host-side: offer_id → the KeyPackage hash the intended peer committed to
/// over its feature's own MLS signalling. A connection whose KeyPackage hashes
/// to anything else is refused.
type Expectations = Arc<Mutex<HashMap<String, String>>>;

/// How long `serve` waits for the expectation to arrive. The downloader sends
/// its bind message and dials immediately, so the QUIC connect can beat the
/// signalling — this absorbs that race rather than failing the transfer.
const EXPECT_WAIT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize)]
struct Request {
    offer_id: String,
    /// Downloader's MLS KeyPackage, base64 (the caller role).
    key_package: String,
    /// This side wants the hash chain. The host ORs it with its own setting, so
    /// either party can insist; a downloader that asked and does not get one
    /// aborts rather than accept unverified bytes.
    want_integrity: bool,
}

#[derive(Serialize, Deserialize)]
struct Header {
    name: String,
    size: u64,
    mime: String,
    /// MLS Welcome for the 2-member group, base64.
    welcome: String,
    /// The host's chunk size governs this transfer; echoed so the receiver can
    /// size its read buffer and know what the chain covers.
    chunk_size: u32,
    chunk_count: u64,
    integrity: bool,
}

/// Plaintext discriminator, INSIDE the MLS ciphertext so it is authenticated.
const KIND_CHUNK: u8 = 0;
const KIND_TRAILER: u8 = 1;

/// Domain-separated chain seed — binds the chain to this offer so a chunk
/// cannot be replayed into a different transfer.
fn chain_seed(offer_id: &str) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"enigma/file/chain/v1");
    h.update(offer_id.as_bytes());
    *h.finalize().as_bytes()
}

/// h_i = BLAKE3(h_{i-1} || seq || chunk)
fn chain_step(prev: &[u8; 32], seq: u64, chunk: &[u8]) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(prev);
    h.update(&seq.to_be_bytes());
    h.update(chunk);
    *h.finalize().as_bytes()
}

fn b64(bytes: &[u8]) -> String {
    data_encoding::BASE64.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>> {
    Ok(data_encoding::BASE64.decode(s.as_bytes())?)
}

/// Host side: form the 2-member group from the downloader's KeyPackage and
/// return the base64 Welcome (vox.rs::mls_callee, verbatim shape).
fn mls_host(offer_id: &str, kp_b64: &str) -> Result<(RotorSession, String)> {
    let kp = unb64(kp_b64)?;
    let mut session = RotorSession::new(offer_id.to_string(), "host".to_string())
        .map_err(|e| anyhow!("mls new: {e}"))?;
    session.create_group().map_err(|e| anyhow!("mls create_group: {e}"))?;
    let (welcome, _commit) = session.add_member(&kp).map_err(|e| anyhow!("mls add_member: {e}"))?;
    Ok((session, b64(&welcome)))
}

/// Downloader side: fresh session + our KeyPackage; the session is kept so we
/// can join from the Welcome the host returns.
fn mls_downloader_start(offer_id: &str) -> Result<(RotorSession, String)> {
    let mut session = RotorSession::new(offer_id.to_string(), "peer".to_string())
        .map_err(|e| anyhow!("mls new: {e}"))?;
    let kp = session.key_package().map_err(|e| anyhow!("mls key_package: {e}"))?;
    Ok((session, b64(&kp)))
}

/// BLAKE3 of the base64 KeyPackage, hex — what the downloader publishes over
/// signalling and the host compares against.
fn kp_hash(key_package_b64: &str) -> String {
    blake3::hash(key_package_b64.as_bytes()).to_hex().to_string()
}

/// Poll for the authorization to land. The bind message and the QUIC dial race
/// each other, so a brief wait is the difference between "not authorized" and
/// "authorization is still in flight".
async fn wait_for_expectation(expectations: &Expectations, offer_id: &str) -> Option<String> {
    let deadline = tokio::time::Instant::now() + EXPECT_WAIT;
    loop {
        if let Some(hash) = expectations.lock().await.get(offer_id).cloned() {
            return Some(hash);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Length-prefixed raw frame (the payload is MLS ciphertext, not JSON).
async fn write_blob(send: &mut SendStream, body: &[u8]) -> Result<()> {
    send.write_all(&(body.len() as u32).to_le_bytes()).await?;
    send.write_all(body).await?;
    Ok(())
}

async fn read_blob(recv: &mut RecvStream, max: usize) -> Result<Vec<u8>> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await?;
    let n = u32::from_le_bytes(len) as usize;
    if n > max {
        return Err(anyhow!("data frame too large ({n} > {max})"));
    }
    let mut body = vec![0u8; n];
    recv.read_exact(&mut body).await?;
    Ok(body)
}

/// Ceiling for a data frame: the biggest chunk this build allows plus room for
/// MLS framing (openmls PrivateMessage overhead is well under 1 KiB).
fn max_data_frame() -> usize {
    (crate::build_config::settings::FILE_CHUNK_MAX_KIB as usize) * 1024 + 8 * 1024
}

/// Fill `buf` unless EOF. `AsyncRead::read` may return a short read at any time;
/// a short chunk mid-file would desynchronise the receiver's chain, so the
/// sender packs full chunks and only the last one is short.
async fn read_full(file: &mut tokio::fs::File, buf: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Emits at most once per whole percent — all the UI renders (FilePanel rounds
/// to an integer), so a per-chunk firehose was wasted work on large files.
struct PercentTicker {
    last: i64,
}

impl PercentTicker {
    fn new() -> Self {
        Self { last: -1 }
    }

    /// `Some(())` when this byte count crosses into a new percent.
    fn tick(&mut self, done: u64, total: u64) -> Option<()> {
        let pct = if total == 0 { 100 } else { (done * 100 / total) as i64 };
        if pct != self.last {
            self.last = pct;
            return Some(());
        }
        None
    }
}

/// Receive, decrypt and verify every chunk. Split out of `download` so a
/// failure anywhere has one place to clean up the partial file.
async fn receive_chunks(
    app: &AppHandle,
    session: &mut RotorSession,
    recv: &mut RecvStream,
    offer_id: &str,
    header: &Header,
    dest: &str,
) -> Result<()> {
    let mut file = tokio::fs::File::create(dest).await?;
    let mut got: u64 = 0;
    let mut expect_seq: u64 = 0;
    let mut chain = chain_seed(offer_id);
    let mut trailer: Option<(u64, [u8; 32])> = None;
    let mut ticks = PercentTicker::new();
    let cap = max_data_frame();

    loop {
        let sealed = match read_blob(recv, cap).await {
            Ok(b) => b,
            // Clean end of stream — the size/chain checks below decide whether
            // that was a complete transfer or a truncated one.
            Err(_) => break,
        };
        let plain = session
            .process_message(&sealed)
            .map_err(|e| anyhow!("mls decrypt: {e}"))?
            .ok_or_else(|| anyhow!("mls: not an application message"))?;

        match plain.first().copied() {
            Some(KIND_CHUNK) => {
                if plain.len() < 9 {
                    return Err(anyhow!("short chunk frame"));
                }
                let seq = u64::from_be_bytes(plain[1..9].try_into().unwrap());
                if seq != expect_seq {
                    return Err(anyhow!("chunk out of order: expected {expect_seq}, got {seq}"));
                }
                let body = &plain[9..];
                if header.integrity {
                    chain = chain_step(&chain, seq, body);
                }
                file.write_all(body).await?;
                got += body.len() as u64;
                expect_seq += 1;
                if let Some(()) = ticks.tick(got, header.size) {
                    emit_progress(app, offer_id, "recv", got, header.size);
                }
            }
            Some(KIND_TRAILER) => {
                if plain.len() < 41 {
                    return Err(anyhow!("short trailer frame"));
                }
                let count = u64::from_be_bytes(plain[1..9].try_into().unwrap());
                let mut root = [0u8; 32];
                root.copy_from_slice(&plain[9..41]);
                trailer = Some((count, root));
                break;
            }
            _ => return Err(anyhow!("unknown frame kind")),
        }
    }
    file.flush().await?;
    emit_progress(app, offer_id, "recv", got, header.size);

    // Truncation check — this exists for every transfer, chain or not. The old
    // protocol had none: a stream that closed early looked like success.
    if got != header.size {
        return Err(anyhow!("incomplete transfer: got {got} of {} bytes", header.size));
    }
    if expect_seq != header.chunk_count {
        return Err(anyhow!(
            "missing chunks: got {expect_seq} of {} announced",
            header.chunk_count
        ));
    }
    if header.integrity {
        let Some((count, root)) = trailer else {
            return Err(anyhow!("integrity manifest missing — transfer was cut short"));
        };
        if count != expect_seq {
            return Err(anyhow!("manifest counts {count} chunks, received {expect_seq}"));
        }
        if root != chain {
            return Err(anyhow!("integrity check failed — the file was altered in transit"));
        }
    }
    Ok(())
}

fn frame_bytes<T: Serialize>(val: &T) -> Vec<u8> {
    let body = serde_json::to_vec(val).unwrap_or_default();
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

async fn write_frame<T: Serialize>(send: &mut SendStream, val: &T) -> Result<()> {
    send.write_all(&frame_bytes(val)).await?;
    Ok(())
}

async fn read_frame<T: DeserializeOwned>(recv: &mut RecvStream) -> Result<T> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await?;
    let n = u32::from_le_bytes(len) as usize;
    // Control frames only (Request/Header). A KeyPackage is ~1 KiB and a
    // Welcome ~2 KiB, so 64 KiB stays generous; chunk frames use read_blob.
    if n > 64 * 1024 {
        return Err(anyhow!("control frame too large"));
    }
    let mut body = vec![0u8; n];
    recv.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

// ── addr encoding (postcard + base32, like the room ticket) ───────────────────

fn encode_addr(addr: &EndpointAddr) -> String {
    let bytes = postcard::to_stdvec(addr).expect("postcard::to_stdvec is infallible");
    let mut text = data_encoding::BASE32_NOPAD.encode(&bytes);
    text.make_ascii_lowercase();
    text
}

fn decode_addr(s: &str) -> Result<EndpointAddr> {
    let bytes = data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?;
    Ok(postcard::from_bytes(&bytes)?)
}

pub(crate) fn mime_from_ext(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let m = match ext.as_str() {
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
    };
    m.to_string()
}

// ── events ───────────────────────────────────────────────────────────────────

fn emit_progress(app: &AppHandle, offer_id: &str, dir: &str, transferred: u64, total: u64) {
    let _ = app.emit(
        "file://progress",
        serde_json::json!({ "offerId": offer_id, "dir": dir, "transferred": transferred, "total": total }),
    );
}

fn emit_done(app: &AppHandle, offer_id: &str, dir: &str) {
    let _ = app.emit("file://done", serde_json::json!({ "offerId": offer_id, "dir": dir }));
}

fn emit_error(app: &AppHandle, offer_id: &str, message: &str) {
    let _ = app.emit("file://error", serde_json::json!({ "offerId": offer_id, "message": message }));
}

// ── lifecycle ────────────────────────────────────────────────────────────────

async fn ensure_started(app: &AppHandle, state: &FileXferState) -> Result<()> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    // Hosted-infra policy is build-time: N0 = n0 relay + pkarr/DNS discovery,
    // Minimal + Disabled = direct QUIC only (same pair the vox tests use).
    let builder = if crate::features::HOSTED_RELAYS {
        Endpoint::builder(presets::N0).relay_mode(RelayMode::Default)
    } else {
        Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled)
    };
    let endpoint = builder
        .bind()
        .await
        .map_err(|e| anyhow!("file iroh bind failed: {e}"))?;
    let offers = Arc::new(Mutex::new(HashMap::new()));
    let expectations: Expectations = Arc::new(Mutex::new(HashMap::new()));
    let shared =
        FileShared { app: app.clone(), offers: offers.clone(), expectations: expectations.clone() };
    let router = Router::builder(endpoint.clone())
        .accept(FILE_ALPN, FileProtocol { shared })
        .spawn();
    *guard = Some(FileNode { endpoint, _router: router, offers, expectations });
    Ok(())
}

/// Tear down the file node (airplane mode on, Tor mode on, profile switch). Pending
/// offers and in-flight transfers die with the endpoint; the next offer/download
/// lazily re-binds a fresh (ephemeral-identity) node.
pub async fn shutdown(state: &FileXferState) {
    let mut guard = state.0.lock().await;
    if let Some(node) = guard.take() {
        // Best-effort graceful close; dropping the endpoint would also terminate.
        node.endpoint.close().await;
    }
}

// ── inbound (host serves an offered file) ─────────────────────────────────────

#[derive(Clone)]
struct FileProtocol {
    shared: FileShared,
}

impl std::fmt::Debug for FileProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FileProtocol")
    }
}

impl ProtocolHandler for FileProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        if let Err(e) = self.shared.clone().serve(conn).await {
            eprintln!("[file] serve ended: {e}");
        }
        Ok(())
    }
}

impl FileShared {
    async fn serve(self, conn: Connection) -> Result<()> {
        let _active = TransferGuard::new();
        let (mut send, mut recv) = conn.accept_bi().await?;
        let req: Request = read_frame(&mut recv).await?;

        let offer = {
            let offers = self.offers.lock().await;
            offers.get(&req.offer_id).cloned()
        };
        let Some(offer) = offer else {
            return Err(anyhow!("unknown offer {}", req.offer_id));
        };

        // Authenticate the downloader BEFORE any file metadata leaves: the
        // intended peer committed to this exact KeyPackage over the feature's
        // own MLS signalling, so only the holder of its private key can be on
        // the other end. Possession of {addr, offer_id} is no longer enough.
        let expected = wait_for_expectation(&self.expectations, &req.offer_id).await;
        let Some(expected) = expected else {
            return Err(anyhow!("no peer was authorized for offer {}", req.offer_id));
        };
        if kp_hash(&req.key_package) != expected {
            return Err(anyhow!("KeyPackage does not match the authorized peer"));
        }

        // MLS handshake: we are the callee — group of two, Welcome goes back in
        // the header so the downloader can join before the first chunk.
        let (mut session, welcome) = mls_host(&req.offer_id, &req.key_package)?;

        let chunk_size = file_chunk_bytes(&self.app);
        let integrity = file_integrity_enabled(&self.app) || req.want_integrity;
        let chunk_count = offer.size.div_ceil(chunk_size as u64);

        write_frame(
            &mut send,
            &Header {
                name: offer.name.clone(),
                size: offer.size,
                mime: offer.mime.clone(),
                welcome,
                chunk_size: chunk_size as u32,
                chunk_count,
                integrity,
            },
        )
        .await?;

        let mut file = tokio::fs::File::open(&offer.path).await?;
        let mut buf = vec![0u8; chunk_size];
        let mut sent: u64 = 0;
        let mut seq: u64 = 0;
        let mut chain = chain_seed(&req.offer_id);
        let mut ticks = PercentTicker::new();
        loop {
            // read() may return a short read; fill the chunk so the receiver's
            // sizes (and therefore the chain) match what the header promised.
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
            let sealed = session.encrypt_app(&plain).map_err(|e| anyhow!("mls encrypt: {e}"))?;
            write_blob(&mut send, &sealed).await?;

            sent += n as u64;
            seq += 1;
            if let Some(()) = ticks.tick(sent, offer.size) {
                emit_progress(&self.app, &req.offer_id, "send", sent, offer.size);
            }
        }
        emit_progress(&self.app, &req.offer_id, "send", sent, offer.size);

        if integrity {
            let mut plain = Vec::with_capacity(41);
            plain.push(KIND_TRAILER);
            plain.extend_from_slice(&seq.to_be_bytes());
            plain.extend_from_slice(&chain);
            let sealed = session.encrypt_app(&plain).map_err(|e| anyhow!("mls encrypt: {e}"))?;
            write_blob(&mut send, &sealed).await?;
        }
        let _ = send.finish();

        // Wait for the downloader's 1-byte ack so all data is flushed before we close.
        let mut ack = [0u8; 1];
        let _ = recv.read_exact(&mut ack).await;
        emit_done(&self.app, &req.offer_id, "send");
        Ok(())
    }
}

// ── outbound (downloader pulls the file) ──────────────────────────────────────

async fn download(
    app: AppHandle,
    endpoint: Endpoint,
    addr: EndpointAddr,
    offer_id: String,
    dest: String,
) -> Result<()> {
    let _active = TransferGuard::new();
    let conn = endpoint.connect(addr, FILE_ALPN).await?;
    let (mut send, mut recv) = conn.open_bi().await?;

    // We are the MLS caller. The session was minted by `file_prepare` and its
    // KeyPackage hash already published to the host over signalling — reusing it
    // here is what ties this connection to that authorization.
    let (mut session, key_package) = {
        let mut map = prepared().lock().await;
        map.remove(&offer_id)
            .ok_or_else(|| anyhow!("call file_prepare before downloading"))?
    };
    let want_integrity = file_integrity_enabled(&app);
    write_frame(
        &mut send,
        &Request { offer_id: offer_id.clone(), key_package, want_integrity },
    )
    .await?;

    let header: Header = read_frame(&mut recv).await?;
    if want_integrity && !header.integrity {
        return Err(anyhow!(
            "the sender did not provide an integrity manifest (verification is on for this device)"
        ));
    }
    session
        .join_from_welcome(&unb64(&header.welcome)?)
        .map_err(|e| anyhow!("mls join: {e}"))?;

    // Anything that fails from here must not leave a half-written file behind.
    let outcome = receive_chunks(&app, &mut session, &mut recv, &offer_id, &header, &dest).await;
    if outcome.is_err() {
        let _ = tokio::fs::remove_file(&dest).await;
    }
    outcome?;

    // Ack so the host knows we received everything, then close.
    let _ = send.write_all(&[1u8]).await;
    let _ = send.finish();
    conn.close(0u32.into(), b"done");
    emit_done(&app, &offer_id, "recv");
    Ok(())
}

// ── commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct OfferCreated {
    offer_id: String,
    addr: String,
    name: String,
    size: u64,
    mime: String,
}

/// Host: register a local file to serve and return the offer metadata (including our
/// dialable `EndpointAddr`) for the frontend to relay to the chosen peer.
#[tauri::command]
pub async fn file_offer_create(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    state: State<'_, FileXferState>,
    path: String,
) -> Result<OfferCreated, String> {
    check_network_policy(&app, &config)?;
    ensure_started(&app, &state).await.map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("stat failed: {e}"))?;
    let size = meta.len();
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let mime = mime_from_ext(&name);
    let offer_id = uuid::Uuid::new_v4().to_string();

    let guard = state.0.lock().await;
    let node = guard.as_ref().ok_or("file not started")?;
    node.offers.lock().await.insert(
        offer_id.clone(),
        OfferedFile { path: p, name: name.clone(), size, mime: mime.clone() },
    );
    let addr = encode_addr(&node.endpoint.addr());
    Ok(OfferCreated { offer_id, addr, name, size, mime })
}

/// Host: forget an offer (declined / cancelled / finished). Ungated — it only clears
/// local state.
#[tauri::command]
pub async fn file_offer_cancel(state: State<'_, FileXferState>, offer_id: String) -> Result<(), String> {
    let guard = state.0.lock().await;
    if let Some(node) = guard.as_ref() {
        node.offers.lock().await.remove(&offer_id);
        // The authorization dies with the offer — a re-offer must be re-authorized.
        node.expectations.lock().await.remove(&offer_id);
    }
    Ok(())
}

/// Mint this device's transfer KeyPackage and return its hash. The caller
/// publishes the hash to the host over its feature's own MLS signalling (chat
/// `file_accept`, the Maps bind card, devlink `dlink_file_bind`); the host then
/// accepts only a connection presenting that KeyPackage. Must be called before
/// `file_download`.
#[tauri::command]
pub async fn file_prepare(offer_id: String) -> Result<String, String> {
    let (session, key_package) =
        mls_downloader_start(&offer_id).map_err(|e| e.to_string())?;
    let hash = kp_hash(&key_package);
    prepared().lock().await.insert(offer_id, (session, key_package));
    Ok(hash)
}

/// Host side: authorize exactly one peer for an offer, by the KeyPackage hash it
/// published over signalling. Until this lands, `serve` refuses the connection.
#[tauri::command]
pub async fn file_authorize(
    state: State<'_, FileXferState>,
    offer_id: String,
    kp_hash: String,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    let node = guard.as_ref().ok_or("file not started")?;
    node.expectations.lock().await.insert(offer_id, kp_hash);
    Ok(())
}

/// Downloader: connect to the host and stream the offered file to `dest`. Returns
/// once the transfer has started; progress arrives via `file://progress`.
#[tauri::command]
pub async fn file_download(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    state: State<'_, FileXferState>,
    addr: String,
    offer_id: String,
    dest: String,
) -> Result<(), String> {
    check_network_policy(&app, &config)?;
    ensure_started(&app, &state).await.map_err(|e| e.to_string())?;
    let endpoint = {
        let guard = state.0.lock().await;
        guard.as_ref().ok_or("file not started")?.endpoint.clone()
    };
    let addr = decode_addr(&addr).map_err(|e| format!("invalid addr: {e}"))?;
    let app2 = app.clone();
    let offer_id2 = offer_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = download(app2.clone(), endpoint, addr, offer_id2.clone(), dest).await {
            emit_error(&app2, &offer_id2, &e.to_string());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_maps_known_extensions_and_defaults() {
        assert_eq!(mime_from_ext("photo.PNG"), "image/png");
        assert_eq!(mime_from_ext("archive.zip"), "application/zip");
        assert_eq!(mime_from_ext("noext"), "application/octet-stream");
    }

    /// The chain is what turns "the bytes arrived" into "the RIGHT bytes
    /// arrived, all of them, in order".
    #[test]
    fn chain_is_order_and_content_sensitive() {
        let seed = chain_seed("offer-1");
        let a = chain_step(&seed, 0, b"alpha");
        let ab = chain_step(&a, 1, b"beta");

        // Same chunks, swapped order -> different root.
        let b = chain_step(&seed, 0, b"beta");
        let ba = chain_step(&b, 1, b"alpha");
        assert_ne!(ab, ba);

        // One flipped byte -> different root.
        let a2 = chain_step(&seed, 0, b"alpha");
        let ab2 = chain_step(&a2, 1, b"betb");
        assert_ne!(ab, ab2);

        // A dropped middle chunk -> different root.
        let dropped = chain_step(&seed, 0, b"alpha");
        assert_ne!(ab, dropped);
    }

    #[test]
    fn chain_is_bound_to_the_offer() {
        // A chunk replayed into another transfer cannot reproduce its root.
        let one = chain_step(&chain_seed("offer-1"), 0, b"payload");
        let two = chain_step(&chain_seed("offer-2"), 0, b"payload");
        assert_ne!(one, two);
    }

    #[test]
    fn chain_is_deterministic() {
        let a = chain_step(&chain_seed("x"), 7, b"same");
        let b = chain_step(&chain_seed("x"), 7, b"same");
        assert_eq!(a, b);
    }

    #[test]
    fn percent_ticker_fires_once_per_whole_percent() {
        let mut t = PercentTicker::new();
        let total = 10_000u64;
        // Byte-at-a-time over a 10 KB file: 101 ticks (0% through 100%).
        let fired = (0..=total).filter(|done| t.tick(*done, total).is_some()).count();
        assert_eq!(fired, 101);
    }

    #[test]
    fn percent_ticker_handles_a_tiny_and_an_empty_file() {
        // One chunk covering the whole file: 100% once.
        let mut t = PercentTicker::new();
        assert!(t.tick(12, 12).is_some());
        assert!(t.tick(12, 12).is_none());

        // Zero-length file: reports complete rather than dividing by zero.
        let mut t = PercentTicker::new();
        assert!(t.tick(0, 0).is_some());
    }

    /// The MLS handshake both sides run in-stream, and a chunk round-trip
    /// through it — the same primitives Vox uses.
    #[test]
    fn mls_handshake_round_trips_a_chunk() {
        let (mut peer, kp) = mls_downloader_start("offer-1").unwrap();
        let (mut host, welcome) = mls_host("offer-1", &kp).unwrap();
        peer.join_from_welcome(&unb64(&welcome).unwrap()).unwrap();

        let mut plain = vec![KIND_CHUNK];
        plain.extend_from_slice(&7u64.to_be_bytes());
        plain.extend_from_slice(b"chunk payload");

        let sealed = host.encrypt_app(&plain).unwrap();
        assert_ne!(sealed, plain, "the payload must not travel in the clear");

        let opened = peer.process_message(&sealed).unwrap().expect("application message");
        assert_eq!(opened, plain);
        assert_eq!(opened[0], KIND_CHUNK);
        assert_eq!(u64::from_be_bytes(opened[1..9].try_into().unwrap()), 7);
        assert_eq!(&opened[9..], b"chunk payload");
    }

    #[test]
    fn a_foreign_session_cannot_open_our_chunks() {
        let (_peer, kp) = mls_downloader_start("offer-1").unwrap();
        let (mut host, _welcome) = mls_host("offer-1", &kp).unwrap();
        let sealed = host.encrypt_app(b"secret").unwrap();

        // A session that never joined the group.
        let (mut outsider, kp2) = mls_downloader_start("offer-1").unwrap();
        let (_other_host, welcome2) = mls_host("offer-1", &kp2).unwrap();
        outsider.join_from_welcome(&unb64(&welcome2).unwrap()).unwrap();
        assert!(outsider.process_message(&sealed).is_err());
    }

    #[test]
    fn kp_hash_is_stable_and_discriminating() {
        // The downloader publishes this over signalling and the host compares
        // it byte-for-byte — it must be deterministic and collision-free in
        // practice, or authorization is theatre.
        let (_s, kp_a) = mls_downloader_start("offer-1").unwrap();
        let (_s2, kp_b) = mls_downloader_start("offer-1").unwrap();
        assert_eq!(kp_hash(&kp_a), kp_hash(&kp_a));
        assert_ne!(kp_hash(&kp_a), kp_hash(&kp_b), "distinct KeyPackages must not collide");
        assert_eq!(kp_hash(&kp_a).len(), 64, "blake3 hex");
    }

    #[tokio::test]
    async fn an_unauthorized_offer_is_refused_after_the_wait() {
        // No authorization ever arrives -> serve refuses rather than serving
        // whoever holds the offer coordinates.
        let expectations: Expectations = Arc::new(Mutex::new(HashMap::new()));
        tokio::time::pause();
        let waiter = tokio::spawn({
            let e = expectations.clone();
            async move { wait_for_expectation(&e, "offer-1").await }
        });
        tokio::time::advance(EXPECT_WAIT + Duration::from_secs(1)).await;
        assert_eq!(waiter.await.unwrap(), None);
    }

    #[tokio::test]
    async fn an_authorization_arriving_late_still_wins_the_race() {
        // The bind message and the QUIC dial race; serve waits rather than
        // failing a transfer that was in fact authorized.
        let expectations: Expectations = Arc::new(Mutex::new(HashMap::new()));
        let waiter = tokio::spawn({
            let e = expectations.clone();
            async move { wait_for_expectation(&e, "offer-1").await }
        });
        tokio::time::sleep(Duration::from_millis(250)).await;
        expectations.lock().await.insert("offer-1".into(), "abc".into());
        assert_eq!(waiter.await.unwrap(), Some("abc".to_string()));
    }

    #[test]
    fn data_frame_cap_admits_the_largest_legal_chunk() {
        let biggest = (crate::build_config::settings::FILE_CHUNK_MAX_KIB as usize) * 1024;
        assert!(max_data_frame() > biggest, "MLS overhead needs headroom above the chunk");
        // …and stays within one wire frame.
        assert!(biggest <= crate::build_config::network::MAX_FRAME_BYTES);
    }

    #[test]
    fn chunk_count_matches_what_the_sender_will_emit() {
        // The header promises a count the receiver checks; div_ceil must agree
        // with "loop until read_full returns 0".
        for (size, chunk, want) in [(0u64, 256u64, 0u64), (1, 256, 1), (256, 256, 1), (257, 256, 2)] {
            assert_eq!(size.div_ceil(chunk), want, "size {size} chunk {chunk}");
        }
    }
}
