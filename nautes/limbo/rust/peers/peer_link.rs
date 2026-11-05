// Peer links — scoped, revocable person-to-person sync (peer.md).
//
// The handshake is a request/accept exchange over a dedicated ALPN on the MAIN
// p2p endpoint (the stable NodeId contacts already store), mirroring
// p2p_invite.rs: dial the peer, describe what you want and what you offer, and
// wait for their explicit answer. The QUIC connection is E2E-encrypted and
// mutually authenticated by NodeId, so the accepter knows exactly which contact
// is asking.
//
// Flow (requester R → peer A):
//   R: `peer_request` → connect(A, PEER_ALPN) → bi stream →
//      PlinkRequest { from_name, want, give }        ← DESCRIPTION ONLY
//   A: handler emits `plink://request` and parks the answer on a oneshot; the
//      Peers UI shows the scopes + the safety number; `peer_respond` resolves it
//      and chooses what A actually grants (A may grant less than R asked for)
//   A→R: PlinkVerdict { status, name, give }
//   R→A: PlinkSeal { link_key, room }                ← ONLY AFTER ACCEPT
//   A→R: 1-byte ack
//
// The ordering above is the point. p2p_invite sends the room ticket in its
// FIRST frame — before the human answers — so declining does not un-send it.
// Here the pairwise link key is minted and disclosed only once the accepter has
// said yes, so a declined (or ignored) request leaks nothing but the fact that
// somebody asked.
//
// Both sides then persist a PeerGrant (sealed kv `peers/<nodeId>/""`, shape
// mirrored field-for-field in rakotis peerSyncModel.ts) and rakotis usePeerSync
// takes over: a headless MLS channel in the hidden room derived from the link
// key, converging only the granted scopes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointId, SecretKey};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex};

use crate::file_xfer::OFFLINE_BLOCKED;
use crate::{active_config, load_profile_state, AppConfigState};

pub(crate) const PEER_ALPN: &[u8] = b"enigma/plink/0";
const PLINK_VERSION: u8 = 1;

pub(crate) const PEERS_DISABLED: &str = "Peer sync is disabled in this build.";
const TOR_BLOCKED: &str = "Peer sync is unavailable in Tor mode.";
const VAULT_LOCKED: &str = "Unlock this profile before syncing with a peer.";

/// Handshake frames are descriptions and keys — never bulk data.
const CONTROL_FRAME_MAX: usize = 64 * 1024;

/// Mirrors peerSyncModel `PEER_SCOPES` — a pinning test on each side keeps the
/// two from drifting. An unknown scope string is dropped, never stored.
pub(crate) const PEER_SCOPES: &[&str] = &["calendar", "history", "board", "card"];
/// Mirrors peerSyncModel `PEER_LINK_MAX`.
const PEER_LINK_MAX: usize = 8;

const NS_PEERS: &str = "peers";
const KEY_GRANT: &str = "";
/// kv has no key enumeration by design (the `p2p:rooms` precedent), so the set
/// of linked peers is kept as an explicit index. Scope "index" can never collide
/// with a NodeId (52-char z-base-32).
const SCOPE_INDEX: &str = "index";

// ── policy gates ─────────────────────────────────────────────────────────────

fn offline(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg)))
}

fn use_tor(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_use_tor(&load_profile_state(app, &cfg)))
}

/// Compile-time feature gate. A peers-off edition never registers the ALPN
/// either (p2p_iroh), so this only backstops a frontend that asks anyway.
fn ensure_peers_enabled() -> Result<(), String> {
    if !crate::build_config::peers::ENABLED {
        return Err(PEERS_DISABLED.to_string());
    }
    Ok(())
}

