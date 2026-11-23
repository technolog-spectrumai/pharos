// The `realtime_*` commands the frontend's chat transport calls, and the
// `realtime://message` / `realtime://status` events it listens to. There is one
// transport: the Tor mesh (mesh.rs).

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::mesh::{self, MeshState};
use crate::{active_config, load_profile_state, AppConfigState};

const OFFLINE_BLOCKED: &str = "Offline — all network connections are blocked.";

/// Airplane mode blocks every network command.
fn check_offline(app: &AppHandle, config: &State<'_, AppConfigState>) -> Result<(), String> {
    match active_config(config) {
        Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg)) => Err(OFFLINE_BLOCKED.to_string()),
        _ => Ok(()),
    }
}

#[derive(Serialize)]
pub struct OpenedRoom {
    room: String,
    name: String,
    /// This device's onion for the room, announced to the other members.
    onion: String,
}

#[tauri::command]
pub async fn realtime_send(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    mesh_state: State<'_, MeshState>,
    room: String,
    payload: String,
) -> Result<(), String> {
    check_offline(&app, &config)?;
    mesh::broadcast(&mesh_state, &room, payload).await.map_err(|e| e.to_string())
}

/// Create a room: host its onion. Nobody else is in it yet.
#[tauri::command]
pub async fn realtime_create_room(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    mesh_state: State<'_, MeshState>,
    name: String,
) -> Result<OpenedRoom, String> {
    check_offline(&app, &config)?;
    let (room, onion) = mesh::open_room(&app, &mesh_state, name.clone()).await.map_err(|e| e.to_string())?;
    Ok(OpenedRoom { room, name, onion })
}

/// Open a room and link to the given members' onions: reopening a saved room,
/// or entering one after an invitation was redeemed.
#[tauri::command]
pub async fn realtime_join_room(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    mesh_state: State<'_, MeshState>,
    name: String,
    peers: Vec<String>,
) -> Result<OpenedRoom, String> {
    check_offline(&app, &config)?;
    let (room, onion) = mesh::join_room(&app, &mesh_state, name.clone(), peers).await.map_err(|e| e.to_string())?;
    Ok(OpenedRoom { room, name, onion })
}

/// The members to keep a link to (every other member's onion).
#[tauri::command]
pub async fn realtime_set_peers(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    mesh_state: State<'_, MeshState>,
    room: String,
    peers: Vec<String>,
) -> Result<(), String> {
    check_offline(&app, &config)?;
    mesh::set_peers(&app, &mesh_state, &room, peers).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn realtime_leave_room(mesh_state: State<'_, MeshState>, room: String) -> Result<(), String> {
    mesh::leave_room(&mesh_state, &room).await;
    Ok(())
}

/// The join modal's Cancel.
#[tauri::command]
pub async fn realtime_cancel_join(mesh_state: State<'_, MeshState>) -> Result<(), String> {
    mesh::cancel_join(&mesh_state).await;
    Ok(())
}

/// Part of "delete room": a future room of the same name gets a fresh onion.
#[tauri::command]
pub async fn realtime_forget_onion(
    app: AppHandle,
    mesh_state: State<'_, MeshState>,
    name: String,
) -> Result<(), String> {
    mesh::forget_onion(&app, &mesh_state, name).await.map_err(|e| e.to_string())
}

/// This device's id (its public key), for a personal invitation.
#[tauri::command]
pub fn realtime_device_id(app: AppHandle) -> Result<String, String> {
    crate::device::load_or_create(&app).map(|k| crate::device::id_of(&k)).map_err(|e| e.to_string())
}
