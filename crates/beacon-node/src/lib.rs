//! The Pharos mesh: a mesh of Tor onion services, with no UI framework in it.
//!
//! Every member of a room hosts its own onion service for that room and keeps
//! one link to every other member it knows. A message goes straight down each
//! link; nobody forwards anyone else's traffic, so no member sees the room's
//! whole traffic and there is no captain to elect or to lose. A room of N
//! members has at most N(N-1)/2 links, which is fine for small rooms.
//!
//! Who knows whom: a joiner starts with one onion, the inviter's (from the
//! invitation). Once in the MLS group, every member announces its onion inside
//! the encrypted presence message, and the embedder hands the full list to
//! [`set_peers`]. The node then keeps a link to each: it dials every wanted
//! peer it has no link to, with backoff, for as long as the room is open. Both
//! ends may dial at once; when two links to the same peer exist, both ends keep
//! the one dialled by the smaller onion address, so they agree without talking.
//!
//! While a wanted peer has no link, frames for it wait in a small outbox and
//! go out when the link comes up.
//!
//! The onion also carries other kinds of stream (`Hello.kind`, e.g. `redeem`
//! and `file`): those are handed to [`Host::serve_stream`].
//!
//! arti: one client per node, built with full vanguards. Its state directory
//! (keystore, guards, vanguard sets) is kept across restarts through
//! [`Host::load_keystore`] / [`Host::save_keystore`]: plaintext on disk only
//! while the node runs. The directory cache is not secret and stays on disk.
//!
//! Everything the embedder provides (events, the device key, room membership,
//! the sealed keystore, other stream kinds) goes through the [`Host`] trait;
//! the constants and directories through [`MeshConfig`].
//!
//! Stage b2 (apps attach to one Beacon; only Beacons mesh) lives in [`relay`]
//! (the Beacon server: client links in, the Beacon mesh, offline queues, relayed
//! redemptions), [`proto`] (hellos and ops, PROTOCOL.md Part C), [`queue`] (what a
//! Beacon keeps) and [`link`] (pluggable streams). The app mesh above stays for the
//! Tauri app until stage 5.

pub mod link;
pub mod proto;
pub mod queue;
pub mod relay;
#[cfg(feature = "sqlite")]
pub mod sqlite_queue;

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use arti_client::config::TorClientConfigBuilder;
use futures_lite::StreamExt;
use safelog::DisplayRedacted;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex, Notify};
use tokio::task::JoinHandle;
use tor_cell::relaycell::msg::Connected;
use tor_guardmgr::VanguardMode;
use tor_hsservice::{handle_rend_requests, RendRequest, RunningOnionService};

pub use arti_client::{DataStream, TorClient};
pub use tor_hsservice::config::OnionServiceConfigBuilder;
pub use tor_hsservice::HsNickname;
pub use tor_rtcompat::PreferredRuntime;

pub type ReadHalf = tokio::io::ReadHalf<DataStream>;
pub type WriteHalf = tokio::io::WriteHalf<DataStream>;
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Frames kept per unreachable peer; the oldest go first beyond this.
const OUTBOX_CAP: usize = 256;
/// How far a link's signed time may be from ours (clocks drift; Tor is slow).
const LINK_SKEW_SECS: u64 = 15 * 60;

// ── what the embedder provides ───────────────────────────────────────────────

