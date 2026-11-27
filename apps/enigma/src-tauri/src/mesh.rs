// Enigma27's only transport: a mesh of Tor onion services.
//
// Every member of a room hosts its own onion service for that room and keeps
// one link to every other member it knows. A message goes straight down each
// link; nobody forwards anyone else's traffic, so no member sees the room's
// whole traffic and there is no captain to elect or to lose. A room of N
// members has at most N(N-1)/2 links, which is fine for the small rooms
// Enigma is for.
//
// Who knows whom: a joiner starts with one onion, the inviter's (from the
// invitation). Once in the MLS group, every member announces its onion inside
// the encrypted presence message, and the frontend hands the full list to
// `set_peers`. Rust then keeps a link to each: it dials every wanted peer it
// has no link to, with backoff, for as long as the room is open. Both ends
// may dial at once; when two links to the same peer exist, both ends keep the
// one dialled by the smaller onion address, so they agree without talking.
//
// While a wanted peer has no link, frames for it wait in a small outbox and
// go out when the link comes up, so a message written while someone's onion
// is still being published is not lost.
//
// The onion also carries two other kinds of stream (`Hello.kind`): an
// invitation redemption (`invite_redeem`) and a file download (`files`).
//
// arti: one client per profile, built with vanguards (full for the onions we
// host). Its state directory (keystore, guards, vanguard sets) is kept across
// restarts: sealed into the encrypted store on shutdown, plaintext on disk
// only while the app runs. So a room's onion address is stable, and so are
// the guards, which is what vanguards need. The directory cache is not secret
// and stays on disk, which keeps the next bootstrap short.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use arti_client::config::TorClientConfigBuilder;
use arti_client::{DataStream, TorClient};
use futures_lite::StreamExt;
use safelog::DisplayRedacted;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{oneshot, Mutex, Notify};
use tor_cell::relaycell::msg::Connected;
use tor_guardmgr::VanguardMode;
use tor_hsservice::config::OnionServiceConfigBuilder;
use tor_hsservice::{handle_rend_requests, HsNickname, RendRequest, RunningOnionService};
use tor_rtcompat::PreferredRuntime;

/// The virtual port every onion listens on. Rides inside each invitation.
pub const ONION_PORT: u16 = crate::build_config::network::ONION_PORT;
/// Caps one frame. Members of a room must agree.
const MAX_FRAME: usize = crate::build_config::network::MAX_FRAME_BYTES;
/// One stalled circuit must not hold up a send to everyone else.
const WRITE_TIMEOUT: Duration = Duration::from_secs(crate::build_config::network::TOR_WRITE_TIMEOUT_SECS);
/// A silent peer must not hang a dial.
const HANDSHAKE_TIMEOUT: Duration =
    Duration::from_secs(crate::build_config::network::TOR_HANDSHAKE_TIMEOUT_SECS);
/// Frames kept per unreachable peer; the oldest go first beyond this.
const OUTBOX_CAP: usize = 256;

/// Redial backoff: 5 s, 10 s, 20 s, … capped at two minutes. A freshly
/// published onion takes 30–90 s to become reachable, so the first few tries
/// are expected to fail.
fn redial_backoff(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(5);
    Duration::from_secs((5u64 << shift).min(120))
}

static NEXT_LINK: AtomicU64 = AtomicU64::new(1);

// ── Tor's own state, for the indicator in the app bar ─────────────────────────

/// `off`, `starting`, `on` or `error`.
static TOR_STATE: std::sync::Mutex<&'static str> = std::sync::Mutex::new("off");

fn set_tor_state(app: &AppHandle, state: &'static str) {
    if let Ok(mut g) = TOR_STATE.lock() {
        *g = state;
    }
    let _ = app.emit("tor://status", serde_json::json!({ "state": state }));
}

/// Whether Tor is running on this device right now.
#[tauri::command]
pub fn tor_status() -> String {
    TOR_STATE.lock().map(|g| g.to_string()).unwrap_or_else(|_| "off".into())
}

// ── state ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct MeshState(pub Mutex<Option<Node>>);

pub struct Node {
    client: Arc<TorClient<PreferredRuntime>>,
    rooms: HashMap<String, Arc<Room>>,
    /// arti's state directory: plaintext only while the node runs.
    state_dir: std::path::PathBuf,
    /// The join modal's Cancel fires this to abort a hanging join.
    join_cancel: Option<oneshot::Sender<()>>,
}

type Writer = Arc<Mutex<WriteHalf<DataStream>>>;

struct Link {
    seq: u64,
    /// The onion of whoever dialled this link (us or the peer).
    dialed_by: String,
    write: Writer,
    reader: JoinHandle<()>,
}