fn check_policy(app: &AppHandle, config: &State<'_, AppConfigState>) -> Result<(), String> {
    ensure_peers_enabled()?;
    if offline(app, config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    // Tor is exclusive: a peer dial would ride iroh and leak the IP.
    if use_tor(app, config) {
        return Err(TOR_BLOCKED.to_string());
    }
    Ok(())
}

fn ensure_unlocked(app: &AppHandle) -> Result<(), String> {
    let st = app
        .try_state::<crate::vault::ProtasiusState>()
        .ok_or_else(|| VAULT_LOCKED.to_string())?;
    let unlocked = st.0.lock().map_err(|e| e.to_string())?.status().unlocked;
    if unlocked { Ok(()) } else { Err(VAULT_LOCKED.to_string()) }
}

// ── derivations ──────────────────────────────────────────────────────────────

/// The hidden link room: unguessable without the pairwise key. Same shape as
/// devlink's, under its own domain-separation label so the two families can
/// never derive into each other.
fn plink_room_name(link_key: &[u8; 32]) -> String {
    let hash = blake3::derive_key("enigma/plink/v1/room", link_key);
    format!("plink-{}", data_encoding::HEXLOWER.encode(&hash))
}

/// 16-digit fingerprint of the two NodeIds, for out-of-band comparison. Sorted
/// so both sides render the identical string, and derived from the identities
/// alone (NOT the link key) so it can be shown in the request dialog — before
/// any key exists. Displayed, never enforced (peer.md P7).
pub(crate) fn safety_number(a: &str, b: &str) -> String {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let hash = blake3::derive_key("enigma/plink/v1/sas", format!("{lo}\0{hi}").as_bytes());
    let mut out = String::with_capacity(16);
    for byte in hash.iter().take(8) {
        out.push_str(&format!("{:02}", byte % 100));
    }
    out
}

fn random_bytes32() -> [u8; 32] {
    // iroh's key generation is the vetted entropy source already linked in.
    SecretKey::generate().to_bytes()
}

/// Keep only scopes this build understands, deduped and in canonical order —
/// the Rust half of "never trust a wire object".
fn sanitize_scopes(raw: &[String]) -> Vec<String> {
    PEER_SCOPES
        .iter()
        .filter(|s| raw.iter().any(|r| r == *s))
        .map(|s| s.to_string())
        .collect()
}

// ── wire frames (length-prefixed JSON, p2p_invite framing) ───────────────────

#[derive(Serialize, Deserialize)]
struct PlinkRequest {
    v: u8,
    from_name: String,
    /// Scopes the requester asks the peer to share.
    want: Vec<String>,
    /// Scopes the requester offers to share back.
    give: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct PlinkVerdict {
    v: u8,
    /// "accept" | "reject"
    status: String,
    name: String,
    /// What the accepter actually grants — may be less than `want`.
    give: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct PlinkSeal {
    v: u8,
    /// base64, 32 bytes — minted by the requester, disclosed only after accept.
    link_key: String,
    room: String,
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
    if n > CONTROL_FRAME_MAX {
        return Err(anyhow!("control frame too large"));
    }
    let mut body = vec![0u8; n];
    recv.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

// ── grant storage (shape mirrors peerSyncModel PeerGrant) ────────────────────

#[allow(clippy::too_many_arguments)]
fn write_grant(
    app: &AppHandle,
    peer_node_id: &str,
    peer_name: &str,
    link_key: &str,
    room: &str,
    my_scopes: &[String],
    their_scopes: &[String],
    initiator: bool,
    my_node_id: &str,
) -> Result<serde_json::Value, String> {
    // Preserve the revision across a re-request so a peer holding an older copy
    // can tell it is behind.
    let prev_rev = crate::vault::kv_get_raw(app, NS_PEERS, peer_node_id, KEY_GRANT)
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("rev").and_then(|r| r.as_u64()))
        .unwrap_or(0);
    let grant = serde_json::json!({
        "v": PLINK_VERSION,
        "peerNodeId": peer_node_id,
        "peerName": peer_name,
        "linkKey": link_key,
        "roomName": room,
        "safetyNumber": safety_number(my_node_id, peer_node_id),
        "myScopes": my_scopes,
        "theirScopes": their_scopes,
        "initiator": initiator,
        "createdAt": now_millis(),
        "rev": prev_rev + 1,
    });
    crate::vault::kv_put_raw(app, NS_PEERS, peer_node_id, KEY_GRANT, &grant.to_string())?;
    add_to_index(app, peer_node_id)?;
    Ok(grant)
}

fn load_index(app: &AppHandle) -> Vec<String> {
    crate::vault::kv_get_raw(app, NS_PEERS, SCOPE_INDEX, KEY_GRANT)
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn add_to_index(app: &AppHandle, peer_node_id: &str) -> Result<(), String> {
    let mut index = load_index(app);
    if index.iter().any(|n| n == peer_node_id) {
        return Ok(());
    }
    index.push(peer_node_id.to_string());
    let json = serde_json::to_string(&index).map_err(|e| e.to_string())?;
    crate::vault::kv_put_raw(app, NS_PEERS, SCOPE_INDEX, KEY_GRANT, &json)
}

/// Live (non-tombstoned) links. Used for the PEER_LINK_MAX rail — each link
/// owns a headless MLS channel, so the cap is a real resource limit.
fn live_link_count(app: &AppHandle, excluding: &str) -> usize {
    load_index(app)
        .into_iter()
        .filter(|n| n != excluding)
        .filter(|n| {
            crate::vault::kv_get_raw(app, NS_PEERS, n, KEY_GRANT)
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .map(|v| v.get("revokedAt").is_none() || v["revokedAt"].is_null())
                .unwrap_or(false)
        })
        .count()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── inbound (the accepter side) ──────────────────────────────────────────────

/// Pending incoming requests awaiting the user's Accept/Decline, keyed by
/// request id. Managed state — the protocol handler and `peer_respond` must
/// share the same map. The answer carries the granted scopes, so unlike the
/// invite handshake's single byte it cannot be reduced to a bool.
#[derive(Default, Clone)]
pub struct PeerLinkState(pub Arc<Mutex<HashMap<String, oneshot::Sender<Option<Answer>>>>>);

/// What the accepter's UI sends back: the scopes actually granted, plus the
/// display name to introduce ourselves with (the name lives in profile state,
/// which the protocol handler has no `AppConfigState` to read).
#[derive(Debug, Clone)]
pub struct Answer {
    pub give: Vec<String>,
    pub name: String,
}

#[derive(Clone)]
pub struct PeerProtocol {
    app: AppHandle,
    pending: PeerLinkState,
    /// Our own NodeId — the safety number needs both ends, and a protocol
    /// handler has no endpoint of its own (it is registered onto one).
    my_node_id: String,
}

impl std::fmt::Debug for PeerProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PeerProtocol")
    }
}

impl PeerProtocol {
    pub fn new(app: AppHandle, pending: PeerLinkState, my_node_id: String) -> Self {
        Self { app, pending, my_node_id }
    }

    async fn serve(self, conn: Connection) -> Result<()> {
        // Authenticated by the QUIC handshake — this is who is really asking.
        let from = conn.remote_id().to_string();
        let me = self.my_node_id.clone();
        let (mut send, mut recv) = conn.accept_bi().await?;
        let request: PlinkRequest = read_frame(&mut recv).await?;
        if request.v != PLINK_VERSION {
            return Err(anyhow!("unknown peer-link version {}", request.v));
        }
        let want = sanitize_scopes(&request.want);
        let offered = sanitize_scopes(&request.give);

        // A link we already hold does not consume a new slot; a genuinely new
        // peer does. Refuse past the cap rather than starve the channel pool.
        if live_link_count(&self.app, &from) >= PEER_LINK_MAX {
            let _ = write_frame(
                &mut send,
                &PlinkVerdict {
                    v: PLINK_VERSION,
                    status: "reject".into(),
                    name: String::new(),
                    give: vec![],
                },
            )
            .await;
            let _ = send.finish();
            return Ok(());
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Option<Answer>>();
        self.pending.0.lock().await.insert(request_id.clone(), tx);
        let _ = self.app.emit(
            "plink://request",
            serde_json::json!({
                "requestId": request_id,
                "fromNodeId": from,
                "fromName": request.from_name,
                "want": want,
                "offered": offered,
                "safetyNumber": safety_number(&me, &from),
            }),
        );

        // Decision window = the user-set connect timeout (never a literal); the
        // requester waits 2× this, so an answer at the buzzer still lands.
        let window = Duration::from_secs(crate::p2p_dht::connect_timeout_secs(&self.app));
        let answer = match tokio::time::timeout(window, rx).await {
            Ok(Ok(Some(a))) => Some((sanitize_scopes(&a.give), a.name)),
            _ => None,
        };
        self.pending.0.lock().await.remove(&request_id);
        let _ = self
            .app
            .emit("plink://resolved", serde_json::json!({ "requestId": request_id }));

        let Some((granted, my_name)) = answer else {
            write_frame(
                &mut send,
                &PlinkVerdict {
                    v: PLINK_VERSION,
                    status: "reject".into(),
                    name: String::new(),
                    give: vec![],
                },
            )
            .await?;
            let _ = send.finish();
            return Ok(());
        };

        write_frame(
            &mut send,
            &PlinkVerdict {
                v: PLINK_VERSION,
                status: "accept".into(),
                name: my_name,
                give: granted.clone(),
            },
        )
        .await?;

        // Only now does the key exist on this side. Bound the wait: the human
        // already answered, so a requester that dies here must not park this
        // task (and its pending-map slot) on QUIC's idle timeout alone.
        let seal: PlinkSeal = tokio::time::timeout(
            Duration::from_secs(crate::p2p_dht::connect_timeout_secs(&self.app)),
            read_frame(&mut recv),
        )
        .await
        .map_err(|_| anyhow!("requester never sent the link key"))??;
        if seal.v != PLINK_VERSION {
            return Err(anyhow!("unknown seal version {}", seal.v));
        }
        let key_bytes = data_encoding::BASE64
            .decode(seal.link_key.as_bytes())
            .map_err(|e| anyhow!("invalid link key: {e}"))?;
        let key: [u8; 32] = key_bytes
            .try_into()
            .map_err(|_| anyhow!("link key must be 32 bytes"))?;
        // Derive the room ourselves rather than trusting the requester's string:
        // a mismatched `room` means a malformed or hostile peer.
        let room = plink_room_name(&key);
        if room != seal.room {
            return Err(anyhow!("link room does not match the link key"));
        }

        let grant = write_grant(
            &self.app,
            &from,
            &request.from_name,
            &seal.link_key,
            &room,
            &granted,
            &offered,
            false,
            &me,
        )
        .map_err(|e| anyhow!(e))?;

        let _ = send.write_all(&[1u8]).await;
        let _ = send.finish();
        let _ = self.app.emit("plink://linked", grant);
        Ok(())
    }
}

impl ProtocolHandler for PeerProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        if let Err(e) = self.clone().serve(conn).await {
            eprintln!("[plink] serve ended: {e}");
        }
        Ok(())
    }
}

// ── outbound (the requester side) ────────────────────────────────────────────

/// Ask a peer for a scoped sync link. `Ok(Some(grant))` = accepted (the grant is
/// already persisted), `Ok(None)` = declined; errors mean unreachable or no
/// answer inside the window.
pub async fn request(
    app: &AppHandle,
    endpoint: Endpoint,
    node_id: &str,
    from_name: String,
    want: Vec<String>,
    give: Vec<String>,
) -> Result<Option<serde_json::Value>> {
    let id: EndpointId = node_id.parse().map_err(|_| anyhow!("invalid contact code"))?;
    let me = endpoint.id().to_string();
    let want = sanitize_scopes(&want);
    let give = sanitize_scopes(&give);
    if want.is_empty() && give.is_empty() {
        return Err(anyhow!("a sync request must name at least one scope"));
    }
    if live_link_count(app, node_id) >= PEER_LINK_MAX {
        return Err(anyhow!("too many peer links ({PEER_LINK_MAX} max) — revoke one first"));
    }

    // 2×N: N for the dial, N for the peer's human decision window (which is N on
    // their side) — the same shape as the invite handshake.
    let window = Duration::from_secs(2 * crate::p2p_dht::connect_timeout_secs(app));
    let app = app.clone();
    let peer = node_id.to_string();
    let exchange = async move {
        let conn = endpoint
            .connect(id, PEER_ALPN)
            .await
            .map_err(|e| anyhow!("peer unreachable: {e}"))?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| anyhow!("open stream: {e}"))?;
        write_frame(
            &mut send,
            &PlinkRequest { v: PLINK_VERSION, from_name, want: want.clone(), give: give.clone() },
        )
        .await?;

        let verdict: PlinkVerdict = read_frame(&mut recv).await?;
        if verdict.v != PLINK_VERSION {
            return Err(anyhow!("unknown verdict version {}", verdict.v));
        }
        if verdict.status != "accept" {
            return Ok(None);
        }
        let granted = sanitize_scopes(&verdict.give);

        // Accepted: mint the pairwise key and disclose it. Nothing above this
        // line revealed anything a decline would have had to take back.
        let key = random_bytes32();
        let link_key = data_encoding::BASE64.encode(&key);
        let room = plink_room_name(&key);
        write_frame(
            &mut send,
            &PlinkSeal { v: PLINK_VERSION, link_key: link_key.clone(), room: room.clone() },
        )
        .await?;
        let mut ack = [0u8; 1];
        recv.read_exact(&mut ack)
            .await
            .map_err(|e| anyhow!("peer did not confirm the link: {e}"))?;
        let _ = send.finish();

        let grant = write_grant(
            &app, &peer, &verdict.name, &link_key, &room, &give, &granted, true, &me,
        )
        .map_err(|e| anyhow!(e))?;
        Ok::<Option<serde_json::Value>, anyhow::Error>(Some(grant))
    };
    match tokio::time::timeout(window, exchange).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("no answer in time")),
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Ask a contact for a scoped sync link. Returns the stored grant on accept,
/// `null` on decline.
#[tauri::command]
pub async fn peer_request(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, crate::p2p_iroh::P2pState>,
    node_id: String,
    from_name: String,
    want: Vec<String>,
    give: Vec<String>,
) -> Result<Option<serde_json::Value>, String> {
    check_policy(&app, &config)?;
    ensure_unlocked(&app)?;
    // The peer ALPN rides the main endpoint, exactly like invites and vox.
    let endpoint = crate::p2p_iroh::vox_endpoint(&app, &p2p, None)
        .await
        .map_err(|e| e.to_string())?;
    request(&app, endpoint, &node_id, from_name, want, give)
        .await
        .map_err(|e| e.to_string())
}

/// Answer a pending request. `accept: false` (or a missing id — the window
/// lapsed, or a duplicate click) declines; `give` is what we actually grant.
#[tauri::command]
pub async fn peer_respond(
    pending: State<'_, PeerLinkState>,
    request_id: String,
    accept: bool,
    give: Vec<String>,
    name: String,
) -> Result<(), String> {
    ensure_peers_enabled()?;
    if let Some(tx) = pending.0.lock().await.remove(&request_id) {
        let _ = tx.send(if accept { Some(Answer { give, name }) } else { None });
    }
    Ok(())
}

#[derive(Serialize)]
pub struct PeerLinkStatus {
    enabled: bool,
    link_count: u32,
    max_links: u32,
    node_ids: Vec<String>,
}

/// The linked-peer index (kv has no enumeration, so this is the source of
/// truth for "who am I linked with").
#[tauri::command]
pub fn peer_status(app: AppHandle) -> PeerLinkStatus {
    let enabled = crate::build_config::peers::ENABLED;
    let node_ids = if enabled { load_index(&app) } else { vec![] };
    PeerLinkStatus {
        enabled,
        link_count: live_link_count(&app, "") as u32,
        max_links: PEER_LINK_MAX as u32,
        node_ids,
    }
}

/// The safety number for a peer — same 16 digits both sides compute, so the
/// Peers UI can show it outside a live handshake too.
#[tauri::command]
pub async fn peer_safety_number(
    app: AppHandle,
    p2p: State<'_, crate::p2p_iroh::P2pState>,
    node_id: String,
) -> Result<String, String> {
    ensure_peers_enabled()?;
    let endpoint = crate::p2p_iroh::vox_endpoint(&app, &p2p, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(safety_number(&endpoint.id().to_string(), &node_id))
}

/// Drop a revoked link's stored mirrors and index entry. The grant tombstone
/// itself is written by the frontend (which also performs the MLS eviction);
/// this only reclaims the storage once nothing needs it.
#[tauri::command]
pub fn peer_forget(app: AppHandle, node_id: String) -> Result<(), String> {
    ensure_peers_enabled()?;
    for ns in ["peer:cal", "peer:board", "peer:card"] {
        let _ = crate::vault::kv_put_raw(&app, ns, &node_id, "", "");
    }
    let index: Vec<String> = load_index(&app).into_iter().filter(|n| *n != node_id).collect();
    let json = serde_json::to_string(&index).map_err(|e| e.to_string())?;
    crate::vault::kv_put_raw(&app, NS_PEERS, SCOPE_INDEX, KEY_GRANT, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_frame_round_trips_with_length_prefix() {
        let payload = PlinkRequest {
            v: PLINK_VERSION,
            from_name: "alice".into(),
            want: vec!["calendar".into(), "history".into()],
            give: vec!["card".into()],
        };
        let framed = frame_bytes(&payload);
        let len = u32::from_le_bytes(framed[..4].try_into().unwrap()) as usize;
        assert_eq!(len, framed.len() - 4);

        let decoded: PlinkRequest = serde_json::from_slice(&framed[4..]).expect("decode body");
        assert_eq!(decoded.from_name, "alice");
        assert_eq!(decoded.want, vec!["calendar", "history"]);
        assert_eq!(decoded.give, vec!["card"]);
    }

    #[test]
    fn safety_number_is_symmetric_stable_and_16_digits() {
        let a = "node-alice";
        let b = "node-bob";
        let sas = safety_number(a, b);
        assert_eq!(sas.len(), 16);
        assert!(sas.chars().all(|c| c.is_ascii_digit()));
        // Both sides compute the same string regardless of argument order.
        assert_eq!(sas, safety_number(b, a));
        // And a different pair yields a different number.
        assert_ne!(sas, safety_number(a, "node-carol"));
    }

    #[test]
    fn plink_room_name_is_stable_prefixed_and_key_bound() {
        let key = [7u8; 32];
        let room = plink_room_name(&key);
        assert!(room.starts_with("plink-"));
        assert_eq!(room.len(), "plink-".len() + 64);
        assert_eq!(room, plink_room_name(&key));
        assert_ne!(room, plink_room_name(&[8u8; 32]));
    }

    #[test]
    fn plink_and_devlink_rooms_never_collide_for_the_same_key() {
        // Domain separation: the two families share blake3 but not their label,
        // so one key can never derive into the other's room.
        let key = [3u8; 32];
        let devlink = data_encoding::HEXLOWER
            .encode(&blake3::derive_key("enigma/devlink/v1/room", &key));
        assert_ne!(plink_room_name(&key).trim_start_matches("plink-"), devlink);
    }

    #[test]
    fn sanitize_scopes_drops_unknowns_and_dedupes_into_canonical_order() {
        let raw = vec![
            "history".to_string(),
            "nonsense".to_string(),
            "calendar".to_string(),
            "history".to_string(),
        ];
        // Canonical order is PEER_SCOPES order, not the caller's.
        assert_eq!(sanitize_scopes(&raw), vec!["calendar", "history"]);
        assert!(sanitize_scopes(&["../../etc/passwd".to_string()]).is_empty());
    }

    #[test]
    fn scope_list_matches_the_typescript_model() {
        // Pinning test — peerSyncModel.ts PEER_SCOPES must stay identical.
        assert_eq!(PEER_SCOPES, &["calendar", "history", "board", "card"]);
    }

    #[test]
    fn verdict_round_trips_a_narrowed_grant() {
        // The accepter granting LESS than was asked must survive the wire.
        let v = PlinkVerdict {
            v: PLINK_VERSION,
            status: "accept".into(),
            name: "bob".into(),
            give: vec!["card".into()],
        };
        let framed = frame_bytes(&v);
        let decoded: PlinkVerdict = serde_json::from_slice(&framed[4..]).expect("decode");
        assert_eq!(decoded.status, "accept");
        assert_eq!(decoded.give, vec!["card"]);
    }
}
