// Rust-owned realtime gateway — dispatches to the active P2P transport.
//
// The frontend calls the `realtime_*` commands and listens to the
// `realtime://message` / `realtime://status` events; it never learns which
// transport is used. There are two backends:
//   - p2p_iroh.rs — iroh-gossip over QUIC (the default).
//   - p2p_tor.rs  — peer-hosted Tor onion services (when the `use_tor` switch is
//     on). Tor is EXCLUSIVE: while on, rooms are created/sent over Tor, not iroh.
// Both emit the same events, so the command names + TS `chatTransport` call sites
// are unchanged. Joining routes by the ticket itself (a Tor ticket is tagged), so
// a scanned ticket reaches the right backend regardless of the switch.

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::p2p_iroh::{self, P2pState};
use crate::p2p_tor::{self, TorP2pState};
use crate::{active_config, load_profile_state, AppConfigState};

const OFFLINE_BLOCKED: &str = "Offline — all network connections are blocked.";

/// Airplane mode: true when the offline switch is on (blocks all P2P networking).
fn offline(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg)))
}

/// True when this profile routes over the Tor onion transport instead of iroh.
fn use_tor(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_use_tor(&load_profile_state(app, &cfg)))
}

#[tauri::command]
pub async fn realtime_send(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    tor: State<'_, TorP2pState>,
    room: Option<String>,
    payload: String,
) -> Result<(), String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let room = room.ok_or_else(|| "realtime: room is required".to_string())?;
    // Route by which transport actually owns the room, not the switch: a room
    // joined from a ticket may be on the other transport than the switch selects.
    if p2p_tor::has_room(&tor, &room).await {
        p2p_tor::broadcast(&tor, &room, payload).await.map_err(|e| e.to_string())
    } else {
        p2p_iroh::broadcast(&p2p, &room, payload).await.map_err(|e| e.to_string())
    }
}

// ── P2P room commands ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CreatedRoom {
    room: String,
    name: String,
    ticket: String,
    /// This member's own onion (Tor rooms) — announced over presence so peers can
    /// dial us if we're elected captain. Empty for iroh rooms.
    onion: String,
    /// Ticketless-join room code (DHT rendezvous — dht.md). Empty while the DHT
    /// discovery toggle is off, and for Tor rooms.
    code: String,
}

#[derive(Serialize)]
pub struct JoinedRoom {
    room: String,
    name: String,
    /// This member's own onion (Tor rooms); empty for iroh. See `CreatedRoom`.
    onion: String,
}

#[tauri::command]
pub async fn realtime_create_room(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    tor: State<'_, TorP2pState>,
    name: String,
) -> Result<CreatedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let (room, ticket, onion, code) = if use_tor(&app, &config) {
        let (room, ticket, onion) =
            p2p_tor::create_room(&app, &tor, name.clone()).await.map_err(|e| e.to_string())?;
        (room, ticket, onion, String::new())
    } else {
        let (room, ticket, code) =
            p2p_iroh::create_room(&app, &p2p, name.clone()).await.map_err(|e| e.to_string())?;
        (room, ticket, String::new(), code.unwrap_or_default())
    };
    Ok(CreatedRoom { room, name, ticket, onion, code })
}

/// Join by ticket. Routing is decided by the ticket itself (a Tor ticket is
/// tagged), so a scanned QR reaches the right backend regardless of the switch.
/// `peer_node_ids` seeds the iroh bootstrap with persisted peers (ignored by Tor).
#[tauri::command]
pub async fn realtime_join_room(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    tor: State<'_, TorP2pState>,
    ticket: String,
    peer_node_ids: Option<Vec<String>>,
) -> Result<JoinedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let (room, name, onion) = if p2p_iroh::code_is_dht(&ticket) {
        // DHT room code (ticketless join) — same field, routed by its tag byte.
        let (room, name) =
            p2p_iroh::join_room_by_code(&app, &p2p, ticket).await.map_err(|e| e.to_string())?;
        (room, name, String::new())
    } else if p2p_tor::ticket_is_tor(&ticket) {
        p2p_tor::join_room(&app, &tor, ticket, peer_node_ids.unwrap_or_default())
            .await
            .map_err(|e| e.to_string())?
    } else {
        let (room, name) = p2p_iroh::join_room(&app, &p2p, ticket, peer_node_ids.unwrap_or_default())
            .await
            .map_err(|e| e.to_string())?;
        (room, name, String::new())
    };
    Ok(JoinedRoom { room, name, onion })
}