struct Room {
    app: AppHandle,
    slug: String,
    name: String,
    my_onion: String,
    client: Arc<TorClient<PreferredRuntime>>,
    // Dropping the service stops serving and publishing the descriptor.
    _service: Arc<RunningOnionService>,
    accept_task: std::sync::Mutex<Option<JoinHandle<()>>>,
    /// Peer onion → its live link.
    links: Mutex<HashMap<String, Link>>,
    /// Peer onion → the task keeping a link to it.
    wanted: Mutex<HashMap<String, JoinHandle<()>>>,
    /// Peer onion → frames waiting for its link.
    outbox: Mutex<HashMap<String, VecDeque<String>>>,
    /// Woken whenever a link comes or goes.
    changed: Notify,
    /// When a real frame last went out (unix seconds), for cover traffic (7.4).
    last_sent: std::sync::atomic::AtomicU64,
    cover_task: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl Room {
    /// The onions of the members linked right now.
    async fn linked(&self) -> Vec<String> {
        let mut v: Vec<String> = self.links.lock().await.keys().cloned().collect();
        v.sort();
        v
    }

    async fn has_link(&self, peer: &str) -> bool {
        self.links.lock().await.contains_key(peer)
    }

    /// Keep a new link to `peer`, or drop it if a better one is already up.
    async fn add_link(self: &Arc<Self>, peer: String, dialed_by: String, rd: ReadHalf<DataStream>, wr: WriteHalf<DataStream>) {
        let preferred = std::cmp::min(self.my_onion.as_str(), peer.as_str()).to_string();
        let seq = NEXT_LINK.fetch_add(1, Ordering::Relaxed);
        let write: Writer = Arc::new(Mutex::new(wr));
        {
            let mut links = self.links.lock().await;
            if let Some(existing) = links.get(&peer) {
                // Both ends keep the link the smaller onion dialled. Any other
                // newcomer replaces the old link, which is then most likely dead
                // (the peer redialled before we noticed it drop).
                if existing.dialed_by == preferred && dialed_by != preferred {
                    return;
                }
                if let Some(old) = links.remove(&peer) {
                    old.reader.abort();
                }
            }
            let reader = spawn_reader(self.clone(), peer.clone(), seq, rd);
            links.insert(peer.clone(), Link { seq, dialed_by, write: write.clone(), reader });
        }
        self.changed.notify_waiters();
        // Whatever waited for this peer goes now, in order.
        let queued = self.outbox.lock().await.remove(&peer).unwrap_or_default();
        for frame in queued {
            if write_frame_bounded(&mut *write.lock().await, &frame).await.is_err() {
                self.drop_link(&peer, seq).await;
                break;
            }
        }
        emit_status(&self.app, &self.slug, &self.linked().await, Some(peer));
    }

    async fn drop_link(&self, peer: &str, seq: u64) {
        let removed = {
            let mut links = self.links.lock().await;
            match links.get(peer) {
                Some(l) if l.seq == seq => links.remove(peer),
                _ => None,
            }
        };
        if let Some(l) = removed {
            l.reader.abort();
            self.changed.notify_waiters();
            emit_status(&self.app, &self.slug, &self.linked().await, Some(peer.to_string()));
        }
    }

    async fn queue(&self, peer: &str, frame: &str) {
        let mut outbox = self.outbox.lock().await;
        let q = outbox.entry(peer.to_string()).or_default();
        if q.len() >= OUTBOX_CAP {
            q.pop_front();
        }
        q.push_back(frame.to_string());
    }

    fn stop(&self) {
        if let Some(t) = self.accept_task.lock().ok().and_then(|mut g| g.take()) {
            t.abort();
        }
        if let Some(t) = self.cover_task.lock().ok().and_then(|mut g| g.take()) {
            t.abort();
        }
    }

    async fn stop_all(&self) {
        self.stop();
        for (_, t) in self.wanted.lock().await.drain() {
            t.abort();
        }
        for (_, l) in self.links.lock().await.drain() {
            l.reader.abort();
        }
    }
}

// ── names and paths ───────────────────────────────────────────────────────────

/// Room slug: deterministic from the name, so every member agrees (and the MLS
/// session key `profile:room:identity` matches).
pub fn room_for(name: &str) -> String {
    blake3::hash(name.as_bytes()).to_hex().to_string()
}

/// The onion service's nickname for a room: stable, so the keystore hands back
/// the same key and so the same `.onion` every launch.
fn nickname_for(name: &str) -> Result<HsNickname> {
    let hex = blake3::hash(name.as_bytes()).to_hex();
    HsNickname::new(format!("enigma_{}", &hex.as_str()[..16])).map_err(|e| anyhow!("invalid hs nickname: {e}"))
}

fn profile_name(app: &AppHandle) -> String {
    app.try_state::<crate::AppConfigState>()
        .and_then(|s| s.lock().ok().map(|c| c.profile.clone()))
        .unwrap_or_else(|| "default".to_string())
}

/// `app_data_dir/profiles/<profile>/tor`: per profile, and inside the folder
/// the panic code erases.
fn tor_base(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("profiles")
        .join(crate::safe_filename_component(&profile_name(app)))
        .join("tor")
}

/// This device's presence id in handshakes, kept per profile in the vault.
fn load_or_create_peer_id(app: &AppHandle) -> Result<String> {
    if let Ok(Some(bytes)) = crate::vault::get(app, "keys", "tor_peer_id") {
        if let Ok(s) = String::from_utf8(bytes) {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return Ok(s);
            }
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    crate::vault::put(app, "keys", "tor_peer_id", id.as_bytes()).map_err(|e| anyhow!("persist peer id: {e}"))?;
    Ok(id)
}

// ── framing: a 4-byte little-endian length, then the body ────────────────────

fn frame_bytes(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<()> {
    w.write_all(&frame_bytes(payload.as_bytes())).await?;
    w.flush().await?;
    Ok(())
}

async fn write_frame_bounded<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<()> {
    match tokio::time::timeout(WRITE_TIMEOUT, write_frame(w, payload)).await {
        Ok(r) => r,
        Err(_) => Err(anyhow!("write timed out")),
    }
}

pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<String> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let n = u32::from_le_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(anyhow!("frame too large: {n} bytes"));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).await?;
    Ok(String::from_utf8(body)?)
}

// ── handshake ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub(crate) struct Hello {
    /// Display name (rooms only).
    #[serde(default)]
    pub name: String,
    pub peer_id: String,
    /// `"room"` (or absent), `"redeem"` or `"file"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The dialler's own onion for this room, so the link can be told apart
    /// from the dialler's other links. Rooms only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub onion: String,
    /// Rooms: the dialler's device id (its MLS identity), the time, and its
    /// signature over `link_message(listener, onion, ts)`. The listener links
    /// only a current member of the room's group.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub ts: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sig: String,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

/// What a room link's Hello is signed over.
pub(crate) fn link_message(listener: &str, dialler: &str, ts: u64) -> Vec<u8> {
    format!("enigma27-link\0{listener}\0{dialler}\0{ts}").into_bytes()
}

/// How far a link's signed time may be from ours (clocks drift; Tor is slow).
const LINK_SKEW_SECS: u64 = 15 * 60;

/// Whether a room Hello comes from a current member: a good signature by its
/// device key over this link, recent, and the device in the room's MLS group.
fn link_is_genuine(app: &AppHandle, slug: &str, my_onion: &str, hello: &Hello) -> bool {
    if hello.device.is_empty() || now_secs().abs_diff(hello.ts) > LINK_SKEW_SECS {
        return false;
    }
    let Some(sig) = hex::decode(&hello.sig).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()) else { return false };
    if !crate::device::verify(&hello.device, &link_message(my_onion, &hello.onion, hello.ts), &sig) {
        return false;
    }
    crate::is_room_member(app, slug, &hello.device)
}

