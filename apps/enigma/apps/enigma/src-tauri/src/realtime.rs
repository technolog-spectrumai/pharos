// Rust-owned realtime gateway — P2P (iroh) only.
//
// The frontend calls the `realtime_*` commands and listens to the
// `realtime://message` / `realtime://status` events; it never learns which
// transport is used. The WebSocket relay backend was removed in the serverless
// rework — every room is an iroh-gossip room now (see p2p_iroh.rs). The command
// names are kept so the TS `chatTransport` call sites are unchanged.

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::p2p_iroh::{self, P2pState};
use crate::{active_config, load_profile_state, AppConfigState};

const OFFLINE_BLOCKED: &str = "Offline — all network connections are blocked.";

/// Airplane mode: true when the offline switch is on (blocks all P2P networking).
fn offline(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg)))
}

#[tauri::command]
pub async fn realtime_send(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    room: Option<String>,
    payload: String,
) -> Result<(), String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let room = room.ok_or_else(|| "realtime: room is required".to_string())?;
    p2p_iroh::broadcast(&p2p, &room, payload)
        .await
        .map_err(|e| e.to_string())
}

// ── P2P (iroh) room commands ───────────────────────────────────────────────────

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
    name: String,
) -> Result<CreatedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let (room, ticket) = p2p_iroh::create_room(&app, &p2p, name.clone())
        .await
        .map_err(|e| e.to_string())?;
    Ok(CreatedRoom { room, name, ticket })
}

/// Join by ticket. `peer_node_ids` optionally seeds the bootstrap with previously
/// persisted peers (their current addresses resolve via n0 discovery even when the
/// ticket's embedded addresses have gone stale).
#[tauri::command]
pub async fn realtime_join_room(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    ticket: String,
    peer_node_ids: Option<Vec<String>>,
) -> Result<JoinedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let (room, name) = p2p_iroh::join_room(&app, &p2p, ticket, peer_node_ids.unwrap_or_default())
        .await
        .map_err(|e| e.to_string())?;
    Ok(JoinedRoom { room, name })
}

/// Reconnect to a room by its name and the peers' NodeIds — no ticket. This is the
/// pair-once path: after the initial QR join, the app persists the room's peer
/// NodeIds and re-subscribes here; addresses resolve via iroh's n0 discovery.
#[tauri::command]
pub async fn realtime_join_room_by_node(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    name: String,
    peer_node_ids: Vec<String>,
) -> Result<JoinedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let room = p2p_iroh::join_room_by_node(&app, &p2p, name.clone(), peer_node_ids)
        .await
        .map_err(|e| e.to_string())?;
    Ok(JoinedRoom { room, name })
}

#[tauri::command]
pub async fn realtime_leave_room(p2p: State<'_, P2pState>, room: String) -> Result<(), String> {
    p2p_iroh::leave_room(&p2p, &room).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn realtime_node_info(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
) -> Result<serde_json::Value, String> {
    // node_info starts the iroh endpoint (relay connection + discovery publish),
    // so airplane mode must gate it like every other network-touching command.
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let node_id = p2p_iroh::node_info(&app, &p2p).await.map_err(|e| e.to_string())?;
    Ok(json!({ "node_id": node_id }))
}
