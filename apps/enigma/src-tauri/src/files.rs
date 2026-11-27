// File transfer between two members, over the sender's onion for the room.
//
// The offer and the downloader's answer travel inside the room's MLS-encrypted
// chat (`file_offer` / `file_accept`); only the bytes come this way:
//
//   sender   file_offer_create(path, room) → { offerId, addr (our onion), … }
//            → file_offer{…} to the recipient, inside MLS
//   receiver file_prepare(offerId) → commitment = BLAKE3(secret)
//            → file_accept{offerId, commitment}, inside MLS
//   sender   file_authorize(offerId, commitment)
//   receiver file_download(addr, offerId, dest): dial the onion with
//            Hello{kind:"file"}, send {offer_id, secret}; the sender checks
//            BLAKE3(secret) against the commitment, answers {size, hash}, and
//            streams the bytes; the receiver checks the hash before keeping
//            the file.
//
// The secret is minted by the receiver and never leaves it until the onion
// stream (end-to-end encrypted by Tor) is up, so only the member who accepted
// can download, once. No IP address is involved on either side.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use chacha20poly1305::aead::rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::mesh::{self, MeshState};
use crate::{active_config, load_profile_state, AppConfigState};

pub(crate) const OFFLINE_BLOCKED: &str = "Offline — all network connections are blocked.";

/// How often progress is reported at most.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// The user's "file chunk size" setting in bytes, read per transfer.
pub(crate) fn file_chunk_bytes(app: &AppHandle) -> usize {
    use crate::build_config::settings as s;
    let kib = crate::vault::kv_get_raw(app, "p2p:settings", "default", "file_chunk_kib")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(s::FILE_CHUNK_MIN_KIB, s::FILE_CHUNK_MAX_KIB))
        .unwrap_or(s::FILE_CHUNK_DEFAULT_KIB);
    (kib as usize) * 1024
}

fn check_offline(app: &AppHandle, config: &State<'_, AppConfigState>) -> Result<(), String> {
    match active_config(config) {
        Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg)) => Err(OFFLINE_BLOCKED.to_string()),
        _ => Ok(()),
    }
}

// ── state ─────────────────────────────────────────────────────────────────────

struct Offer {
    path: std::path::PathBuf,
    size: u64,
    /// BLAKE3 of the receiver's secret, once it accepted.
    authorized: Option<[u8; 32]>,
}

#[derive(Default)]
pub struct FileState {
    offers: Mutex<HashMap<String, Offer>>,
    /// Receiver side: offer id → the secret `file_prepare` minted.
    prepared: Mutex<HashMap<String, [u8; 32]>>,
}

static ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// True while bytes move in either direction. The lock watchdog (vault.rs)
/// reads it so it does not cut a running transfer.
pub fn transfers_active() -> bool {
    ACTIVE.load(Ordering::Relaxed) > 0
}

struct Active;
impl Active {
    fn start() -> Self {
        ACTIVE.fetch_add(1, Ordering::Relaxed);
        Active
    }
}
impl Drop for Active {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

pub async fn shutdown(state: &FileState) {
    state.offers.lock().await.clear();
    state.prepared.lock().await.clear();
}

// ── wire ──────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Request {
    offer_id: String,
    /// Hex.
    secret: String,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    ok: bool,
    #[serde(default)]
    code: String,
    #[serde(default)]
    size: u64,
    /// Hex BLAKE3 of the whole file.
    #[serde(default)]
    hash: String,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn hash_file(path: &std::path::Path) -> Result<blake3::Hash> {
    let mut h = blake3::Hasher::new();
    h.update_reader(std::fs::File::open(path)?)?;
    Ok(h.finalize())
}

// ── events ────────────────────────────────────────────────────────────────────

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

// ── sender ────────────────────────────────────────────────────────────────────

/// Serve one download on an accepted onion stream (`mesh` routes
/// `Hello{kind:"file"}` here).
pub async fn serve<W, R>(app: &AppHandle, write: &mut W, read: &mut R) -> Result<()>
where
    W: AsyncWrite + Unpin + Send,
    R: AsyncRead + Unpin + Send,
{
    let req: Request = serde_json::from_str(&mesh::read_frame(read).await?)?;
    let state = app.state::<FileState>();
    // Take the authorization: one accepted member, one download.
    let found = {
        let mut offers = state.offers.lock().await;
        match (offers.get_mut(&req.offer_id), unhex32(&req.secret)) {
            (Some(offer), Some(secret)) if offer.authorized == Some(*blake3::hash(&secret).as_bytes()) => {
                offer.authorized = None;
                Some((offer.path.clone(), offer.size))
            }
            _ => None,
        }
    };
    let Some((path, size)) = found else {
        let refused = Answer { ok: false, code: "FILE_REFUSED".into(), size: 0, hash: String::new() };
        mesh::write_frame(write, &serde_json::to_string(&refused)?).await?;
        return Err(anyhow!("refused a download of {}", req.offer_id));
    };
    let _active = Active::start();
    let hash = tokio::task::spawn_blocking({
        let p = path.clone();
        move || hash_file(&p)
    })
    .await??;
    let answer = Answer { ok: true, code: String::new(), size, hash: hash.to_hex().to_string() };
    mesh::write_frame(write, &serde_json::to_string(&answer)?).await?;

    let mut file = tokio::fs::File::open(&path).await?;
    let mut buf = vec![0u8; file_chunk_bytes(app).max(4096)];
    let (mut sent, mut last) = (0u64, Instant::now());
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        write.write_all(&buf[..n]).await?;
        sent += n as u64;
        if last.elapsed() >= PROGRESS_EVERY {
            emit_progress(app, &req.offer_id, "send", sent, size);
            last = Instant::now();
        }
    }
    write.flush().await?;
    if sent != size {
        return Err(anyhow!("the file changed while it was being sent"));
    }
    emit_progress(app, &req.offer_id, "send", sent, size);
    emit_done(app, &req.offer_id, "send");
    state.offers.lock().await.remove(&req.offer_id);
    Ok(())
}