#[derive(Serialize, Deserialize)]
struct Ready {
    ok: bool,
}

/// Dial `onion` and say hello. Returns the stream halves after `Ready`.
pub(crate) async fn dial(
    client: &Arc<TorClient<PreferredRuntime>>,
    onion: &str,
    hello: &Hello,
) -> Result<(ReadHalf<DataStream>, WriteHalf<DataStream>)> {
    let ds = client.connect((onion, ONION_PORT)).await.map_err(|e| anyhow!("tor connect to {onion} failed: {e}"))?;
    let (mut rd, mut wr) = tokio::io::split(ds);
    write_frame_bounded(&mut wr, &serde_json::to_string(hello)?).await?;
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut rd)).await {
        Ok(r) => {
            let text = r.map_err(|e| anyhow!("handshake failed: {e}"))?;
            if serde_json::from_str::<Ready>(&text).map(|r| !r.ok).unwrap_or(false) {
                return Err(anyhow!("{onion} refused the link (not a member there yet)"));
            }
        }
        Err(_) => return Err(anyhow!("handshake timed out")),
    }
    Ok((rd, wr))
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

fn arti_config(state_dir: &std::path::Path, cache_dir: &std::path::Path) -> Result<arti_client::TorClientConfig> {
    // arti's TLS needs a process-wide rustls provider; without one the first
    // bootstrap panics. Installing twice is harmless (the second is refused).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut b = TorClientConfigBuilder::from_directories(state_dir, cache_dir);
    // arti refuses a state dir that is group/other-writable; a permissive umask or
    // home would fail bootstrap. The keystore is sealed in the vault at rest, so
    // the permission check adds little here (technology.md, Tor).
    b.storage().permissions().dangerously_trust_everyone();
    // Full vanguards: every member hosts an onion, and a hosted onion is what
    // guard-discovery attacks go after. arti 0.43 does not yet choose full mode
    // for onion services by itself.
    b.vanguards().mode(tor_config::ExplicitOrAuto::Explicit(VanguardMode::Full));
    b.build().map_err(|e| anyhow!("tor config: {e}"))
}

/// Start arti if it is not running. Bootstrapping takes from a few seconds
/// (warm cache) to a minute (cold), so the app calls this right after unlock.
pub async fn ensure_started(app: &AppHandle, state: &MeshState) -> Result<()> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let base = tor_base(app);
    let cache_dir = base.join("cache");
    let state_dir = base.join("state");
    std::fs::create_dir_all(&cache_dir)?;
    std::fs::create_dir_all(&state_dir)?;
    // Bring back the sealed state (keystore, guards, vanguards) from the vault.
    if is_dir_empty(&state_dir) {
        if let Ok(Some(archive)) = crate::vault::get(app, "keys", "tor_keystore") {
            let _ = extract_archive(&state_dir, &archive);
        }
    }
    clear_lockfiles(&state_dir);
    set_tor_state(app, "starting");
    let client = match TorClient::create_bootstrapped(arti_config(&state_dir, &cache_dir)?).await {
        Ok(c) => c,
        Err(e) => {
            set_tor_state(app, "error");
            return Err(anyhow!("tor bootstrap failed: {e}"));
        }
    };
    *guard = Some(Node { client, rooms: HashMap::new(), state_dir, join_cancel: None });
    set_tor_state(app, "on");
    Ok(())
}