/// The embedder: the app (Tauri), a console, or the `beacon` binary.
pub trait Host: Send + Sync + 'static {
    /// A real (non-cover) frame arrived from a member of `room`.
    fn on_frame(&self, room: &str, payload: &str);
    /// A link of `room` came or went: the linked members now, and the peer
    /// whose link changed (`None` when the room just opened).
    fn on_status(&self, room: &str, linked: &[String], peer: Option<String>);
    /// The room is closed on this device (shutdown, keystore cleaned).
    fn on_closed(&self, room: &str);
    /// Tor's own state: `off`, `starting`, `on` or `error`.
    fn on_tor_state(&self, state: &'static str);
    /// This device's id (64 hex digits of its Ed25519 public key), if it has
    /// a key. `None` dials room links unsigned (they are then refused).
    fn device_id(&self) -> Option<String>;
    /// Sign with the device key.
    fn sign(&self, msg: &[u8]) -> Option<[u8; 64]>;
    /// Whether `device` is a current member of `room`'s group.
    fn is_member(&self, room: &str, device: &str) -> bool;
    /// This device's presence id in handshakes (stable per profile).
    fn peer_id(&self) -> Result<String>;
    /// The sealed copy of arti's state directory, if any.
    fn load_keystore(&self) -> Option<Vec<u8>>;
    /// Seal arti's state directory. `false` if it could not be kept (the
    /// plaintext copy then stays on disk rather than losing onion keys).
    fn save_keystore(&self, archive: &[u8]) -> bool;
    /// Forget the sealed copy.
    fn delete_keystore(&self);
    /// Serve an inbound stream of another kind (`redeem`, `file`, ...), after
    /// its Hello was answered `Ready { ok: true }`.
    fn serve_stream(&self, kind: &str, read: ReadHalf, write: WriteHalf) -> BoxFuture<()>;
    /// Kinds `serve_stream` handles (they carry their own proofs, so they skip
    /// the room-member check). Anything else is a room link.
    fn stream_kinds(&self) -> &'static [&'static str] {
        &["redeem", "file"]
    }
}

/// The constants members of a mesh must agree on, and where arti keeps its files.
#[derive(Clone, Debug)]
pub struct MeshConfig {
    /// The virtual port every onion listens on.
    pub onion_port: u16,
    /// Caps one frame.
    pub max_frame: usize,
    /// One stalled circuit must not hold up a send to everyone else.
    pub write_timeout: Duration,
    /// A silent peer must not hang a dial.
    pub handshake_timeout: Duration,
    /// Cover traffic interval, seconds.
    pub cover_every: u64,
    /// arti's state directory (keystore, guards, vanguards).
    pub state_dir: PathBuf,
    /// arti's directory cache.
    pub cache_dir: PathBuf,
    /// Prefix of every onion's nickname (`<prefix>_<hash>`), so keys stay stable.
    pub nickname_prefix: String,
}

/// Redial backoff: 5 s, 10 s, 20 s, … capped at two minutes. A freshly
/// published onion takes 30–90 s to become reachable, so the first few tries
/// are expected to fail.
pub fn redial_backoff(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(5);
    Duration::from_secs((5u64 << shift).min(120))
}

static NEXT_LINK: AtomicU64 = AtomicU64::new(1);

// ── state ─────────────────────────────────────────────────────────────────────

/// The node, once started.
#[derive(Default)]
pub struct Mesh(Mutex<Option<Node>>);

struct Node {
    client: Arc<TorClient<PreferredRuntime>>,
    host: Arc<dyn Host>,
    rooms: HashMap<String, Arc<Room>>,
    /// arti's state directory: plaintext only while the node runs.
    state_dir: PathBuf,
    /// Fired to abort a hanging join.
    join_cancel: Option<oneshot::Sender<()>>,
}

type Writer = Arc<Mutex<WriteHalf>>;

struct Link {
    seq: u64,
    /// The onion of whoever dialled this link (us or the peer).
    dialed_by: String,
    write: Writer,
    reader: JoinHandle<()>,
}

