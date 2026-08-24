// Peer-hosted Tor onion transport — the second P2P backend, selected by the
// "use Tor" switch (see realtime.rs / lib.rs `use_tor`).
//
// Topology is a STAR with an ELECTED CAPTAIN. EVERY member hosts its own onion
// service (and runs an accept/relay loop) and, unless it is the captain, holds ONE
// outbound dial to the current captain. The captain relays every frame it receives
// to all OTHER dialers and delivers it locally — so an MLS envelope reaches every
// member exactly as it does over iroh-gossip's broadcast. The relay only ever
// forwards MLS ciphertext; it never has the group keys. 1:1 is just the N=2 case.
//
// Why every member hosts: Tor has no discovery. If the captain dies, all star
// connections drop and there is no way to look up a replacement — you can only
// dial a `.onion` you already know. So the frontend elects a captain (lowest MLS
// identity), shares each member's `.onion` over the encrypted presence message,
// and on captain loss re-points every member's single outbound to the next
// captain's ALREADY-PUBLISHED onion via `set_captain`. This module owns only the
// mechanism (host, dial, relay, re-point); the election lives in useChatChannel.ts.
//
// This module mirrors p2p_iroh.rs's public surface and emits the SAME
// `realtime://message` / `realtime://status` events, so the frontend transport
// layer and the MLS state machine are unchanged (a captain-death event just adds
// an optional `reason:"captain_unreachable"`). Framing + handshake shape are
// modelled on limbo/rust/vox.rs (4-byte LE length prefix + JSON body).
//
// arti hosting notes: we build a per-profile state-dir client so arti's keystore
// persists each member's hidden-service identity key — relaunching the same room
// nickname yields the SAME `.onion`, which keeps an old QR valid and lets a
// re-elected captain be dialed at a stable address.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use arti_client::{config::TorClientConfigBuilder, DataStream, TorClient};
use futures_lite::StreamExt;
use safelog::DisplayRedacted;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{oneshot, Mutex};
use tor_cell::relaycell::msg::Connected;
use tor_hsservice::config::OnionServiceConfigBuilder;
use tor_hsservice::{handle_rend_requests, HsNickname, RendRequest, RunningOnionService};
use tor_rtcompat::PreferredRuntime;

/// The virtual port a room's onion service listens on. Rides inside each
/// invitation, so a change affects newly minted ones only.
const ONION_PORT: u16 = crate::build_config::network::ONION_PORT;
/// WIRE-INTEROP: caps a Tor transport frame. Peers in one room must agree.
const MAX_FRAME: usize = crate::build_config::network::MAX_FRAME_BYTES;

/// Cap per-frame writes so one stalled onion circuit can't block the host's
/// fan-out (or a joiner's send) forever.
const WRITE_TIMEOUT: Duration =
    Duration::from_secs(crate::build_config::network::TOR_WRITE_TIMEOUT_SECS);
/// Cap the join handshake read so a silent peer can't hang the join command.
const HANDSHAKE_TIMEOUT: Duration =
    Duration::from_secs(crate::build_config::network::TOR_HANDSHAKE_TIMEOUT_SECS);
/// How many times the outbound connection manager retries dialing the captain
/// (with backoff) before declaring it unreachable — a slow Tor dial must not be
/// mistaken for a dead captain.
const MAX_CAPTAIN_RETRIES: u32 = 3;
/// Base backoff between captain redial attempts (doubles each attempt, capped).
const CAPTAIN_RETRY_BASE_SECS: u64 = 2;

fn captain_backoff(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(3);
    Duration::from_secs((CAPTAIN_RETRY_BASE_SECS << shift).min(15))
}

/// Per-connection sequence number, distinct from the (possibly reused) peer_id.
/// Used to identify a specific joiner stream for relay fan-out + removal.
static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

// ── state ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct TorP2pState(pub Mutex<Option<Node>>);

pub struct Node {
    client: Arc<TorClient<PreferredRuntime>>,
    rooms: HashMap<String, MemberRoom>,
    /// arti's on-disk state/keystore dir for this session. Plaintext only while the
    /// node runs; sealed into protasius + wiped on shutdown (stable mode) or just
    /// wiped (ephemeral mode).
    state_dir: std::path::PathBuf,
    /// Whether the onion is stable (persist the HS key, encrypted at rest) vs
    /// ephemeral (fresh key each session).
    stable: bool,
    /// Cancel signal for the currently in-flight join, if any. The frontend's
    /// "Cancel" button fires it to abort a hanging join — dropping the
    /// half-launched onion so arti releases its keystore lock and a retry doesn't
    /// fail with "local resource … already in use". Single slot: the join modal
    /// only ever runs one join at a time.
    join_cancel: Option<oneshot::Sender<()>>,
}

/// One Tor room from this member's view. Every member hosts its own onion + relay
/// (`_service` / `peers` / `accept_task`) and, unless it is the captain, holds one
/// outbound dial to the current captain (`up`).
///
/// Relay is a TREE rooted at the captain: a member forwards each frame from a child
/// (inbound peer) up to its parent (`up`) AND across to its other children, and each
/// frame from its parent down to all children. Parent pointers always go to a
/// strictly-lower MLS id (everyone dials the lowest-id member it knows), so the
/// graph is acyclic — the flood can't loop. This lets ANY member be an entry point:
/// a joiner that dials a non-captain (e.g. the creator's QR onion after captaincy
/// moved) is still bridged to the real captain.
struct MemberRoom {
    name: String,
    my_onion: String,
    // Keep the service alive; dropping it stops serving + descriptor publishing.
    _service: Arc<RunningOnionService>,
    // Inbound peer write-halves — our children in the relay tree.
    peers: Arc<Mutex<Vec<PeerConn>>>,
    accept_task: JoinHandle<()>,
    // Write-half to our parent (the captain), or `None` when we ARE the captain or
    // are mid-reconnect. Stable across captain changes — the connection manager
    // publishes the current stream here, and re-pointing reuses this slot.
    up: Arc<Mutex<Option<WriteHalf<DataStream>>>>,
    // The task managing the `up` connection; `None` ⇒ I am the captain (host-only).
    outbound: Option<Outbound>,
}