// ── receiver ──────────────────────────────────────────────────────────────────

async fn download(
    app: &AppHandle,
    mesh_state: &MeshState,
    addr: &str,
    offer_id: &str,
    secret: [u8; 32],
    dest: &std::path::Path,
) -> Result<()> {
    let (mut rd, mut wr) = mesh::dial_kind(app, mesh_state, addr, "file").await?;
    let req = Request { offer_id: offer_id.to_string(), secret: hex(&secret) };
    mesh::write_frame(&mut wr, &serde_json::to_string(&req)?).await?;
    let answer: Answer = serde_json::from_str(&mesh::read_frame(&mut rd).await?)?;
    if !answer.ok {
        return Err(anyhow!("{}", if answer.code.is_empty() { "FILE_REFUSED" } else { &answer.code }));
    }
    let expected = unhex32(&answer.hash).ok_or_else(|| anyhow!("bad hash"))?;
    let _active = Active::start();
    let part = dest.with_extension("part");
    let mut out = tokio::fs::File::create(&part).await?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut got, mut last) = (0u64, Instant::now());
    while got < answer.size {
        let want = buf.len().min((answer.size - got) as usize);
        let n = rd.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n]).await?;
        got += n as u64;
        if last.elapsed() >= PROGRESS_EVERY {
            emit_progress(app, offer_id, "recv", got, answer.size);
            last = Instant::now();
        }
    }
    out.flush().await?;
    drop(out);
    if got != answer.size || hasher.finalize().as_bytes() != &expected {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(anyhow!("FILE_CORRUPT: the file did not arrive whole"));
    }
    tokio::fs::rename(&part, dest).await?;
    emit_progress(app, offer_id, "recv", got, answer.size);
    emit_done(app, offer_id, "recv");
    Ok(())
}

// ── commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct OfferCreated {
    offer_id: String,
    addr: String,
    name: String,
    size: u64,
    mime: String,
}

fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "ogg" | "opus" => "audio/ogg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// Sender: offer a local file to the room, served on our onion for it.
#[tauri::command]
pub async fn file_offer_create(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    mesh_state: State<'_, MeshState>,
    state: State<'_, FileState>,
    path: String,
    room: String,
) -> Result<OfferCreated, String> {
    check_offline(&app, &config)?;
    let addr = mesh::room_onion(&mesh_state, &room).await.ok_or("FILE_NO_ROOM: open the room first")?;
    let path = std::path::PathBuf::from(path);
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let mut id = [0u8; 16];
    OsRng.fill_bytes(&mut id);
    let offer_id = hex(&id);
    state
        .offers
        .lock()
        .await
        .insert(offer_id.clone(), Offer { path, size: meta.len(), authorized: None });
    Ok(OfferCreated { offer_id, addr, mime: mime_of(&name).to_string(), name, size: meta.len() })
}

/// Sender: forget an offer (declined, cancelled, finished).
#[tauri::command]
pub async fn file_offer_cancel(state: State<'_, FileState>, offer_id: String) -> Result<(), String> {
    state.offers.lock().await.remove(&offer_id);
    Ok(())
}

/// Receiver: mint the secret for an offer and return its commitment, which
/// goes back to the sender inside MLS.
#[tauri::command]
pub async fn file_prepare(state: State<'_, FileState>, offer_id: String) -> Result<String, String> {
    let mut secret = [0u8; 32];
    OsRng.fill_bytes(&mut secret);
    state.prepared.lock().await.insert(offer_id, secret);
    Ok(blake3::hash(&secret).to_hex().to_string())
}

/// Sender: the one commitment this offer accepts.
#[tauri::command]
pub async fn file_authorize(state: State<'_, FileState>, offer_id: String, kp_hash: String) -> Result<(), String> {
    let commitment = unhex32(&kp_hash).ok_or("invalid commitment")?;
    let mut offers = state.offers.lock().await;
    let offer = offers.get_mut(&offer_id).ok_or("unknown offer")?;
    offer.authorized = Some(commitment);
    Ok(())
}

/// Receiver: fetch the file into `dest`. Returns once the download has
/// started; progress and the outcome arrive as `file://` events.
#[tauri::command]
pub async fn file_download(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    state: State<'_, FileState>,
    addr: String,
    offer_id: String,
    dest: String,
) -> Result<(), String> {
    check_offline(&app, &config)?;
    let secret = state.prepared.lock().await.remove(&offer_id).ok_or("call file_prepare before downloading")?;
    tauri::async_runtime::spawn(async move {
        let mesh_state = app.state::<MeshState>();
        if let Err(e) = download(&app, &mesh_state, &addr, &offer_id, secret, std::path::Path::new(&dest)).await {
            emit_error(&app, &offer_id, &e.to_string());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips() {
        let b = [7u8; 32];
        assert_eq!(unhex32(&hex(&b)), Some(b));
        assert_eq!(unhex32("zz"), None);
    }

    #[test]
    fn the_largest_chunk_fits_one_frame() {
        use crate::build_config::settings as s;
        assert!((s::FILE_CHUNK_MAX_KIB as usize) * 1024 <= crate::build_config::network::MAX_FRAME_BYTES);
    }

    #[test]
    fn common_types_get_a_mime() {
        assert_eq!(mime_of("a.PNG"), "image/png");
        assert_eq!(mime_of("noext"), "application/octet-stream");
    }
}