/// Reconnect to a room by name + peers — no ticket. For iroh this re-subscribes
/// from persisted NodeIds; for Tor this re-hosts (same nickname ⇒ same onion).
#[tauri::command]
pub async fn realtime_join_room_by_node(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    tor: State<'_, TorP2pState>,
    name: String,
    peer_node_ids: Vec<String>,
) -> Result<JoinedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let room = if use_tor(&app, &config) {
        p2p_tor::join_room_by_node(&app, &tor, name.clone(), peer_node_ids)
            .await
            .map_err(|e| e.to_string())?
    } else {
        p2p_iroh::join_room_by_node(&app, &p2p, name.clone(), peer_node_ids)
            .await
            .map_err(|e| e.to_string())?
    };
    // Reconnect-by-name doesn't surface an onion; the Tor reopen paths that need it
    // (host re-create / joiner re-dial-by-ticket) go through create/join instead.
    Ok(JoinedRoom { room, name, onion: String::new() })
}

#[tauri::command]
pub async fn realtime_leave_room(
    p2p: State<'_, P2pState>,
    tor: State<'_, TorP2pState>,
    room: String,
) -> Result<(), String> {
    // Leave in whichever transport owns the room (both are no-ops if absent).
    let _ = p2p_iroh::leave_room(&p2p, &room).await;
    let _ = p2p_tor::leave_room(&tor, &room).await;
    Ok(())
}

/// Cancel an in-flight Tor join (the join modal's "Cancel" button). Aborts the
/// hanging onion-launch/dial so it releases arti's keystore lock, letting the user
/// retry without a "local resource … already in use" error. No-op for iroh joins
/// (and when nothing is joining), so it is safe to call unconditionally.
#[tauri::command]
pub async fn realtime_cancel_join(tor: State<'_, TorP2pState>) -> Result<(), String> {
    p2p_tor::cancel_join(&tor).await;
    Ok(())
}