/// The background task dialing + reading + reconnecting the outbound to the captain.
struct Outbound {
    captain_onion: String,
    task: JoinHandle<()>,
}

#[derive(Clone)]
struct PeerConn {
    /// Unique per connection — used for fan-out exclusion + removal, so a
    /// same-device redial (same peer_id) doesn't alias a still-live stream.
    seq: u64,
    write: Arc<Mutex<WriteHalf<DataStream>>>,
}


/// Room slug — deterministic from the name so creator and joiner agree (and the
/// MLS session key `profile:room:identity` matches). A room is either iroh or
/// Tor, never both, so this need not equal iroh's topic string.
fn room_for(name: &str) -> String {
    blake3::hash(name.as_bytes()).to_hex().to_string()
}

/// Hidden-service nickname — stable per room + profile + GENERATION, so the
/// keystore hands back the same identity key (⇒ same `.onion`) every launch.
///
/// The generation is what makes rotation possible. A room's onion is its exposure:
/// anyone who has the address can keep knocking for as long as it resolves, which
/// is why `privacy_hp` charges for every hour one stays up. Rotating has to
/// actually retire the address, not just stop serving it for a while — so it bumps
/// the generation, which changes the nickname, which makes arti mint a *different*
/// identity key. The old key is deleted, so the old `.onion` is gone rather than
/// dormant, and every invitation naming it is dead paper.
///
/// HS nicknames have a restricted charset, so derive from a hash rather than the
/// raw name. Generation 0 hashes the bare name, which is what every existing
/// keystore entry was written under — so an upgrade keeps its onion.
fn nickname_for_gen(name: &str, generation: u32) -> Result<HsNickname> {
    let seed = if generation == 0 {
        name.to_string()
    } else {
        format!("{name}#{generation}")
    };
    let hex = blake3::hash(seed.as_bytes()).to_hex();
    HsNickname::new(format!("enigma_{}", &hex.as_str()[..16]))
        .map_err(|e| anyhow!("invalid hs nickname: {e}"))
}

/// Which generation of `room`'s onion is current. Persisted, so a restart serves
/// the same address and a rotation is not undone by relaunching.
fn generation_of(app: &AppHandle, room: &str) -> u32 {
    crate::vault::get(app, "tor_gen", room)
        .ok()
        .flatten()
        .and_then(|v| String::from_utf8(v).ok())
        .and_then(|t| t.parse::<u32>().ok())
        .unwrap_or(0)
}

fn set_generation(app: &AppHandle, room: &str, generation: u32) -> Result<()> {
    crate::vault::put(app, "tor_gen", room, generation.to_string().as_bytes())
        .map_err(|e| anyhow!("{e}"))
}

/// The nickname a room's onion is currently served under.
fn nickname_for_room(app: &AppHandle, name: &str, room: &str) -> Result<HsNickname> {
    nickname_for_gen(name, generation_of(app, room))
}

// ── per-profile paths ─────────────────────────────────────────────────────────

fn profile_name(app: &AppHandle) -> String {
    app.try_state::<crate::AppConfigState>()
        .and_then(|s| s.lock().ok().map(|c| c.profile.clone()))
        .unwrap_or_else(|| "default".to_string())
}

/// `app_data_dir/profiles/<profile>/tor` — beside the iroh key + MLS state, so the
/// onion identity is per-profile (two dev instances ⇒ two distinct onions).
fn tor_base(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("profiles")
        .join(crate::safe_filename_component(&profile_name(app)))
        .join("tor")
}

/// Our stable presence id, sent in the join handshake. Persisted per profile
/// (encrypted at rest via protasius `keys/tor_peer_id`) so a reconnecting joiner
/// keeps the same id in the creator's presence view.
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
    crate::vault::put(app, "keys", "tor_peer_id", id.as_bytes())
        .map_err(|e| anyhow!("persist tor peer id: {e}"))?;
    Ok(id)
}

// ── framing (length-prefixed JSON string bodies) ───────────────────────────────

fn frame_bytes(payload: &str) -> Vec<u8> {
    let body = payload.as_bytes();
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out
}

async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<()> {
    w.write_all(&frame_bytes(payload)).await?;
    w.flush().await?;
    Ok(())
}

/// This room's own onion, for embedding in an invitation. `None` when the room
/// is not hosted over Tor on this device.
pub async fn room_onion(state: &TorP2pState, room: &str) -> Option<String> {
    let guard = state.0.lock().await;
    Some(guard.as_ref()?.rooms.get(room)?.my_onion.clone())
}

/// Dial an inviter's onion for an invitation redemption.
///
/// Reuses the room transport wholesale — same onion, same virtual port, same
/// handshake, same framing — and differs only in the `kind` it declares, which
/// routes the accepted stream to `invite_redeem` instead of a room's message
/// loop. Nothing about the room transport had to change to carry this.
///
/// Starting the node if it is not already up is deliberate: someone redeeming an
/// invitation over Tor has usually not opened a room yet, so there is nothing to
/// have started it for them.
pub async fn dial_redeem(
    app: &AppHandle,
    state: &TorP2pState,
    onion: &str,
) -> Result<(ReadHalf<DataStream>, WriteHalf<DataStream>)> {
    ensure_started(app, state).await?;
    let client = client_of(state).await?;
    let my_id = load_or_create_peer_id(app)?;
    let ds = client
        .connect((onion, ONION_PORT))
        .await
        .map_err(|e| anyhow!("INVITE_UNREACHABLE: tor connect to {onion} failed: {e}"))?;
    let (mut rd, mut wr) = tokio::io::split(ds);
    write_frame_bounded(
        &mut wr,
        &serde_json::to_string(&Hello {
            // The inviter shows this nowhere: a redemption is not a room join, so
            // the roster name comes later, inside the redemption request itself.
            name: String::new(),
            peer_id: my_id,
            kind: Some("redeem".to_string()),
        })
        .unwrap(),
    )
    .await?;
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut rd)).await {
        Ok(r) => {
            r.map_err(|e| anyhow!("INVITE_UNREACHABLE: handshake failed: {e}"))?;
        }
        Err(_) => return Err(anyhow!("INVITE_UNREACHABLE: handshake timed out")),
    }
    Ok((rd, wr))
}

