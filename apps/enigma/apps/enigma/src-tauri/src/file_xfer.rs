// Direct 1:1 peer-to-peer file transfer over iroh (QUIC), end-to-end encrypted by
// iroh's TLS 1.3 transport (peers authenticated by node id). Mirrors the parked Vox
// call backend (limbo/rust/vox.rs): a dedicated iroh node accepts a custom ALPN
// (`enigma/file/0`); the file owner (host) registers a file and shares its
// `EndpointAddr` + a one-time `offer_id` out of band — the frontend relays them as
// an MLS-encrypted `file_offer` chat message. The recipient `endpoint.connect()`s,
// opens one bi-stream, requests the offer, and streams the bytes straight to disk.
//
// Both sides stream in fixed chunks (never buffering the whole file in memory), so
// arbitrarily large files transfer with bounded memory. Progress is reported via
// `file://progress`; completion/failure via `file://done` / `file://error`.
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

use anyhow::{anyhow, Result};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, RelayMode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::{active_config, load_profile_state, AppConfigState};

const FILE_ALPN: &[u8] = b"enigma/file/0";
/// Streaming chunk size for both directions. Large enough to keep QUIC busy, small
/// enough that memory stays bounded regardless of file size.
const CHUNK: usize = crate::build_config::network::TRANSFER_CHUNK_BYTES;

// Shared with cloud.rs so every networked feature reports airplane mode identically.
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

pub struct FileNode {
    endpoint: Endpoint,
    _router: Router,
    /// Files we are currently hosting, keyed by `offer_id`.
    offers: Arc<Mutex<HashMap<String, OfferedFile>>>,
}

/// Everything the inbound protocol handler needs, behind `Arc`s so it can be cloned
/// into the router.
#[derive(Clone)]
struct FileShared {
    app: AppHandle,
    offers: Arc<Mutex<HashMap<String, OfferedFile>>>,
}

#[derive(Clone)]
struct OfferedFile {
    path: PathBuf,
    name: String,
    size: u64,
    mime: String,
}

// ── wire frames (length-prefixed JSON over the bi-stream) ─────────────────────

#[derive(Serialize, Deserialize)]
struct Request {
    offer_id: String,
}

#[derive(Serialize, Deserialize)]
struct Header {
    name: String,
    size: u64,
    mime: String,
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

// Also used by cloud.rs for the multipart upload's file part Content-Type.
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
    let builder = if crate::build_config::p2p::ALLOW_HOSTED_RELAYS {
        Endpoint::builder(presets::N0).relay_mode(RelayMode::Default)
    } else {
        Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled)
    };
    let endpoint = builder
        .bind()
        .await
        .map_err(|e| anyhow!("file iroh bind failed: {e}"))?;
    let offers = Arc::new(Mutex::new(HashMap::new()));
    let shared = FileShared { app: app.clone(), offers: offers.clone() };
    let router = Router::builder(endpoint.clone())
        .accept(FILE_ALPN, FileProtocol { shared })
        .spawn();
    *guard = Some(FileNode { endpoint, _router: router, offers });
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

        write_frame(
            &mut send,
            &Header { name: offer.name.clone(), size: offer.size, mime: offer.mime.clone() },
        )
        .await?;

        let mut file = tokio::fs::File::open(&offer.path).await?;
        let mut buf = vec![0u8; CHUNK];
        let mut sent: u64 = 0;
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            send.write_all(&buf[..n]).await?;
            sent += n as u64;
            emit_progress(&self.app, &req.offer_id, "send", sent, offer.size);
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
    write_frame(&mut send, &Request { offer_id: offer_id.clone() }).await?;

    let header: Header = read_frame(&mut recv).await?;
    let mut file = tokio::fs::File::create(&dest).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut got: u64 = 0;
    while let Some(n) = recv.read(&mut buf).await? {
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).await?;
        got += n as u64;
        emit_progress(&app, &offer_id, "recv", got, header.size);
    }
    file.flush().await?;

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
    }
    Ok(())
}

/// Downloader: connect to the host and stream the offered file to `dest`. Returns once
/// the transfer has started; progress arrives via `file://progress`.
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
}