/// Start Tor in the background, ignoring errors (the first room action
/// reports them). Called after unlock so a room opens without waiting for it;
/// skipped in airplane mode.
pub fn warm_up(app: &AppHandle) {
    let offline = app
        .try_state::<crate::AppConfigState>()
        .and_then(|s| s.lock().ok().map(|c| c.clone()))
        .is_some_and(|cfg| crate::is_offline(&crate::load_profile_state(app, &cfg)));
    if offline {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<MeshState>();
        if let Err(e) = ensure_started(&app, &state).await {
            eprintln!("[mesh] tor warm-up failed: {e}");
        }
    });
}

pub(crate) async fn client_of(state: &MeshState) -> Result<Arc<TorClient<PreferredRuntime>>> {
    let guard = state.0.lock().await;
    Ok(guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?.client.clone())
}

async fn room_of(state: &MeshState, slug: &str) -> Option<Arc<Room>> {
    state.0.lock().await.as_ref()?.rooms.get(slug).cloned()
}

/// Seal arti's state into the vault, then remove the plaintext copy. If the
/// seal fails (the vault is locked), the plaintext stays rather than losing
/// the room's onion keys.
fn seal_and_wipe(app: &AppHandle, state_dir: &std::path::Path) {
    let sealed = archive_dir(state_dir)
        .ok()
        .map(|a| crate::vault::put(app, "keys", "tor_keystore", &a).is_ok())
        .unwrap_or(false);
    if sealed {
        let _ = std::fs::remove_dir_all(state_dir);
    }
}

/// Tear everything down: every room, every link, arti itself (lock, profile
/// switch, airplane mode, quit).
pub async fn shutdown(app: &AppHandle, state: &MeshState) {
    let node = state.0.lock().await.take();
    if let Some(node) = node {
        for (slug, room) in &node.rooms {
            room.stop_all().await;
            emit_closed(app, slug);
        }
        let state_dir = node.state_dir.clone();
        drop(node); // arti lets go of the keystore
        seal_and_wipe(app, &state_dir);
        set_tor_state(app, "off");
    }
}

/// Forget every onion identity (Settings, "Clear selected data"): the next
/// room launch mints fresh addresses.
pub async fn clean_keystore(app: &AppHandle, state: &MeshState) {
    let node = state.0.lock().await.take();
    if let Some(node) = node {
        for (slug, room) in &node.rooms {
            room.stop_all().await;
            emit_closed(app, slug);
        }
        let state_dir = node.state_dir.clone();
        drop(node);
        let _ = std::fs::remove_dir_all(&state_dir);
        set_tor_state(app, "off");
    }
    let _ = crate::vault::delete(app, "keys", "tor_keystore");
}

// ── rooms ─────────────────────────────────────────────────────────────────────

/// This device's onion for an open room, if any.
pub async fn room_onion(state: &MeshState, slug: &str) -> Option<String> {
    Some(room_of(state, slug).await?.my_onion.clone())
}

/// Host a room: launch our onion for it and accept members' links. Returns
/// `(slug, my_onion)`. Idempotent.
pub async fn open_room(app: &AppHandle, state: &MeshState, name: String) -> Result<(String, String)> {
    ensure_started(app, state).await?;
    let slug = room_for(&name);
    if let Some(room) = room_of(state, &slug).await {
        return Ok((slug, room.my_onion.clone()));
    }
    let client = client_of(state).await?;
    let svc_cfg = OnionServiceConfigBuilder::default()
        .nickname(nickname_for(&name)?)
        .build()
        .map_err(|e| anyhow!("onion service config: {e}"))?;
    let (service, rend) = client
        .launch_onion_service(svc_cfg)
        .map_err(|e| anyhow!("launch onion service: {e}"))?
        .ok_or_else(|| anyhow!("onion service disabled in config"))?;
    let my_onion = wait_onion_address(&service).await?;
    let room = Arc::new(Room {
        app: app.clone(),
        slug: slug.clone(),
        name: name.clone(),
        my_onion: my_onion.clone(),
        client,
        _service: service,
        accept_task: std::sync::Mutex::new(None),
        links: Mutex::new(HashMap::new()),
        wanted: Mutex::new(HashMap::new()),
        outbox: Mutex::new(HashMap::new()),
        changed: Notify::new(),
        last_sent: std::sync::atomic::AtomicU64::new(now_secs()),
        cover_task: std::sync::Mutex::new(None),
    });
    {
        let mut guard = state.0.lock().await;
        let node = guard.as_mut().ok_or_else(|| anyhow!("tor not started"))?;
        if let Some(existing) = node.rooms.get(&slug) {
            // A concurrent open won the race; ours is dropped with `room`.
            return Ok((slug, existing.my_onion.clone()));
        }
        node.rooms.insert(slug.clone(), room.clone());
    }
    let task = spawn_accept_loop(room.clone(), rend);
    if let Ok(mut g) = room.accept_task.lock() {
        *g = Some(task);
    }
    let cover = spawn_cover(Arc::downgrade(&room));
    if let Ok(mut g) = room.cover_task.lock() {
        *g = Some(cover);
    }
    emit_status(app, &slug, &[], None);
    Ok((slug, my_onion))
}