/// Destroy a room's onion identity (part of "delete room" for a Tor room): stops the
/// room's onion service and removes its hidden-service keys so a future same-named
/// room mints a fresh `.onion`. No-op for a room this device never hosted over Tor.
#[tauri::command]
pub async fn realtime_forget_tor_onion(
    app: AppHandle,
    tor: State<'_, TorP2pState>,
    name: String,
) -> Result<(), String> {
    p2p_tor::forget_onion(&app, &tor, name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn realtime_node_info(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    tor: State<'_, TorP2pState>,
) -> Result<serde_json::Value, String> {
    // node_info starts the iroh endpoint (relay connection + discovery publish),
    // so airplane mode must gate it like every other network-touching command.
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let node_id = if use_tor(&app, &config) {
        p2p_tor::node_info(&app, &tor).await.map_err(|e| e.to_string())?
    } else {
        p2p_iroh::node_info(&app, &p2p).await.map_err(|e| e.to_string())?
    };
    Ok(json!({ "node_id": node_id }))
}

// ── Direct room invites (`invite_*` family — see p2p_invite.rs) ─────────────────

/// Offer a room directly to a contact (by NodeId) and wait for their answer:
/// `"accepted"` or `"declined"`. Unreachable / unanswered invites surface as
/// errors. The frontend opens the room first (MLS admission needs a live member).
#[tauri::command]
pub async fn invite_send(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    node_id: String,
    room: String,
    name: String,
) -> Result<String, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    // Tor is exclusive: an invite would dial over iroh.
    if use_tor(&app, &config) {
        return Err("Direct invites are unavailable while Tor mode is on.".to_string());
    }
    let accepted = p2p_iroh::invite_send(&app, &p2p, &node_id, &room, &name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(if accepted { "accepted" } else { "declined" }.to_string())
}

// ── DHT discovery commands (`dht_*` family — see dht.md) ────────────────────────

#[derive(Serialize)]
pub struct DhtStatus {
    enabled: bool,
    /// The iroh node is up with a DHT handle. False = blocked from starting
    /// (offline / Tor mode) or the Mainline UDP bind failed.
    running: bool,
    bootstrapped: bool,
}

/// Status probe for Settings/Contacts: is the toggle on, is the node running,
/// and does our Mainline node have a live routing table. May lazily start the
/// node (like any room command) — but never in airplane or Tor mode.
#[tauri::command]
pub async fn dht_status(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
) -> Result<DhtStatus, String> {
    let may_start = !offline(&app, &config) && !use_tor(&app, &config);
    let (enabled, running, bootstrapped) = p2p_iroh::dht_status(&app, &p2p, may_start).await;
    Ok(DhtStatus { enabled, running, bootstrapped })
}

/// "Recently online" per contact NodeId (Contacts presence poll). Granularity is
/// ~1 h — the cadence of the pkarr records DHT-enabled peers publish.
#[tauri::command]
pub async fn dht_presence(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    node_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    // Tor is exclusive: presence would lazily start the iroh node, so block it
    // (same reason app_set_use_tor tears iroh down).
    if use_tor(&app, &config) {
        return Err("DHT presence is unavailable while Tor mode is on.".to_string());
    }
    let presence = p2p_iroh::dht_presence(&app, &p2p, node_ids).await.map_err(|e| e.to_string())?;
    Ok(json!(presence
        .into_iter()
        .map(|(node_id, online)| json!({ "node_id": node_id, "online": online }))
        .collect::<Vec<_>>()))
}

/// Publish the nickname claim NOW and wait for the DHT write to complete —
/// backs the Contacts "Publish" button's spinner and "name published" state.
#[tauri::command]
pub async fn dht_publish_nick(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
) -> Result<(), String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    if use_tor(&app, &config) {
        return Err("Nickname publishing is unavailable while Tor mode is on.".to_string());
    }
    p2p_iroh::dht_publish_nick(&app, &p2p).await.map_err(|e| e.to_string())
}

/// Search the DHT nickname directory (Contacts "Find people"). Results are
/// CLAIMS — anyone can publish any name; the UI shows NodeId fingerprints.
#[tauri::command]
pub async fn dht_find_nick(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    nick: String,
) -> Result<serde_json::Value, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    // Tor is exclusive: the search would lazily start the iroh node.
    if use_tor(&app, &config) {
        return Err("Nickname search is unavailable while Tor mode is on.".to_string());
    }
    let claims = p2p_iroh::dht_find_nick(&app, &p2p, &nick).await.map_err(|e| e.to_string())?;
    Ok(json!(claims
        .into_iter()
        .map(|(node_id, name, ts)| json!({ "node_id": node_id, "name": name, "ts": ts }))
        .collect::<Vec<_>>()))
}

/// Mint/show the ticketless-join code for an open room (e.g. rooms created
/// before the toggle). `None` while DHT discovery is off.
#[tauri::command]
pub async fn dht_room_code(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    room: String,
    name: String,
) -> Result<Option<String>, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    // Room codes are iroh-only; minting one would start the iroh node, which
    // Tor-exclusive mode forbids.
    if use_tor(&app, &config) {
        return Ok(None);
    }
    p2p_iroh::dht_room_code(&app, &p2p, &room, &name).await.map_err(|e| e.to_string())
}

/// Apply a flipped DHT toggle: tear the iroh node down (same pattern as the
/// airplane-mode switch); the next realtime command lazily re-binds with the
/// new setting and rooms re-join through the reconnect machinery.
#[tauri::command]
pub async fn dht_apply(app: AppHandle, p2p: State<'_, P2pState>) -> Result<(), String> {
    p2p_iroh::shutdown(&app, &p2p).await;
    Ok(())
}

/// Re-point this member's outbound onion dial to the elected captain (Tor only).
/// Driven by the frontend's captain election in `useChatChannel.ts`; idempotent.
#[tauri::command]
pub async fn realtime_tor_set_captain(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    tor: State<'_, TorP2pState>,
    room: String,
    captain_onion: String,
) -> Result<(), String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    p2p_tor::set_captain(&app, &tor, &room, captain_onion)
        .await
        .map_err(|e| e.to_string())
}
