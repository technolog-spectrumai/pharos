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
}

#[derive(Serialize)]
pub struct JoinedRoom {
    room: String,
    name: String,
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
    let (room, ticket) = if use_tor(&app, &config) {
        p2p_tor::create_room(&app, &tor, name.clone()).await.map_err(|e| e.to_string())?
    } else {
        p2p_iroh::create_room(&app, &p2p, name.clone()).await.map_err(|e| e.to_string())?
    };
    Ok(CreatedRoom { room, name, ticket })
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
    let (room, name) = if p2p_tor::ticket_is_tor(&ticket) {
        p2p_tor::join_room(&app, &tor, ticket, peer_node_ids.unwrap_or_default())
            .await
            .map_err(|e| e.to_string())?
    } else {
        p2p_iroh::join_room(&app, &p2p, ticket, peer_node_ids.unwrap_or_default())
            .await
            .map_err(|e| e.to_string())?
    };
    Ok(JoinedRoom { room, name })
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
    Ok(JoinedRoom { room, name })
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