/// The members this device should keep a link to. Replaces the previous list:
/// links to peers no longer listed are left to close on their own, dialling
/// stops for them, and their outbox is dropped.
pub async fn set_peers(app: &AppHandle, state: &MeshState, slug: &str, onions: Vec<String>) -> Result<()> {
    let room = room_of(state, slug).await.ok_or_else(|| anyhow!("no such room"))?;
    let my_id = load_or_create_peer_id(app)?;
    let mut wanted = room.wanted.lock().await;
    let next: std::collections::HashSet<String> =
        onions.into_iter().map(|o| o.trim().to_string()).filter(|o| !o.is_empty() && *o != room.my_onion).collect();
    let gone: Vec<String> = wanted.keys().filter(|k| !next.contains(*k)).cloned().collect();
    for peer in gone {
        if let Some(t) = wanted.remove(&peer) {
            t.abort();
        }
        room.outbox.lock().await.remove(&peer);
    }
    for peer in next {
        if !wanted.contains_key(&peer) {
            let task = spawn_dialer(room.clone(), peer.clone(), my_id.clone());
            wanted.insert(peer, task);
        }
    }
    Ok(())
}

/// Open a room and link to the given members: reopening a saved room, or
/// entering one after an invitation was redeemed.
pub async fn join_room(app: &AppHandle, state: &MeshState, name: String, peers: Vec<String>) -> Result<(String, String)> {
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = state.0.lock().await;
        if let Some(node) = guard.as_mut() {
            node.join_cancel = Some(tx);
        }
    }
    let work = async {
        let (slug, onion) = open_room(app, state, name).await?;
        set_peers(app, state, &slug, peers).await?;
        Ok::<_, anyhow::Error>((slug, onion))
    };
    tokio::select! {
        r = work => r,
        _ = rx => Err(anyhow!("JOIN_CANCELLED")),
    }
}

/// The join modal's Cancel.
pub async fn cancel_join(state: &MeshState) {
    let tx = state.0.lock().await.as_mut().and_then(|n| n.join_cancel.take());
    if let Some(tx) = tx {
        let _ = tx.send(());
    }
}

/// Send one frame to every member: down every live link, and into the outbox
/// of every wanted member without one.
pub async fn broadcast(state: &MeshState, slug: &str, payload: String) -> Result<()> {
    let payload = pad(payload);
    let room = room_of(state, slug).await.ok_or_else(|| anyhow!("no such room"))?;
    room.last_sent.store(now_secs(), std::sync::atomic::Ordering::Relaxed);
    let targets: Vec<(String, u64, Writer)> =
        room.links.lock().await.iter().map(|(p, l)| (p.clone(), l.seq, l.write.clone())).collect();
    let linked: std::collections::HashSet<String> = targets.iter().map(|t| t.0.clone()).collect();
    for (peer, seq, w) in targets {
        let ok = write_frame_bounded(&mut *w.lock().await, &payload).await.is_ok();
        if !ok {
            room.drop_link(&peer, seq).await;
            room.queue(&peer, &payload).await;
        }
    }
    let unlinked: Vec<String> = room.wanted.lock().await.keys().filter(|p| !linked.contains(*p)).cloned().collect();
    for peer in unlinked {
        room.queue(&peer, &payload).await;
    }
    Ok(())
}

/// Close a room on this device: stop serving its onion and drop its links.
pub async fn leave_room(state: &MeshState, slug: &str) {
    let room = state.0.lock().await.as_mut().and_then(|n| n.rooms.remove(slug));
    if let Some(room) = room {
        room.stop_all().await;
    }
}

/// Destroy a room's onion identity ("delete room"): a future room of the same
/// name mints a fresh `.onion`.
pub async fn forget_onion(app: &AppHandle, state: &MeshState, name: String) -> Result<()> {
    let slug = room_for(&name);
    leave_room(state, &slug).await;
    let nick = nickname_for(&name)?.to_string();
    let running = state.0.lock().await.as_ref().map(|n| n.state_dir.clone());
    match running {
        Some(dir) => remove_nickname_from_keystore(&dir, &nick),
        None => {
            // Not running: edit the sealed copy.
            if let Ok(Some(archive)) = crate::vault::get(app, "keys", "tor_keystore") {
                let tmp = std::env::temp_dir().join(format!("enigma-tor-forget-{}", uuid::Uuid::new_v4().simple()));
                let _ = std::fs::create_dir_all(&tmp);
                if extract_archive(&tmp, &archive).is_ok() {
                    remove_nickname_from_keystore(&tmp, &nick);
                    if let Ok(re) = archive_dir(&tmp) {
                        let _ = crate::vault::put(app, "keys", "tor_keystore", &re);
                    }
                }
                let _ = std::fs::remove_dir_all(&tmp);
            }
        }
    }
    Ok(())
}