struct Room {
    host: Arc<dyn Host>,
    cfg: Arc<MeshConfig>,
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
    /// When a real frame last went out (unix seconds), for cover traffic.
    last_sent: AtomicU64,
    cover_task: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl Room {
    async fn linked(&self) -> Vec<String> {
        let mut v: Vec<String> = self.links.lock().await.keys().cloned().collect();
        v.sort();
        v
    }

    async fn has_link(&self, peer: &str) -> bool {
        self.links.lock().await.contains_key(peer)
    }

    /// Keep a new link to `peer`, or drop it if a better one is already up.
    async fn add_link(self: &Arc<Self>, peer: String, dialed_by: String, rd: ReadHalf, wr: WriteHalf) {
        let preferred = std::cmp::min(self.my_onion.as_str(), peer.as_str()).to_string();
        let seq = NEXT_LINK.fetch_add(1, Ordering::Relaxed);
        let write: Writer = Arc::new(Mutex::new(wr));
        {
            let mut links = self.links.lock().await;
            if let Some(existing) = links.get(&peer) {
                // Both ends keep the link the smaller onion dialled. Any other
                // newcomer replaces the old link, which is then most likely dead.
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
            if write_frame_bounded(&mut *write.lock().await, &frame, self.cfg.write_timeout).await.is_err() {
                self.drop_link(&peer, seq).await;
                break;
            }
        }
        self.host.on_status(&self.slug, &self.linked().await, Some(peer));
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
            self.host.on_status(&self.slug, &self.linked().await, Some(peer.to_string()));
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

// ── names ─────────────────────────────────────────────────────────────────────

/// Room slug: deterministic from the name, so every member agrees.
pub fn room_for(name: &str) -> String {
    blake3::hash(name.as_bytes()).to_hex().to_string()
}

/// The onion service's nickname for a room: stable, so the keystore hands back
/// the same key and so the same `.onion` every launch.
pub fn nickname_for(prefix: &str, name: &str) -> Result<HsNickname> {
    let hex = blake3::hash(name.as_bytes()).to_hex();
    HsNickname::new(format!("{prefix}_{}", &hex.as_str()[..16])).map_err(|e| anyhow!("invalid hs nickname: {e}"))
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

pub async fn write_frame_bounded<W: AsyncWrite + Unpin>(w: &mut W, payload: &str, timeout: Duration) -> Result<()> {
    match tokio::time::timeout(timeout, write_frame(w, payload)).await {
        Ok(r) => r,
        Err(_) => Err(anyhow!("write timed out")),
    }
}

/// Read one frame, refusing one longer than `max_frame` before allocating.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R, max_frame: usize) -> Result<String> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let n = u32::from_le_bytes(len) as usize;
    if n > max_frame {
        return Err(anyhow!("frame too large: {n} bytes"));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).await?;
    Ok(String::from_utf8(body)?)
}

// ── handshake ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct Hello {
    /// Display name (rooms only).
    #[serde(default)]
    pub name: String,
    pub peer_id: String,
    /// `"room"` (or absent), `"redeem"` or `"file"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The dialler's own onion for this room. Rooms only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub onion: String,
    /// Rooms: the dialler's device id, the time, and its signature over
    /// `link_message(listener, onion, ts)`.
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

#[derive(Serialize, Deserialize)]
pub struct Ready {
    pub ok: bool,
}

/// What a room link's Hello is signed over.
pub fn link_message(listener: &str, dialler: &str, ts: u64) -> Vec<u8> {
    format!("enigma27-link\0{listener}\0{dialler}\0{ts}").into_bytes()
}

/// Does `sig` prove that whoever made it holds the Ed25519 key behind the
/// device id `id` (64 hex digits)?
pub fn verify_device(id: &str, msg: &[u8], sig: &[u8; 64]) -> bool {
    use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
    if id.len() != 64 {
        return false;
    }
    let Some(pk) = hex::decode(id).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    vk.verify(msg, &Signature::from_bytes(sig)).is_ok()
}

/// Whether a room Hello comes from a current member: a good signature by its
/// device key over this link, recent, and the device in the room's group.
fn link_is_genuine(host: &dyn Host, slug: &str, my_onion: &str, hello: &Hello) -> bool {
    if hello.device.is_empty() || now_secs().abs_diff(hello.ts) > LINK_SKEW_SECS {
        return false;
    }
    let Some(sig) = hex::decode(&hello.sig).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()) else { return false };
    if !verify_device(&hello.device, &link_message(my_onion, &hello.onion, hello.ts), &sig) {
        return false;
    }
    host.is_member(slug, &hello.device)
}

/// Dial `onion` and say hello. Returns the stream halves after `Ready`.
pub async fn dial(client: &Arc<TorClient<PreferredRuntime>>, cfg: &MeshConfig, onion: &str, hello: &Hello) -> Result<(ReadHalf, WriteHalf)> {
    let ds = client.connect((onion, cfg.onion_port)).await.map_err(|e| anyhow!("tor connect to {onion} failed: {e}"))?;
    let (mut rd, mut wr) = tokio::io::split(ds);
    write_frame_bounded(&mut wr, &serde_json::to_string(hello)?, cfg.write_timeout).await?;
    match tokio::time::timeout(cfg.handshake_timeout, read_frame(&mut rd, cfg.max_frame)).await {
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

/// arti's config: these directories, full vanguards.
pub fn arti_config(state_dir: &Path, cache_dir: &Path) -> Result<arti_client::TorClientConfig> {
    // arti's TLS needs a process-wide rustls provider; without one the first
    // bootstrap panics. Installing twice is harmless (the second is refused).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut b = TorClientConfigBuilder::from_directories(state_dir, cache_dir);
    // arti refuses a state dir that is group/other-writable; the keystore is
    // sealed at rest, so the permission check adds little here.
    b.storage().permissions().dangerously_trust_everyone();
    // Full vanguards: every member hosts an onion, and a hosted onion is what
    // guard-discovery attacks go after.
    b.vanguards().mode(tor_config::ExplicitOrAuto::Explicit(VanguardMode::Full));
    b.build().map_err(|e| anyhow!("tor config: {e}"))
}

/// Start arti if it is not running.
pub async fn ensure_started(mesh: &Mesh, host: Arc<dyn Host>, cfg: &MeshConfig) -> Result<()> {
    let mut guard = mesh.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let cache_dir = cfg.cache_dir.clone();
    let state_dir = cfg.state_dir.clone();
    std::fs::create_dir_all(&cache_dir)?;
    std::fs::create_dir_all(&state_dir)?;
    // Bring back the sealed state (keystore, guards, vanguards).
    if is_dir_empty(&state_dir) {
        if let Some(archive) = host.load_keystore() {
            let _ = extract_archive(&state_dir, &archive);
        }
    }
    clear_lockfiles(&state_dir);
    host.on_tor_state("starting");
    let client = match TorClient::create_bootstrapped(arti_config(&state_dir, &cache_dir)?).await {
        Ok(c) => c,
        Err(e) => {
            host.on_tor_state("error");
            return Err(anyhow!("tor bootstrap failed: {e}"));
        }
    };
    *guard = Some(Node { client, host: host.clone(), rooms: HashMap::new(), state_dir, join_cancel: None });
    host.on_tor_state("on");
    Ok(())
}

pub async fn client_of(mesh: &Mesh) -> Result<Arc<TorClient<PreferredRuntime>>> {
    let guard = mesh.0.lock().await;
    Ok(guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?.client.clone())
}

async fn room_of(mesh: &Mesh, slug: &str) -> Option<Arc<Room>> {
    mesh.0.lock().await.as_ref()?.rooms.get(slug).cloned()
}

/// Seal arti's state, then remove the plaintext copy. If the seal fails, the
/// plaintext stays rather than losing the room's onion keys.
fn seal_and_wipe(host: &dyn Host, state_dir: &Path) {
    let sealed = archive_dir(state_dir).ok().map(|a| host.save_keystore(&a)).unwrap_or(false);
    if sealed {
        let _ = std::fs::remove_dir_all(state_dir);
    }
}

/// Tear everything down: every room, every link, arti itself.
pub async fn shutdown(mesh: &Mesh) {
    let node = mesh.0.lock().await.take();
    if let Some(node) = node {
        let host = node.host.clone();
        for (slug, room) in &node.rooms {
            room.stop_all().await;
            host.on_closed(slug);
        }
        let state_dir = node.state_dir.clone();
        drop(node); // arti lets go of the keystore
        seal_and_wipe(&*host, &state_dir);
        host.on_tor_state("off");
    }
}

/// Forget every onion identity: the next room launch mints fresh addresses.
pub async fn clean_keystore(mesh: &Mesh, host: &dyn Host) {
    let node = mesh.0.lock().await.take();
    if let Some(node) = node {
        let h = node.host.clone();
        for (slug, room) in &node.rooms {
            room.stop_all().await;
            h.on_closed(slug);
        }
        let state_dir = node.state_dir.clone();
        drop(node);
        let _ = std::fs::remove_dir_all(&state_dir);
        h.on_tor_state("off");
    }
    host.delete_keystore();
}

// ── rooms ─────────────────────────────────────────────────────────────────────

/// This device's onion for an open room, if any.
pub async fn room_onion(mesh: &Mesh, slug: &str) -> Option<String> {
    Some(room_of(mesh, slug).await?.my_onion.clone())
}

/// Host a room: launch our onion for it and accept members' links. Returns
/// `(slug, my_onion)`. Idempotent.
pub async fn open_room(mesh: &Mesh, host: Arc<dyn Host>, cfg: &MeshConfig, name: String) -> Result<(String, String)> {
    ensure_started(mesh, host.clone(), cfg).await?;
    let slug = room_for(&name);
    if let Some(room) = room_of(mesh, &slug).await {
        return Ok((slug, room.my_onion.clone()));
    }
    let client = client_of(mesh).await?;
    let svc_cfg = OnionServiceConfigBuilder::default()
        .nickname(nickname_for(&cfg.nickname_prefix, &name)?)
        .build()
        .map_err(|e| anyhow!("onion service config: {e}"))?;
    let (service, rend) = client
        .launch_onion_service(svc_cfg)
        .map_err(|e| anyhow!("launch onion service: {e}"))?
        .ok_or_else(|| anyhow!("onion service disabled in config"))?;
    let my_onion = wait_onion_address(&service).await?;
    let room = Arc::new(Room {
        host: host.clone(),
        cfg: Arc::new(cfg.clone()),
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
        last_sent: AtomicU64::new(now_secs()),
        cover_task: std::sync::Mutex::new(None),
    });
    {
        let mut guard = mesh.0.lock().await;
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
    host.on_status(&slug, &[], None);
    Ok((slug, my_onion))
}

/// The members this device should keep a link to. Replaces the previous list.
pub async fn set_peers(mesh: &Mesh, slug: &str, onions: Vec<String>) -> Result<()> {
    let room = room_of(mesh, slug).await.ok_or_else(|| anyhow!("no such room"))?;
    let my_id = room.host.peer_id()?;
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

/// Open a room and link to the given members. [`cancel_join`] aborts it
/// with `JOIN_CANCELLED`.
pub async fn join_room(mesh: &Mesh, host: Arc<dyn Host>, cfg: &MeshConfig, name: String, peers: Vec<String>) -> Result<(String, String)> {
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = mesh.0.lock().await;
        if let Some(node) = guard.as_mut() {
            node.join_cancel = Some(tx);
        }
    }
    let work = async {
        let (slug, onion) = open_room(mesh, host, cfg, name).await?;
        set_peers(mesh, &slug, peers).await?;
        Ok::<_, anyhow::Error>((slug, onion))
    };
    tokio::select! {
        r = work => r,
        _ = rx => Err(anyhow!("JOIN_CANCELLED")),
    }
}

pub async fn cancel_join(mesh: &Mesh) {
    let tx = mesh.0.lock().await.as_mut().and_then(|n| n.join_cancel.take());
    if let Some(tx) = tx {
        let _ = tx.send(());
    }
}

/// Send one frame to every member: down every live link, and into the outbox
/// of every wanted member without one.
pub async fn broadcast(mesh: &Mesh, slug: &str, payload: String) -> Result<()> {
    let room = room_of(mesh, slug).await.ok_or_else(|| anyhow!("no such room"))?;
    let payload = pad(payload, room.cfg.max_frame);
    room.last_sent.store(now_secs(), Ordering::Relaxed);
    let targets: Vec<(String, u64, Writer)> =
        room.links.lock().await.iter().map(|(p, l)| (p.clone(), l.seq, l.write.clone())).collect();
    let linked: std::collections::HashSet<String> = targets.iter().map(|t| t.0.clone()).collect();
    for (peer, seq, w) in targets {
        let ok = write_frame_bounded(&mut *w.lock().await, &payload, room.cfg.write_timeout).await.is_ok();
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
pub async fn leave_room(mesh: &Mesh, slug: &str) {
    let room = mesh.0.lock().await.as_mut().and_then(|n| n.rooms.remove(slug));
    if let Some(room) = room {
        room.stop_all().await;
    }
}

/// Destroy a room's onion identity: a future room of the same name mints a
/// fresh `.onion`.
pub async fn forget_onion(mesh: &Mesh, host: &dyn Host, cfg: &MeshConfig, name: String) -> Result<()> {
    let slug = room_for(&name);
    leave_room(mesh, &slug).await;
    let nick = nickname_for(&cfg.nickname_prefix, &name)?.to_string();
    let running = mesh.0.lock().await.as_ref().map(|n| n.state_dir.clone());
    match running {
        Some(dir) => remove_nickname_from_keystore(&dir, &nick),
        None => {
            // Not running: edit the sealed copy.
            if let Some(archive) = host.load_keystore() {
                let tmp = std::env::temp_dir().join(format!("enigma-tor-forget-{}", uuid::Uuid::new_v4().simple()));
                let _ = std::fs::create_dir_all(&tmp);
                if extract_archive(&tmp, &archive).is_ok() {
                    remove_nickname_from_keystore(&tmp, &nick);
                    if let Ok(re) = archive_dir(&tmp) {
                        let _ = host.save_keystore(&re);
                    }
                }
                let _ = std::fs::remove_dir_all(&tmp);
            }
        }
    }
    Ok(())
}

/// Dial an onion for a stream of another kind (`redeem`, `file`): same onion,
/// same port, a different `kind`.
pub async fn dial_kind(mesh: &Mesh, host: Arc<dyn Host>, cfg: &MeshConfig, onion: &str, kind: &str) -> Result<(ReadHalf, WriteHalf)> {
    ensure_started(mesh, host.clone(), cfg).await?;
    let client = client_of(mesh).await?;
    let hello = Hello {
        name: String::new(),
        peer_id: host.peer_id()?,
        kind: Some(kind.to_string()),
        onion: String::new(),
        device: String::new(),
        ts: 0,
        sig: String::new(),
    };
    dial(&client, cfg, onion, &hello).await
}

/// Pad a frame to a fixed size so its length says little about what it carries:
/// 512 B, 2 KiB, 8 KiB, then whole multiples of 32 KiB (capped at `max_frame`).
/// The padding is trailing spaces, which every JSON parser ignores.
pub fn padded_len(n: usize, max_frame: usize) -> usize {
    let size = match n {
        0..=512 => 512,
        513..=2048 => 2048,
        2049..=8192 => 8192,
        _ => n.div_ceil(32 * 1024) * 32 * 1024,
    };
    size.min(max_frame).max(n)
}

pub fn pad(mut payload: String, max_frame: usize) -> String {
    let target = padded_len(payload.len(), max_frame);
    payload.extend(std::iter::repeat_n(' ', target - payload.len()));
    payload
}

// ── tasks ─────────────────────────────────────────────────────────────────────

/// Keep a link to one wanted peer for as long as it is wanted.
fn spawn_dialer(room: Arc<Room>, peer: String, my_id: String) -> JoinHandle<()> {
    tokio::spawn(async move {
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
            let (device, sig) = match (room.host.device_id(), room.host.sign(&link_message(&peer, &room.my_onion, ts))) {
                (Some(d), Some(s)) => (d, hex::encode(s)),
                _ => (String::new(), String::new()),
            };
            let hello = Hello { name: room.name.clone(), peer_id: my_id.clone(), kind: None, onion: room.my_onion.clone(), device, ts, sig };
            match dial(&room.client, &room.cfg, &peer, &hello).await {
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

// ── cover traffic ─────────────────────────────────────────────────────────────
// While a room is open, something goes to every linked member at a steady rate:
// a real frame if there was one in the slot, otherwise a padded dummy the reader
// drops.

pub const COVER: &str = r#"{"type":"cover"}"#;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn is_cover(payload: &str) -> bool {
    payload.trim_end() == COVER
}

fn spawn_cover(room: std::sync::Weak<Room>) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let every = match room.upgrade() {
                Some(r) => r.cfg.cover_every,
                None => break,
            };
            // ±20 % jitter, so the dummies are not a metronome either.
            let jitter = (chacha20poly1305::aead::rand_core::RngCore::next_u64(&mut chacha20poly1305::aead::OsRng) % (every * 2 / 5 + 1)) as i64
                - (every / 5) as i64;
            tokio::time::sleep(Duration::from_secs((every as i64 + jitter).max(1) as u64)).await;
            let Some(room) = room.upgrade() else { break };
            let quiet = now_secs().saturating_sub(room.last_sent.load(Ordering::Relaxed));
            if quiet + 1 < every {
                continue; // a real frame went out in this slot
            }
            let frame = pad(COVER.to_string(), room.cfg.max_frame);
            let targets: Vec<Writer> = room.links.lock().await.values().map(|l| l.write.clone()).collect();
            for w in targets {
                let _ = write_frame_bounded(&mut *w.lock().await, &frame, room.cfg.write_timeout).await;
            }
            room.last_sent.store(now_secs(), Ordering::Relaxed);
        }
    })
}

/// Read one link until it closes.
fn spawn_reader(room: Arc<Room>, peer: String, seq: u64, mut rd: ReadHalf) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Ok(payload) = read_frame(&mut rd, room.cfg.max_frame).await {
            if is_cover(&payload) {
                continue; // cover traffic: it only has to have been sent
            }
            room.host.on_frame(&room.slug, &payload);
        }
        // `drop_link` aborts this task, so run it from a fresh one.
        let r = room.clone();
        tokio::spawn(async move { r.drop_link(&peer, seq).await });
    })
}

fn spawn_accept_loop<S>(room: Arc<Room>, rend: S) -> JoinHandle<()>
where
    S: futures_lite::stream::Stream<Item = RendRequest> + Send + 'static,
{
    tokio::spawn(async move {
        let mut streams = Box::pin(handle_rend_requests(rend));
        while let Some(req) = streams.next().await {
            let Ok(ds) = req.accept(Connected::new_empty()).await else { continue };
            let room = room.clone();
            // Each stream's handshake runs on its own task.
            tokio::spawn(async move {
                let (mut rd, mut wr) = tokio::io::split(ds);
                let hello = match tokio::time::timeout(room.cfg.handshake_timeout, read_frame(&mut rd, room.cfg.max_frame)).await {
                    Ok(Ok(s)) => match serde_json::from_str::<Hello>(&s) {
                        Ok(h) => h,
                        Err(_) => return,
                    },
                    _ => return,
                };
                // A room link only from a current member (other kinds carry
                // their own proofs). Anyone else is told no and dropped.
                let other_kind = hello.kind.as_deref().filter(|k| room.host.stream_kinds().contains(k)).map(str::to_string);
                let ok = other_kind.is_some() || link_is_genuine(&*room.host, &room.slug, &room.my_onion, &hello);
                if write_frame(&mut wr, &serde_json::to_string(&Ready { ok }).unwrap()).await.is_err() || !ok {
                    return;
                }
                match other_kind {
                    Some(kind) => room.host.serve_stream(&kind, rd, wr).await,
                    None => {
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
pub async fn wait_onion_address(service: &RunningOnionService) -> Result<String> {
    for _ in 0..50 {
        if let Some(id) = service.onion_address() {
            return Ok(id.display_unredacted().to_string());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(anyhow!("onion address was not ready"))
}

// ── arti's state on disk ──────────────────────────────────────────────────────

fn is_dir_empty(dir: &Path) -> bool {
    std::fs::read_dir(dir).map(|mut it| it.next().is_none()).unwrap_or(true)
}

fn is_lockfile(name: &str) -> bool {
    name.to_ascii_lowercase().contains("lock")
}

/// A lockfile left by a crash (or restored from the sealed copy) would make a
/// launch fail with "local resource … already in use".
fn clear_lockfiles(dir: &Path) {
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
fn archive_dir(dir: &Path) -> Result<Vec<u8>> {
    fn walk(root: &Path, cur: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<()> {
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

fn extract_archive(dir: &Path, bytes: &[u8]) -> Result<()> {
    let files: Vec<(String, Vec<u8>)> = postcard::from_bytes(bytes)?;
    for (rel, data) in files {
        let rel = Path::new(&rel);
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
fn remove_nickname_from_keystore(dir: &Path, nick: &str) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    const MAX_FRAME: usize = 16 * 1024 * 1024;

    #[test]
    fn rooms_and_nicknames_are_deterministic() {
        assert_eq!(room_for("a"), room_for("a"));
        assert_ne!(room_for("a"), room_for("b"));
        assert_eq!(nickname_for("enigma", "a").unwrap().to_string(), nickname_for("enigma", "a").unwrap().to_string());
        assert!(nickname_for("enigma", "a").unwrap().to_string().starts_with("enigma_"));
    }

    #[test]
    fn a_link_signature_binds_both_onions_and_the_time() {
        let k = SigningKey::from_bytes(&[9; 32]);
        let id = hex::encode(k.verifying_key().as_bytes());
        let sig = k.sign(&link_message("me.onion", "you.onion", 100)).to_bytes();
        assert!(verify_device(&id, &link_message("me.onion", "you.onion", 100), &sig));
        assert!(!verify_device(&id, &link_message("other.onion", "you.onion", 100), &sig), "not reusable at another member");
        assert!(!verify_device(&id, &link_message("me.onion", "x.onion", 100), &sig));
        assert!(!verify_device(&id, &link_message("me.onion", "you.onion", 101), &sig));
        assert!(!verify_device("nothex", &link_message("me.onion", "you.onion", 100), &sig));
    }

    #[test]
    fn cover_frames_are_padded_like_the_smallest_message_and_recognised() {
        let f = pad(COVER.to_string(), MAX_FRAME);
        assert_eq!(f.len(), 512);
        assert!(is_cover(&f));
        assert!(!is_cover(&pad(r#"{"type":"mls_app","ciphertext":"x"}"#.to_string(), MAX_FRAME)));
    }

    #[test]
    fn frames_are_padded_to_buckets_and_still_parse() {
        assert_eq!(padded_len(1, MAX_FRAME), 512);
        assert_eq!(padded_len(512, MAX_FRAME), 512);
        assert_eq!(padded_len(513, MAX_FRAME), 2048);
        assert_eq!(padded_len(5000, MAX_FRAME), 8192);
        assert_eq!(padded_len(8193, MAX_FRAME), 32 * 1024);
        assert_eq!(padded_len(40_000, MAX_FRAME), 64 * 1024);
        let p = pad(r#"{"type":"mls_app","ciphertext":"x"}"#.to_string(), MAX_FRAME);
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
        let got = read_frame(&mut std::io::Cursor::new(buf), MAX_FRAME).await.unwrap();
        assert_eq!(got, r#"{"type":"mls_app"}"#);
    }

    #[tokio::test]
    async fn an_oversized_frame_is_refused_before_allocating() {
        let mut buf = ((MAX_FRAME as u32) + 1).to_le_bytes().to_vec();
        buf.extend_from_slice(b"body");
        assert!(read_frame(&mut std::io::Cursor::new(buf), MAX_FRAME).await.is_err());
    }

    #[test]
    fn the_tor_config_asks_for_full_vanguards() {
        let dir = std::env::temp_dir().join(format!("beacon_node_vg_{}", std::process::id()));
        let cfg = arti_config(&dir, &dir).unwrap();
        let dbg = format!("{cfg:?}");
        assert!(dbg.contains("Full"), "vanguards mode missing from config: {dbg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_archive_never_writes_outside_its_dir() {
        let dir = std::env::temp_dir().join(format!("beacon_node_arch_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let evil = postcard::to_stdvec(&vec![("../escape".to_string(), b"x".to_vec()), ("ok/f".to_string(), b"y".to_vec())]).unwrap();
        extract_archive(&dir, &evil).unwrap();
        assert!(!dir.parent().unwrap().join("escape").exists());
        assert_eq!(std::fs::read(dir.join("ok/f")).unwrap(), b"y");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_archive_round_trips_without_lockfiles() {
        let dir = std::env::temp_dir().join(format!("beacon_node_rt_{}", std::process::id()));
        let out = std::env::temp_dir().join(format!("beacon_node_rt_out_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("k/enigma_x")).unwrap();
        std::fs::write(dir.join("k/enigma_x/key"), b"secret").unwrap();
        std::fs::write(dir.join("state.lock"), b"").unwrap();
        extract_archive(&out, &archive_dir(&dir).unwrap()).unwrap();
        assert_eq!(std::fs::read(out.join("k/enigma_x/key")).unwrap(), b"secret");
        assert!(!out.join("state.lock").exists());
        remove_nickname_from_keystore(&out, "enigma_x");
        assert!(!out.join("k/enigma_x").exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&out);
    }
}