/// Framing, for `invite_redeem`'s Tor adapter. The onion transport's frames are
/// the only ones that exist on this carrier, so an invitation redemption uses
/// exactly the same envelope every room message does.
pub async fn write_frame_pub<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<()> {
    write_frame(w, payload).await
}

pub async fn read_frame_pub<R: AsyncRead + Unpin>(r: &mut R) -> Result<String> {
    read_frame(r).await
}

/// `write_frame` bounded by `WRITE_TIMEOUT` — a stalled peer errors out instead of
/// blocking every other peer in a fan-out.
async fn write_frame_bounded<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<()> {
    match tokio::time::timeout(WRITE_TIMEOUT, write_frame(w, payload)).await {
        Ok(r) => r,
        Err(_) => Err(anyhow!("write timed out")),
    }
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<String> {
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

// ── handshake frames ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Hello {
    name: String,
    peer_id: String,
    /// What this connection is for. Absent means `"room"` — the only thing that
    /// existed before invitations, so a peer built before this field keeps
    /// working untouched. `"redeem"` routes the stream to `invite_redeem`
    /// instead of the room's message loop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Ready {
    ok: bool,
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

async fn ensure_started(app: &AppHandle, state: &TorP2pState) -> Result<()> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let base = tor_base(app);
    let cache_dir = base.join("cache"); // dir cache isn't secret; persistent, speeds bootstrap
    let _ = std::fs::create_dir_all(&cache_dir);

    let stable = stable_onion_enabled(app);
    let state_dir = if stable {
        // Persistent keystore → stable `.onion`. Materialize the sealed keystore
        // from protasius (if any) so arti finds the existing HS key. It is plaintext
        // on disk only while running; shutdown re-seals + wipes it.
        let d = base.join("state");
        let _ = std::fs::create_dir_all(&d);
        if is_dir_empty(&d) {
            if let Ok(Some(archive)) = crate::vault::get(app, "keys", "tor_keystore") {
                let _ = extract_archive(&d, &archive);
            }
        }
        d
    } else {
        // Ephemeral: a fresh temp dir → arti generates a new HS key → the onion
        // regenerates each session. Nothing persists in app-data.
        let d = std::env::temp_dir().join(format!(
            "enigma-tor-{}-{}",
            crate::safe_filename_component(&profile_name(app)),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::create_dir_all(&d);
        d
    };

    // Remove any stale arti lockfile (crash leftover, or restored from an archive)
    // so `launch_onion_service` doesn't fail with "local resource … already in use".
    clear_lockfiles(&state_dir);

    let mut cfg_builder = TorClientConfigBuilder::from_directories(state_dir.clone(), cache_dir);
    // Relax arti's fs-mistrust: it refuses a state/keystore dir that is (or whose
    // ancestor is) group/other-writable, which fails on a permissive umask or a
    // group-writable home (and on the world-writable /tmp used for the ephemeral
    // dir). With encryption-at-rest the sensitive keystore is sealed into protasius
    // and only lives on disk transiently while unlocked, so the dir-permission
    // check adds little here — keep it relaxed (see technology.md §13).
    cfg_builder.storage().permissions().dangerously_trust_everyone();
    let cfg = cfg_builder
        .build()
        .map_err(|e| anyhow!("tor config: {e}"))?;
    // create_bootstrapped yields an Arc<TorClient> (cached for the process life).
    let client = TorClient::create_bootstrapped(cfg)
        .await
        .map_err(|e| anyhow!("tor bootstrap failed: {e}"))?;
    *guard = Some(Node {
        client,
        rooms: HashMap::new(),
        state_dir,
        stable,
        join_cancel: None,
    });
    Ok(())
}

/// Read the active profile's `stable_onion` flag (defaults false when locked/absent).
fn stable_onion_enabled(app: &AppHandle) -> bool {
    match app
        .try_state::<crate::AppConfigState>()
        .and_then(|s| s.lock().ok().map(|c| c.clone()))
    {
        Some(cfg) => crate::is_stable_onion(&crate::load_profile_state(app, &cfg)),
        None => false,
    }
}

fn is_dir_empty(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir).map(|mut it| it.next().is_none()).unwrap_or(true)
}

/// A stale arti lockfile (from a crash, or restored from a sealed archive) makes
/// `launch_onion_service` fail with "local resource … already in use". These locks
/// are recreated on launch, so removing any left behind is safe.
fn is_lockfile(name: &str) -> bool {
    name.to_ascii_lowercase().contains("lock")
}

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

/// Before launching an onion: if NO room is currently live, clear any stale arti
/// lockfile left behind by a failed or cancelled previous launch — otherwise
/// `launch_onion_service` fails with "local resource … already in use" on the retry
/// (`ensure_started` only clears locks once, at first bootstrap). Guarded on "no
/// live room" so we never delete a lock belonging to another active onion sharing
/// this profile's state dir.
async fn clear_stale_locks_if_idle(state: &TorP2pState) {
    let dir = {
        let guard = state.0.lock().await;
        match guard.as_ref() {
            Some(node) if node.rooms.is_empty() => Some(node.state_dir.clone()),
            _ => None,
        }
    };
    if let Some(dir) = dir {
        clear_lockfiles(&dir);
    }
}

/// Serialize a directory tree (relative path + bytes) into one blob, for sealing
/// arti's keystore into protasius.
fn archive_dir(dir: &std::path::Path) -> Result<Vec<u8>> {
    fn walk(root: &std::path::Path, cur: &std::path::Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<()> {
        for entry in std::fs::read_dir(cur)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(root, &path, out)?;
            } else if path.file_name().and_then(|n| n.to_str()).map(is_lockfile).unwrap_or(false) {
                // Never seal a lockfile — restoring it later would block the launch.
                continue;
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push((rel.to_string_lossy().into_owned(), std::fs::read(&path)?));
            }
        }
        Ok(())
    }
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    if dir.exists() {
        walk(dir, dir, &mut files)?;
    }
    Ok(postcard::to_stdvec(&files)?)
}

/// Restore a directory tree previously produced by `archive_dir`.
fn extract_archive(dir: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let files: Vec<(String, Vec<u8>)> = postcard::from_bytes(bytes)?;
    for (rel, data) in files {
        let p = dir.join(&rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&p, &data)?;
    }
    Ok(())
}

async fn client_of(state: &TorP2pState) -> Result<Arc<TorClient<PreferredRuntime>>> {
    let guard = state.0.lock().await;
    Ok(guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?.client.clone())
}

/// Poll the running service for its address (the descriptor is not instant).
async fn wait_onion_address(service: &RunningOnionService) -> Result<String> {
    for _ in 0..50 {
        if let Some(id) = service.onion_address() {
            // HsId has no plain Display (redaction-safe); take the full address.
            return Ok(id.display_unredacted().to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Err(anyhow!("onion address was not ready"))
}

/// Launch this member's own onion service + accept/relay loop. Every member does
/// this (create AND join) so anyone can become the captain without a fresh
/// descriptor publish. Returns `(my_onion, service, peers, accept_task)`.
type HostParts = (
    String,                          // my_onion
    Arc<RunningOnionService>,        // service
    Arc<Mutex<Vec<PeerConn>>>,       // inbound children
    JoinHandle<()>,                  // accept task
    Arc<Mutex<Option<WriteHalf<DataStream>>>>, // `up` slot (to parent)
);

async fn host_onion(app: &AppHandle, state: &TorP2pState, room: &str, name: &str) -> Result<HostParts> {
    // Drop any stale lock from a prior failed/cancelled launch (idle only) so this
    // launch doesn't hit "local resource … already in use".
    clear_stale_locks_if_idle(state).await;
    let client = client_of(state).await?;
    let nick = nickname_for_room(app, name, room)?;
    let svc_cfg = OnionServiceConfigBuilder::default()
        .nickname(nick)
        .build()
        .map_err(|e| anyhow!("onion service config: {e}"))?;
    let (service, rend) = client
        .launch_onion_service(svc_cfg)
        .map_err(|e| anyhow!("launch onion service: {e}"))?
        .ok_or_else(|| anyhow!("onion service disabled in config"))?;
    let onion = wait_onion_address(&service).await?;
    let peers = Arc::new(Mutex::new(Vec::new()));
    // `up` is created here (empty) and stays stable for the room's life; the accept
    // loop's per-peer readers bridge child frames up through it.
    let up = Arc::new(Mutex::new(None));
    let accept_task = spawn_accept_loop(app.clone(), room.to_string(), rend, peers.clone(), up.clone());
    Ok((onion, service, peers, accept_task, up))
}

/// Dial an onion and run the `Hello`/`Ready` handshake. Returns the split stream.
async fn dial_and_handshake(
    client: &Arc<TorClient<PreferredRuntime>>,
    onion: &str,
    name: &str,
    my_id: &str,
) -> Result<(ReadHalf<DataStream>, WriteHalf<DataStream>)> {
    let ds = client
        .connect((onion, ONION_PORT))
        .await
        .map_err(|e| anyhow!("tor connect to {onion} failed: {e}"))?;
    let (mut rd, mut wr) = tokio::io::split(ds);
    write_frame_bounded(
        &mut wr,
        &serde_json::to_string(&Hello {
            name: name.to_string(),
            peer_id: my_id.to_string(),
            kind: None,
        })
        .unwrap(),
    )
    .await?;
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut rd)).await {
        Ok(r) => {
            r.map_err(|e| anyhow!("handshake failed: {e}"))?;
        }
        Err(_) => return Err(anyhow!("handshake timed out")),
    }
    Ok((rd, wr))
}

/// Open a room as the initial captain and return `(room, ticket, my_onion)`.
/// Idempotent: recreating an already-open room returns the existing onion (the
/// reconnect / re-host path).
/// Host a room's onion service and return `(room, my_onion)`.
///
/// It used to also mint a permanent ticket carrying this onion. That ticket was
/// the only way a joiner learned the captain's address — and the only record of
/// it, which is why removing it needed `captainOnion` on the saved room record
/// first. An invitation carries the address now, freshly, at mint time.
pub async fn create_room(app: &AppHandle, state: &TorP2pState, name: String) -> Result<(String, String)> {
    ensure_started(app, state).await?;
    let room = room_for(&name);

    // Already in this room? Return the existing onion.
    {
        let guard = state.0.lock().await;
        if let Some(node) = guard.as_ref() {
            if let Some(mr) = node.rooms.get(&room) {
                return Ok((room, mr.my_onion.clone()));
            }
        }
    }

    let (my_onion, service, peers, accept_task, up) = host_onion(app, state, &room, &name).await?;
    {
        let mut guard = state.0.lock().await;
        let node = guard.as_mut().ok_or_else(|| anyhow!("tor not started"))?;
        // A concurrent create for the same room won the race while we were launching:
        // drop our duplicate service (it holds the same nickname/lock) and return theirs.
        if let Some(mr) = node.rooms.get(&room) {
            accept_task.abort();
            return Ok((room, mr.my_onion.clone()));
        }
        node.rooms.insert(
            room.clone(),
            MemberRoom {
                name: name.clone(),
                my_onion: my_onion.clone(),
                _service: service,
                peers,
                accept_task,
                up,
                outbound: None, // sole member ⇒ trivially the captain
            },
        );
    }
    emit_status(app, &room, "connecting", 0, None);
    Ok((room, my_onion))
}

/// Cancel any in-flight Tor join. Fires the join's cancel signal (dropping the
/// half-launched onion so arti releases its keystore lock) and, when no room is
/// live, clears any leftover lockfile so the next attempt launches cleanly. A no-op
/// when nothing is joining.
pub async fn cancel_join(state: &TorP2pState) {
    let (tx, state_dir) = {
        let mut guard = state.0.lock().await;
        match guard.as_mut() {
            Some(node) => (
                node.join_cancel.take(),
                node.rooms.is_empty().then(|| node.state_dir.clone()),
            ),
            None => (None, None),
        }
    };
    let had_pending = tx.is_some();
    if let Some(tx) = tx {
        let _ = tx.send(());
    }
    // Give the aborted join a moment to drop its onion service, then clear any stale
    // lock so the retry's `launch_onion_service` doesn't hit "resource already in
    // use". Only when idle (no live onion whose lock we'd wrongly delete).
    if had_pending {
        if let Some(dir) = state_dir {
            tokio::time::sleep(Duration::from_millis(200)).await;
            clear_lockfiles(&dir);
        }
    }
}

/// Re-point this member's outbound dial to `captain_onion` (the elected captain).
/// Idempotent: no-op when unchanged; drops the outbound (host-only) when I am the
/// captain; aborts + redials on a change.
pub async fn set_captain(app: &AppHandle, state: &TorP2pState, room: &str, captain_onion: String) -> Result<()> {
    let my_id = load_or_create_peer_id(app)?;
    let mut guard = state.0.lock().await;
    let node = guard.as_mut().ok_or_else(|| anyhow!("tor not started"))?;
    let client = node.client.clone();
    let mr = node.rooms.get_mut(room).ok_or_else(|| anyhow!("no such tor room"))?;

    // Unchanged captain → no-op (avoids redial blips on stable elections).
    if captain_onion != mr.my_onion {
        if let Some(out) = &mr.outbound {
            if out.captain_onion == captain_onion {
                return Ok(());
            }
        }
    }
    // Abort any existing outbound and stop sending to the old captain.
    if let Some(out) = mr.outbound.take() {
        out.task.abort();
    }
    *mr.up.lock().await = None;

    // I am the captain → host-only, no outbound (accept/relay loop already runs).
    if captain_onion == mr.my_onion {
        return Ok(());
    }
    // Otherwise dial the new captain (the manager reuses the stable `up` slot).
    let task = spawn_captain_manager(
        app.clone(),
        room.to_string(),
        mr.name.clone(),
        client,
        my_id,
        captain_onion.clone(),
        mr.up.clone(),
        mr.peers.clone(),
        None,
    );
    mr.outbound = Some(Outbound { captain_onion, task });
    Ok(())
}

/// Enter a room by name — for Tor this means "host it" (same nickname ⇒ same
/// onion), after which a joiner is pointed at the captain via `set_captain` from
/// the saved `captainOnion` or an invitation grant. The only Tor entry path.
pub async fn join_room_by_node(
    app: &AppHandle,
    state: &TorP2pState,
    name: String,
    _onions: Vec<String>,
) -> Result<String> {
    let (room, _onion) = create_room(app, state, name).await?;
    Ok(room)
}

pub async fn broadcast(state: &TorP2pState, room: &str, payload: String) -> Result<()> {
    // Our own frame floods both ways in the relay tree: up to the captain (parent)
    // and down to every inbound peer (children). Snapshot handles under the lock,
    // then write after dropping it (Tor writes are slow).
    let (up, children) = {
        let guard = state.0.lock().await;
        let node = guard.as_ref().ok_or_else(|| anyhow!("tor not started"))?;
        let mr = node.rooms.get(room).ok_or_else(|| anyhow!("no such tor room"))?;
        let up = mr.up.clone();
        let children: Vec<Arc<Mutex<WriteHalf<DataStream>>>> =
            mr.peers.lock().await.iter().map(|c| c.write.clone()).collect();
        (up, children)
    };
    // Up to the captain (None while captain / mid-reconnect ⇒ skip, best-effort).
    {
        let mut g = up.lock().await;
        if let Some(w) = g.as_mut() {
            let _ = write_frame_bounded(w, &payload).await;
        }
    }
    // Down to our children.
    for w in children {
        let mut g = w.lock().await;
        let _ = write_frame_bounded(&mut *g, &payload).await;
    }
    Ok(())
}

/// True if this backend currently owns `room` — lets the realtime layer route a
/// send to the transport that actually holds the room, not the global switch.
pub async fn has_room(state: &TorP2pState, room: &str) -> bool {
    let guard = state.0.lock().await;
    guard.as_ref().is_some_and(|node| node.rooms.contains_key(room))
}

pub async fn leave_room(state: &TorP2pState, room: &str) -> Result<()> {
    let mut guard = state.0.lock().await;
    if let Some(node) = guard.as_mut() {
        if let Some(mr) = node.rooms.remove(room) {
            mr.accept_task.abort(); // dropping _service stops serving
            if let Some(out) = mr.outbound {
                out.task.abort();
            }
        }
    }
    Ok(())
}

/// Our onion for a currently-open room, or "" (no global identity over Tor). Does
/// not bootstrap Tor — the Settings "My identity" card must not hang on this.
pub async fn node_info(_app: &AppHandle, state: &TorP2pState) -> Result<String> {
    let guard = state.0.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(mr) = node.rooms.values().next() {
            return Ok(mr.my_onion.clone());
        }
    }
    Ok(String::new())
}

/// Tear the whole Tor node down (airplane mode, or switching Tor off): abort every
/// room task, drop the running services, and emit a disconnected status per room.
pub async fn shutdown(app: &AppHandle, state: &TorP2pState) {
    let mut guard = state.0.lock().await;
    if let Some(mut node) = guard.take() {
        let rooms: Vec<String> = node.rooms.keys().cloned().collect();
        for (_, mr) in node.rooms.drain() {
            mr.accept_task.abort();
            if let Some(out) = mr.outbound {
                out.task.abort();
            }
        }
        for room in &rooms {
            emit_status(app, room, "disconnected", 0, None);
        }
        let state_dir = node.state_dir.clone();
        let stable = node.stable;
        // Drop the client + services first so arti releases the keystore dir.
        drop(node);
        // Ephemeral dirs are always disposable. For a stable onion, only wipe the
        // plaintext keystore once it is durably SEALED into protasius — if the seal
        // fails (e.g. the active vault is a different, locked profile), keep the
        // plaintext (re-enter the crash window) rather than destroy the HS key.
        let wipe = if stable {
            archive_dir(&state_dir)
                .ok()
                .map(|a| crate::vault::put(app, "keys", "tor_keystore", &a).is_ok())
                .unwrap_or(false)
        } else {
            true
        };
        if wipe {
            let _ = std::fs::remove_dir_all(&state_dir);
        }
    }
}

/// Reset the onion identity: tear the node down WITHOUT sealing, wipe the on-disk
/// keystore, and drop the sealed copy from protasius. The next launch mints a fresh
/// `.onion` (and any stale lock is gone). Wired into "Clear selected data".
pub async fn clean_keystore(app: &AppHandle, state: &TorP2pState) {
    {
        let mut guard = state.0.lock().await;
        if let Some(mut node) = guard.take() {
            let rooms: Vec<String> = node.rooms.keys().cloned().collect();
            for (_, mr) in node.rooms.drain() {
                mr.accept_task.abort();
                if let Some(out) = mr.outbound {
                    out.task.abort();
                }
            }
            let state_dir = node.state_dir.clone();
            drop(node);
            let _ = std::fs::remove_dir_all(&state_dir);
            for room in rooms {
                emit_status(app, &room, "disconnected", 0, None);
            }
        }
    }
    let _ = crate::vault::delete(app, "keys", "tor_keystore");
}

/// Every room whose onion service is up right now.
///
/// The Privacy HP exposure meter charges per active persistent onion, so it needs
/// to know exactly which ones are reachable — not which rooms are saved, and not
/// which the user is looking at. A room absent from this list costs nothing,
/// which is what makes "stop charging when the room closes, when Tor is switched
/// off, or when the address is rotated" fall out of one check instead of three.
pub async fn hosted_rooms(state: &TorP2pState) -> Vec<String> {
    let guard = state.0.lock().await;
    guard.as_ref().map(|n| n.rooms.keys().cloned().collect()).unwrap_or_default()
}

/// Retire this room's `.onion` and mint a different one.
///
/// Not a restart: the point is that the OLD address stops resolving. The room's
/// service is stopped, its hidden-service key is deleted from the keystore, and
/// the generation counter is bumped so the next launch derives a new nickname and
/// therefore a new identity key. Anyone holding the old address — including anyone
/// holding a never-expiring invitation that names it — is now holding nothing.
///
/// That is also what ends the HP drain: the exposure was the address remaining
/// valid, so invalidating it is the honest way to stop paying for it.
///
/// The caller re-hosts afterwards (`create_room`) to bring the room back up under
/// the new address, and revokes the invitations that named the old one.
pub async fn rotate_onion(app: &AppHandle, state: &TorP2pState, name: String) -> Result<()> {
    let room = room_for(&name);
    let next = generation_of(app, &room).saturating_add(1);
    // Delete the current key FIRST, under the current generation's nickname —
    // bumping first would leave the old key in the keystore, still able to serve
    // the old address if anything ever re-derived that nickname.
    forget_onion(app, state, name).await?;
    set_generation(app, &room, next)?;
    Ok(())
}

/// Destroy a SINGLE room's onion identity (used by "delete room"): stop that room's
/// service, then remove its nickname-keyed hidden-service keys from arti's keystore so
/// a future same-named room mints a FRESH `.onion` instead of reusing the persisted HS
/// key. Handles both a running node (live state dir) and a stopped one (the sealed
/// keystore blob). Other rooms' onions are untouched.
pub async fn forget_onion(app: &AppHandle, state: &TorP2pState, name: String) -> Result<()> {
    // Stop this room's onion service first so its keys are idle before we remove them.
    let room = room_for(&name);
    let _ = leave_room(state, &room).await;
    let nick = nickname_for_room(app, &name, &room)?.to_string();

    // The on-disk keystore only exists while the node runs; snapshot its dir if so.
    let running = {
        let guard = state.0.lock().await;
        guard.as_ref().map(|n| (n.state_dir.clone(), n.stable))
    };

    match running {
        Some((state_dir, stable)) => {
            remove_nickname_from_keystore(&state_dir, &nick);
            // Persist the removal for a stable onion, else the sealed blob would
            // restore the deleted key on the next launch.
            if stable {
                if let Ok(archive) = archive_dir(&state_dir) {
                    let _ = crate::vault::put(app, "keys", "tor_keystore", &archive);
                }
            }
        }
        None => {
            // Node down: operate on the sealed keystore blob (stable mode only —
            // ephemeral keys never persist, so there is nothing to forget). Extract to
            // a temp dir, drop the nickname subtree, re-seal, wipe the temp dir.
            if let Ok(Some(archive)) = crate::vault::get(app, "keys", "tor_keystore") {
                let tmp = std::env::temp_dir()
                    .join(format!("enigma-tor-forget-{}", uuid::Uuid::new_v4().simple()));
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

/// Remove the keystore subtree for a single HS nickname (arti stores hidden-service
/// keys under `…/hss/<nickname>/`). Recursive, mirroring `clear_lockfiles`: any
/// directory whose name equals the nickname is removed whole, wherever it sits.
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

// ── outbound: dial the captain, read, reconnect ────────────────────────────────

/// Manages this member's single outbound connection to the captain: reads relayed
/// frames, publishes the live write-half into `write` for `broadcast`, and
/// reconnects with backoff. After `MAX_CAPTAIN_RETRIES` failed dials it emits a
/// `captain_unreachable` status so the frontend can re-elect. `initial_rd` is the
/// read half of an already-established connection (from a synchronous join); when
/// `Some`, `write` must already hold that connection's write half.
#[allow(clippy::too_many_arguments)]
fn spawn_captain_manager(
    app: AppHandle,
    room: String,
    name: String,
    client: Arc<TorClient<PreferredRuntime>>,
    my_id: String,
    captain_onion: String,
    up: Arc<Mutex<Option<WriteHalf<DataStream>>>>,
    peers: Arc<Mutex<Vec<PeerConn>>>,
    mut initial_rd: Option<ReadHalf<DataStream>>,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut attempt: u32 = 0;
        loop {
            // Acquire a read half: reuse the pre-established one, else dial fresh.
            let mut rd = match initial_rd.take() {
                Some(rd) => rd,
                None => match dial_and_handshake(&client, &captain_onion, &name, &my_id).await {
                    Ok((rd, wr)) => {
                        *up.lock().await = Some(wr);
                        rd
                    }
                    Err(_) => {
                        attempt += 1;
                        if attempt > MAX_CAPTAIN_RETRIES {
                            emit_status_reason(&app, &room, "disconnected", 0, Some(captain_onion.clone()), Some("captain_unreachable"));
                            return;
                        }
                        tokio::time::sleep(captain_backoff(attempt)).await;
                        continue;
                    }
                },
            };
            attempt = 0;
            emit_status(&app, &room, "connected", 1, Some(captain_onion.clone()));
            while let Ok(payload) = read_frame(&mut rd).await {
                emit_message(&app, &room, &payload);
                // Bridge down: fan the captain's frame to our own inbound children.
                let targets: Vec<Arc<Mutex<WriteHalf<DataStream>>>> = {
                    peers.lock().await.iter().map(|c| c.write.clone()).collect()
                };
                for w in targets {
                    let mut g = w.lock().await;
                    let _ = write_frame_bounded(&mut *g, &payload).await;
                }
            }
            // Connection dropped: stop sending, then reconnect (or declare death).
            *up.lock().await = None;
            attempt += 1;
            if attempt > MAX_CAPTAIN_RETRIES {
                emit_status_reason(&app, &room, "disconnected", 0, Some(captain_onion.clone()), Some("captain_unreachable"));
                return;
            }
            tokio::time::sleep(captain_backoff(attempt)).await;
        }
    })
}

// ── host: accept + relay ───────────────────────────────────────────────────────

fn spawn_accept_loop<S>(
    app: AppHandle,
    room: String,
    rend: S,
    peers: Arc<Mutex<Vec<PeerConn>>>,
    up: Arc<Mutex<Option<WriteHalf<DataStream>>>>,
) -> JoinHandle<()>
where
    S: futures_lite::stream::Stream<Item = RendRequest> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        // Box::pin so the returned stream is Unpin for `.next()`.
        let mut streams = Box::pin(handle_rend_requests(rend));
        // Only our own members dial this service, so accept every stream request.
        while let Some(req) = streams.next().await {
            let ds = match req.accept(Connected::new_empty()).await {
                Ok(ds) => ds,
                Err(_) => continue,
            };
            let (mut rd, mut wr) = tokio::io::split(ds);
            // Handshake: read Hello, reply Ready.
            let hello = match read_frame(&mut rd).await {
                Ok(s) => match serde_json::from_str::<Hello>(&s) {
                    Ok(h) => h,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            if write_frame(&mut wr, &serde_json::to_string(&Ready { ok: true }).unwrap())
                .await
                .is_err()
            {
                continue;
            }

            // An invitation redemption borrows this onion but is not a room
            // member: it runs one request/response exchange and closes, never
            // joining `peers` and never seeing a broadcast.
            if hello.kind.as_deref() == Some("redeem") {
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    let pending = app2.state::<crate::invite_redeem::RedeemState>().inner().clone();
                    if let Err(e) =
                        crate::invite_redeem::serve_tor(&app2, &pending, &mut wr, &mut rd).await
                    {
                        eprintln!("[redeem/tor] serve ended: {e}");
                    }
                });
                continue;
            }

            let write = Arc::new(Mutex::new(wr));
            let seq = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
            let peer = PeerConn { seq, write };
            let count = {
                let mut p = peers.lock().await;
                p.push(peer);
                p.len() as u32
            };
            emit_status(&app, &room, "connected", count, Some(hello.peer_id));
            spawn_peer_reader(app.clone(), room.clone(), rd, peers.clone(), up.clone(), seq);
        }
    })
}