/// Dial an onion for an invitation redemption or a file download: same
/// onion, same port, a different `kind`.
pub(crate) async fn dial_kind(
    app: &AppHandle,
    state: &MeshState,
    onion: &str,
    kind: &str,
) -> Result<(ReadHalf<DataStream>, WriteHalf<DataStream>)> {
    ensure_started(app, state).await?;
    let client = client_of(state).await?;
    let hello = Hello {
        name: String::new(),
        peer_id: load_or_create_peer_id(app)?,
        kind: Some(kind.to_string()),
        onion: String::new(),
        device: String::new(),
        ts: 0,
        sig: String::new(),
    };
    dial(&client, onion, &hello).await
}

/// Pad a frame to a fixed size so its length says little about what it carries:
/// 512 B, 2 KiB, 8 KiB, then whole multiples of 32 KiB (capped at MAX_FRAME).
/// The padding is trailing spaces, which every JSON parser ignores, so the
/// receiving side needs nothing.
pub(crate) fn padded_len(n: usize) -> usize {
    let size = match n {
        0..=512 => 512,
        513..=2048 => 2048,
        2049..=8192 => 8192,
        _ => n.div_ceil(32 * 1024) * 32 * 1024,
    };
    size.min(MAX_FRAME).max(n)
}

fn pad(mut payload: String) -> String {
    let target = padded_len(payload.len());
    payload.extend(std::iter::repeat_n(' ', target - payload.len()));
    payload
}

// ── tasks ─────────────────────────────────────────────────────────────────────

/// Keep a link to one wanted peer for as long as it is wanted.
fn spawn_dialer(room: Arc<Room>, peer: String, my_id: String) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut attempt: u32 = 0;
        loop {
            let changed = room.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if room.has_link(&peer).await {
                attempt = 0;
                changed.await;
                continue;
            }
            let ts = now_secs();
            let (device, sig) = match crate::device::load_or_create(&room.app) {
                Ok(k) => (crate::device::id_of(&k), hex::encode(crate::device::sign(&k, &link_message(&peer, &room.my_onion, ts)))),
                Err(_) => (String::new(), String::new()),
            };
            let hello = Hello {
                name: room.name.clone(),
                peer_id: my_id.clone(),
                kind: None,
                onion: room.my_onion.clone(),
                device,
                ts,
                sig,
            };
            match dial(&room.client, &peer, &hello).await {
                Ok((rd, wr)) => {
                    attempt = 0;
                    room.add_link(peer.clone(), room.my_onion.clone(), rd, wr).await;
                }
                Err(_) => {
                    attempt += 1;
                    // A link the peer dials to us also ends the wait.
                    tokio::select! {
                        _ = tokio::time::sleep(redial_backoff(attempt)) => {}
                        _ = changed => {}
                    }
                }
            }
        }
    })
}

// ── cover traffic (7.4 / 8.D1) ───────────────────────────────────────────────
// While a room is open, something goes to every linked member at a steady rate:
// a real frame if there was one in the slot, otherwise a padded dummy the reader
// drops. Someone watching a link then sees the same trickle whether or not anyone
// is typing. The interval is longer on phones, for battery and data.

const COVER: &str = r#"{"type":"cover"}"#;
#[cfg(target_os = "android")]
const COVER_EVERY: u64 = 90;
#[cfg(not(target_os = "android"))]
const COVER_EVERY: u64 = 30;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn is_cover(payload: &str) -> bool {
    payload.trim_end() == COVER
}

fn spawn_cover(room: std::sync::Weak<Room>) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            // ±20 % jitter, so the dummies are not a metronome either.
            let jitter = (chacha20poly1305::aead::rand_core::RngCore::next_u64(&mut chacha20poly1305::aead::OsRng) % (COVER_EVERY * 2 / 5 + 1)) as i64 - (COVER_EVERY / 5) as i64;
            tokio::time::sleep(Duration::from_secs((COVER_EVERY as i64 + jitter).max(1) as u64)).await;
            let Some(room) = room.upgrade() else { break };
            let quiet = now_secs().saturating_sub(room.last_sent.load(std::sync::atomic::Ordering::Relaxed));
            if quiet + 1 < COVER_EVERY {
                continue; // a real frame went out in this slot
            }
            let frame = pad(COVER.to_string());
            let targets: Vec<Writer> = room.links.lock().await.values().map(|l| l.write.clone()).collect();
            for w in targets {
                let _ = write_frame_bounded(&mut *w.lock().await, &frame).await;
            }
            room.last_sent.store(now_secs(), std::sync::atomic::Ordering::Relaxed);
        }
    })
}

/// Read one link until it closes.
fn spawn_reader(room: Arc<Room>, peer: String, seq: u64, mut rd: ReadHalf<DataStream>) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        while let Ok(payload) = read_frame(&mut rd).await {
            if is_cover(&payload) {
                continue; // cover traffic (7.4): it only has to have been sent
            }
            emit_message(&room.app, &room.slug, &payload);
        }
        // `drop_link` aborts this task, so run it from a fresh one.
        let r = room.clone();
        tauri::async_runtime::spawn(async move { r.drop_link(&peer, seq).await });
    })
}

