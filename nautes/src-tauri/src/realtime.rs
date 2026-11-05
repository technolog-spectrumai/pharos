// Rust-owned realtime gateway over the one transport Nautes has: peer-hosted
// Tor onion services (p2p_tor.rs).
//
// The frontend calls the `realtime_*` commands and listens to the
// `realtime://message` / `realtime://status` events. (Enigma also had an iroh
// backend; Pharos removed it — Stage 1.3.)

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::p2p_tor::{self, TorP2pState};
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
    tor: State<'_, TorP2pState>,
    room: Option<String>,
    payload: String,
) -> Result<(), String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let room = room.ok_or_else(|| "realtime: room is required".to_string())?;
    p2p_tor::broadcast(&tor, &room, payload).await.map_err(|e| e.to_string())
}

// ── P2P room commands ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CreatedRoom {
    room: String,
    name: String,
    /// This member's own onion (Tor rooms) — announced over presence so peers can
    /// dial us if we're elected captain. Empty for iroh rooms.
    onion: String,
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
    tor: State<'_, TorP2pState>,
    name: String,
) -> Result<CreatedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let (room, onion) = p2p_tor::create_room(&app, &tor, name.clone()).await.map_err(|e| e.to_string())?;
    Ok(CreatedRoom { room, name, onion })
}

/// Enter a room by name + peers — the only join command there is.
///
/// This re-hosts under the room name (same nickname ⇒ same onion). Two callers: reopening a saved room, and completing a redeemed
/// invitation. Landing on the topic is not membership — every member refuses
/// gossip key packages, so only a redeemed invitation joins the MLS group.
#[tauri::command]
pub async fn realtime_join_room_by_node(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    tor: State<'_, TorP2pState>,
    name: String,
    peer_node_ids: Vec<String>,
) -> Result<JoinedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let room = p2p_tor::join_room_by_node(&app, &tor, name.clone(), peer_node_ids)
        .await
        .map_err(|e| e.to_string())?;
    // Reconnect-by-name doesn't surface an onion; the Tor reopen paths that need it
    // (host re-create / joiner re-dial-by-ticket) go through create/join instead.
    Ok(JoinedRoom { room, name, onion: String::new() })
}

#[tauri::command]
pub async fn realtime_leave_room(
    tor: State<'_, TorP2pState>,
    room: String,
) -> Result<(), String> {
    let _ = p2p_tor::leave_room(&tor, &room).await;
    Ok(())
}

/// Cancel an in-flight Tor join (the join modal's "Cancel" button). Aborts the
/// hanging onion-launch/dial so it releases arti's keystore lock, letting the user
/// retry without a "local resource … already in use" error. No-op when nothing is
/// joining, so it is safe to call unconditionally.
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
    tor: State<'_, TorP2pState>,
) -> Result<serde_json::Value, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let node_id = p2p_tor::node_info(&app, &tor).await.map_err(|e| e.to_string())?;
    Ok(json!({ "node_id": node_id }))
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