/// Per-dialer reader on the captain: deliver each frame locally AND fan it out to
/// the other dialers (star relay). On disconnect, drop the peer + update status.
fn spawn_peer_reader(
    app: AppHandle,
    room: String,
    mut rd: ReadHalf<DataStream>,
    peers: Arc<Mutex<Vec<PeerConn>>>,
    up: Arc<Mutex<Option<WriteHalf<DataStream>>>>,
    origin_seq: u64,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match read_frame(&mut rd).await {
                Ok(payload) => {
                    emit_message(&app, &room, &payload);
                    // Fan across to our OTHER children (never echo to the sender).
                    let targets: Vec<Arc<Mutex<WriteHalf<DataStream>>>> = {
                        let p = peers.lock().await;
                        p.iter().filter(|c| c.seq != origin_seq).map(|c| c.write.clone()).collect()
                    };
                    for w in targets {
                        let mut g = w.lock().await;
                        let _ = write_frame_bounded(&mut *g, &payload).await;
                    }
                    // Bridge up: if we are a relay hop (not the captain), forward the
                    // child's frame to our own parent so it reaches the real captain.
                    let mut g = up.lock().await;
                    if let Some(w) = g.as_mut() {
                        let _ = write_frame_bounded(w, &payload).await;
                    }
                }
                Err(_) => break,
            }
        }
        let count = {
            let mut p = peers.lock().await;
            if let Some(i) = p.iter().position(|c| c.seq == origin_seq) {
                p.remove(i);
            }
            p.len() as u32
        };
        let st = if count > 0 { "connected" } else { "disconnected" };
        emit_status(&app, &room, st, count, None);
    });
}