fn spawn_accept_loop<S>(room: Arc<Room>, rend: S) -> JoinHandle<()>
where
    S: futures_lite::stream::Stream<Item = RendRequest> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut streams = Box::pin(handle_rend_requests(rend));
        while let Some(req) = streams.next().await {
            let Ok(ds) = req.accept(Connected::new_empty()).await else { continue };
            let room = room.clone();
            // Each stream's handshake runs on its own task: a slow dialler must
            // not hold up the next.
            tauri::async_runtime::spawn(async move {
                let (mut rd, mut wr) = tokio::io::split(ds);
                let hello = match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut rd)).await {
                    Ok(Ok(s)) => match serde_json::from_str::<Hello>(&s) {
                        Ok(h) => h,
                        Err(_) => return,
                    },
                    _ => return,
                };
                // A room link only from a current member (redeem and file
                // carry their own proofs). Anyone else is told no and dropped.
                let is_room = !matches!(hello.kind.as_deref(), Some("redeem") | Some("file"));
                let ok = !is_room || link_is_genuine(&room.app, &room.slug, &room.my_onion, &hello);
                if write_frame(&mut wr, &serde_json::to_string(&Ready { ok }).unwrap()).await.is_err() || !ok {
                    return;
                }
                match hello.kind.as_deref() {
                    Some("redeem") => {
                        let pending = room.app.state::<crate::invite_redeem::RedeemState>().inner().clone();
                        if let Err(e) = crate::invite_redeem::serve_tor(&room.app, &pending, &mut wr, &mut rd).await {
                            eprintln!("[redeem] serve ended: {e}");
                        }
                    }
                    Some("file") => {
                        if let Err(e) = crate::files::serve(&room.app, &mut wr, &mut rd).await {
                            eprintln!("[file] serve ended: {e}");
                        }
                    }
                    _ => {
                        // A member's link. Without its onion we could not tell it
                        // apart from its other links, so it is refused.
                        if hello.onion.is_empty() || hello.onion == room.my_onion {
                            return;
                        }
                        let peer = hello.onion.clone();
                        room.add_link(peer.clone(), peer, rd, wr).await;
                    }
                }
            });
        }
    })
}

/// The descriptor is not instant; poll the service for its address.
async fn wait_onion_address(service: &RunningOnionService) -> Result<String> {
    for _ in 0..50 {
        if let Some(id) = service.onion_address() {
            return Ok(id.display_unredacted().to_string());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(anyhow!("onion address was not ready"))
}

// ── arti's state on disk ──────────────────────────────────────────────────────

fn is_dir_empty(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir).map(|mut it| it.next().is_none()).unwrap_or(true)
}

fn is_lockfile(name: &str) -> bool {
    name.to_ascii_lowercase().contains("lock")
}

/// A lockfile left by a crash (or restored from the sealed copy) would make a
/// launch fail with "local resource … already in use".
fn clear_lockfiles(dir: &std::path::Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                clear_lockfiles(&p);
            } else if p.file_name().and_then(|n| n.to_str()).map(is_lockfile).unwrap_or(false) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

/// A directory tree as one blob (relative path + bytes), for sealing.
fn archive_dir(dir: &std::path::Path) -> Result<Vec<u8>> {
    fn walk(root: &std::path::Path, cur: &std::path::Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<()> {
        for entry in std::fs::read_dir(cur)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(root, &path, out)?;
            } else if path.file_name().and_then(|n| n.to_str()).map(is_lockfile).unwrap_or(false) {
                continue;
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push((rel.to_string_lossy().into_owned(), std::fs::read(&path)?));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    if dir.exists() {
        walk(dir, dir, &mut files)?;
    }
    Ok(postcard::to_stdvec(&files)?)
}

fn extract_archive(dir: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let files: Vec<(String, Vec<u8>)> = postcard::from_bytes(bytes)?;
    for (rel, data) in files {
        let rel = std::path::Path::new(&rel);
        if rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            continue; // never write outside `dir`
        }
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&p, &data)?;
    }
    Ok(())
}

/// arti keeps an onion's keys under `…/<nickname>/`.
fn remove_nickname_from_keystore(dir: &std::path::Path, nick: &str) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().and_then(|n| n.to_str()) == Some(nick) {
                    let _ = std::fs::remove_dir_all(&p);
                } else {
                    remove_nickname_from_keystore(&p, nick);
                }
            }
        }
    }
}

// ── events ────────────────────────────────────────────────────────────────────

fn emit_message(app: &AppHandle, room: &str, payload: &str) {
    let _ = app.emit("realtime://message", serde_json::json!({ "room": room, "payload": payload }));
}

/// `connected` while at least one member is linked, `waiting` otherwise, with
/// the linked members' onions (`linked`) and the one whose link changed
/// (`peer_id`).
/// The room is closed on this device (lock, airplane mode, profile switch).
fn emit_closed(app: &AppHandle, room: &str) {
    let _ = app.emit(
        "realtime://status",
        serde_json::json!({ "room": room, "state": "disconnected", "peers": 0, "linked": [], "peer_id": null }),
    );
}

fn emit_status(app: &AppHandle, room: &str, linked: &[String], peer: Option<String>) {
    let state = if linked.is_empty() { "waiting" } else { "connected" };
    let _ = app.emit(
        "realtime://status",
        serde_json::json!({ "room": room, "state": state, "peers": linked.len(), "linked": linked, "peer_id": peer }),
    );
}

#[cfg(test)]
#[path = "mesh_live.rs"]
mod live;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rooms_and_nicknames_are_deterministic() {
        assert_eq!(room_for("a"), room_for("a"));
        assert_ne!(room_for("a"), room_for("b"));
        assert_eq!(nickname_for("a").unwrap().to_string(), nickname_for("a").unwrap().to_string());
    }

    #[test]
    fn a_link_signature_binds_both_onions_and_the_time() {
        let k = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        let id = crate::device::id_of(&k);
        let sig = crate::device::sign(&k, &link_message("me.onion", "you.onion", 100));
        assert!(crate::device::verify(&id, &link_message("me.onion", "you.onion", 100), &sig));
        assert!(!crate::device::verify(&id, &link_message("other.onion", "you.onion", 100), &sig), "not reusable at another member");
        assert!(!crate::device::verify(&id, &link_message("me.onion", "x.onion", 100), &sig));
        assert!(!crate::device::verify(&id, &link_message("me.onion", "you.onion", 101), &sig));
    }

    #[test]
    fn cover_frames_are_padded_like_the_smallest_message_and_recognised() {
        let f = pad(COVER.to_string());
        assert_eq!(f.len(), 512);
        assert!(is_cover(&f));
        assert!(!is_cover(&pad(r#"{"type":"mls_app","ciphertext":"x"}"#.to_string())));
    }

    #[test]
    fn frames_are_padded_to_buckets_and_still_parse() {
        assert_eq!(padded_len(1), 512);
        assert_eq!(padded_len(512), 512);
        assert_eq!(padded_len(513), 2048);
        assert_eq!(padded_len(5000), 8192);
        assert_eq!(padded_len(8193), 32 * 1024);
        assert_eq!(padded_len(40_000), 64 * 1024);
        let p = pad(r#"{"type":"mls_app","ciphertext":"x"}"#.to_string());
        assert_eq!(p.len(), 512);
        let v: serde_json::Value = serde_json::from_str(&p).unwrap();
        assert_eq!(v["type"], "mls_app");
    }

    #[test]
    fn redial_backoff_grows_then_caps() {
        assert_eq!(redial_backoff(1), Duration::from_secs(5));
        assert_eq!(redial_backoff(2), Duration::from_secs(10));
        assert_eq!(redial_backoff(3), Duration::from_secs(20));
        assert_eq!(redial_backoff(20), Duration::from_secs(120));
    }

    #[test]
    fn a_room_hello_carries_the_dialler_onion() {
        let h = Hello { name: "a".into(), peer_id: "p".into(), kind: None, onion: "x.onion".into(), device: String::new(), ts: 0, sig: String::new() };
        let text = serde_json::to_string(&h).unwrap();
        assert_eq!(text, r#"{"name":"a","peer_id":"p","onion":"x.onion"}"#);
        assert_eq!(serde_json::from_str::<Hello>(&text).unwrap(), h);
    }

    #[test]
    fn a_redeem_hello_has_no_onion() {
        let h = Hello { name: String::new(), peer_id: "p".into(), kind: Some("redeem".into()), onion: String::new(), device: String::new(), ts: 0, sig: String::new() };
        assert_eq!(serde_json::to_string(&h).unwrap(), r#"{"name":"","peer_id":"p","kind":"redeem"}"#);
    }

    #[tokio::test]
    async fn a_frame_round_trips() {
        let mut buf = Vec::new();
        write_frame(&mut buf, r#"{"type":"mls_app"}"#).await.unwrap();
        buf.extend_from_slice(b"trailing");
        let got = read_frame(&mut std::io::Cursor::new(buf)).await.unwrap();
        assert_eq!(got, r#"{"type":"mls_app"}"#);
    }

    #[tokio::test]
    async fn an_oversized_frame_is_refused_before_allocating() {
        let mut buf = ((MAX_FRAME as u32) + 1).to_le_bytes().to_vec();
        buf.extend_from_slice(b"body");
        assert!(read_frame(&mut std::io::Cursor::new(buf)).await.is_err());
    }

    #[test]
    fn the_tor_config_asks_for_full_vanguards() {
        let dir = std::env::temp_dir().join(format!("enigma_vg_{}", std::process::id()));
        let cfg = arti_config(&dir, &dir).unwrap();
        let dbg = format!("{cfg:?}");
        assert!(dbg.contains("Full"), "vanguards mode missing from config: {dbg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_archive_never_writes_outside_its_dir() {
        let dir = std::env::temp_dir().join(format!("enigma_arch_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let evil = postcard::to_stdvec(&vec![("../escape".to_string(), b"x".to_vec()), ("ok/f".to_string(), b"y".to_vec())]).unwrap();
        extract_archive(&dir, &evil).unwrap();
        assert!(!dir.parent().unwrap().join("escape").exists());
        assert_eq!(std::fs::read(dir.join("ok/f")).unwrap(), b"y");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