// ── events (identical shape to p2p_iroh.rs, plus an optional `reason`) ──────────

fn emit_message(app: &AppHandle, room: &str, payload: &str) {
    let _ = app.emit("realtime://message", serde_json::json!({ "room": room, "payload": payload }));
}

fn emit_status(app: &AppHandle, room: &str, state: &str, peers: u32, peer_id: Option<String>) {
    emit_status_reason(app, room, state, peers, peer_id, None);
}

/// Like `emit_status` but carries an optional `reason` (e.g. `captain_unreachable`)
/// so the frontend can distinguish a captain-death from an ordinary disconnect.
fn emit_status_reason(
    app: &AppHandle,
    room: &str,
    state: &str,
    peers: u32,
    peer_id: Option<String>,
    reason: Option<&str>,
) {
    let _ = app.emit(
        "realtime://status",
        serde_json::json!({ "room": room, "state": state, "peers": peers, "peer_id": peer_id, "reason": reason }),
    );
}

#[cfg(test)]
mod hello_compat_tests {
    use super::*;

    // `Hello` gained a `kind` field so one onion can carry both room traffic and
    // invitation redemptions. That is a WIRE change, so both directions of
    // compatibility are pinned here.

    #[test]
    fn a_hello_from_an_older_peer_still_parses() {
        // No `kind` at all — every build that predates invitations.
        let old: Hello = serde_json::from_str(r#"{"name":"alice","peer_id":"abc"}"#).unwrap();
        assert_eq!(old.name, "alice");
        assert_eq!(old.kind, None);
    }

    #[test]
    fn a_room_hello_is_byte_identical_to_what_older_peers_expect() {
        // `skip_serializing_if` keeps the field off the wire entirely for room
        // dials, so an older peer sees exactly the frame it always saw.
        let room = Hello { name: "alice".into(), peer_id: "abc".into(), kind: None };
        assert_eq!(serde_json::to_string(&room).unwrap(), r#"{"name":"alice","peer_id":"abc"}"#);
    }

    #[test]
    fn a_redeem_hello_declares_itself() {
        let redeem = Hello { name: String::new(), peer_id: "abc".into(), kind: Some("redeem".into()) };
        let text = serde_json::to_string(&redeem).unwrap();
        assert!(text.contains(r#""kind":"redeem""#));
        let back: Hello = serde_json::from_str(&text).unwrap();
        assert_eq!(back.kind.as_deref(), Some("redeem"));
    }

    #[test]
    fn an_unknown_kind_is_treated_as_room_traffic() {
        // Forward compatibility: a future kind this build does not know must not
        // be routed to the redeem handler, and must not drop the connection.
        let future: Hello =
            serde_json::from_str(r#"{"name":"a","peer_id":"b","kind":"something-new"}"#).unwrap();
        assert_ne!(future.kind.as_deref(), Some("redeem"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;




    #[test]
    fn room_and_nickname_are_deterministic() {
        assert_eq!(room_for("room-a"), room_for("room-a"));
        assert_ne!(room_for("room-a"), room_for("room-b"));
        let n1 = nickname_for_gen("room-a", 0).unwrap();
        let n2 = nickname_for_gen("room-a", 0).unwrap();
        assert_eq!(n1.to_string(), n2.to_string());
    }

    #[test]
    fn captain_backoff_grows_then_caps() {
        assert_eq!(captain_backoff(1), Duration::from_secs(2));
        assert_eq!(captain_backoff(2), Duration::from_secs(4));
        assert_eq!(captain_backoff(3), Duration::from_secs(8));
        assert_eq!(captain_backoff(9), Duration::from_secs(15)); // capped
    }

    #[tokio::test]
    async fn frame_round_trips_through_a_buffer() {
        let payload = r#"{"type":"mls_app","cipher":"…"}"#;
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, payload).await.unwrap();
        // Trailing bytes after a frame must be ignored by the reader.
        buf.extend_from_slice(b"leftover");

        let mut cursor = std::io::Cursor::new(buf);
        let got = read_frame(&mut cursor).await.unwrap();
        assert_eq!(got, payload);
    }

    // Regression test for "tor bootstrap failed: problem with filesystem
    // permissions": a group/other-writable state dir must be accepted once we relax
    // arti's fs-mistrust with `dangerously_trust_everyone` (the create-room fix).
    #[cfg(unix)]
    #[test]
    fn relaxed_permissions_accept_a_loose_state_dir() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("enigma_tor_perm_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();

        // Default arti mistrust rejects a world-writable dir (this is the crash).
        let strict = TorClientConfigBuilder::from_directories(&dir, &dir).build().unwrap();
        assert!(
            strict.fs_mistrust().check_directory(&dir).is_err(),
            "default mistrust should reject a 0777 dir"
        );

        // With the relaxation applied in `ensure_started`, the same dir is accepted.
        let mut relaxed = TorClientConfigBuilder::from_directories(&dir, &dir);
        relaxed.storage().permissions().dangerously_trust_everyone();
        let relaxed = relaxed.build().unwrap();
        assert!(
            relaxed.fs_mistrust().check_directory(&dir).is_ok(),
            "relaxed mistrust should accept the dir (create-room fix)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_frame_rejects_oversized_length() {
        // A length prefix above MAX_FRAME must be rejected without allocating it.
        let mut buf = ((MAX_FRAME as u32) + 1).to_le_bytes().to_vec();
        buf.extend_from_slice(b"body");
        let mut cursor = std::io::Cursor::new(buf);
        assert!(read_frame(&mut cursor).await.is_err());
    }
}
