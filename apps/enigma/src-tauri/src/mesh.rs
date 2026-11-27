// Enigma27's only transport: a mesh of Tor onion services.
//
// The mesh itself (one arti client, an onion per room, signed member links,
// padded framing, cover traffic, outbox, redial, the sealed arti state) lives
// in the Tauri-free crate `beacon-node`. This file is the app's adapter:
// `AppHost` gives the node what only the app has (events to the frontend, the
// vault, the device key, MLS membership, the invitation and file servers), and
// the functions below keep the signatures the rest of the app calls.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use beacon_node::{BoxFuture, Host, MeshConfig};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncWrite};

pub(crate) use beacon_node::{DataStream, PreferredRuntime, TorClient};
#[cfg(test)]
pub(crate) use beacon_node::{dial as node_dial, link_message, Hello, Ready};

/// The virtual port every onion listens on. Rides inside each invitation.
pub const ONION_PORT: u16 = crate::build_config::network::ONION_PORT;
/// Caps one frame. Members of a room must agree.
const MAX_FRAME: usize = crate::build_config::network::MAX_FRAME_BYTES;
/// Cover traffic interval: longer on phones, for battery and data.
#[cfg(target_os = "android")]
const COVER_EVERY: u64 = 90;
#[cfg(not(target_os = "android"))]
const COVER_EVERY: u64 = 30;

// ── Tor's own state, for the indicator in the app bar ─────────────────────────

/// `off`, `starting`, `on` or `error`.
static TOR_STATE: std::sync::Mutex<&'static str> = std::sync::Mutex::new("off");

/// Whether Tor is running on this device right now.
#[tauri::command]
pub fn tor_status() -> String {
    TOR_STATE.lock().map(|g| g.to_string()).unwrap_or_else(|_| "off".into())
}

// ── state ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct MeshState(pub beacon_node::Mesh);

// ── the host ──────────────────────────────────────────────────────────────────

struct AppHost(AppHandle);

fn host(app: &AppHandle) -> Arc<dyn Host> {
    Arc::new(AppHost(app.clone()))
}

impl Host for AppHost {
    fn on_frame(&self, room: &str, payload: &str) {
        let _ = self.0.emit("realtime://message", serde_json::json!({ "room": room, "payload": payload }));
    }

    /// `connected` while at least one member is linked, `waiting` otherwise,
    /// with the linked members' onions and the one whose link changed.
    fn on_status(&self, room: &str, linked: &[String], peer: Option<String>) {
        let state = if linked.is_empty() { "waiting" } else { "connected" };
        let _ = self.0.emit(
            "realtime://status",
            serde_json::json!({ "room": room, "state": state, "peers": linked.len(), "linked": linked, "peer_id": peer }),
        );
    }

    /// The room is closed on this device (lock, airplane mode, profile switch).
    fn on_closed(&self, room: &str) {
        let _ = self.0.emit(
            "realtime://status",
            serde_json::json!({ "room": room, "state": "disconnected", "peers": 0, "linked": [], "peer_id": null }),
        );
    }

    fn on_tor_state(&self, state: &'static str) {
        if let Ok(mut g) = TOR_STATE.lock() {
            *g = state;
        }
        let _ = self.0.emit("tor://status", serde_json::json!({ "state": state }));
    }

    fn device_id(&self) -> Option<String> {
        crate::device::load_or_create(&self.0).ok().map(|k| crate::device::id_of(&k))
    }

    fn sign(&self, msg: &[u8]) -> Option<[u8; 64]> {
        crate::device::load_or_create(&self.0).ok().map(|k| crate::device::sign(&k, msg))
    }

    fn is_member(&self, room: &str, device: &str) -> bool {
        crate::is_room_member(&self.0, room, device)
    }

    /// This device's presence id in handshakes, kept per profile in the vault.
    fn peer_id(&self) -> Result<String> {
        if let Ok(Some(bytes)) = crate::vault::get(&self.0, "keys", "tor_peer_id") {
            if let Ok(s) = String::from_utf8(bytes) {
                let s = s.trim().to_string();
                if !s.is_empty() {
                    return Ok(s);
                }
            }
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        crate::vault::put(&self.0, "keys", "tor_peer_id", id.as_bytes()).map_err(|e| anyhow!("persist peer id: {e}"))?;
        Ok(id)
    }

    fn load_keystore(&self) -> Option<Vec<u8>> {
        crate::vault::get(&self.0, "keys", "tor_keystore").ok().flatten()
    }

    fn save_keystore(&self, archive: &[u8]) -> bool {
        crate::vault::put(&self.0, "keys", "tor_keystore", archive).is_ok()
    }

    fn delete_keystore(&self) {
        let _ = crate::vault::delete(&self.0, "keys", "tor_keystore");
    }

    fn serve_stream(&self, kind: &str, mut rd: beacon_node::ReadHalf, mut wr: beacon_node::WriteHalf) -> BoxFuture<()> {
        let app = self.0.clone();
        let kind = kind.to_string();
        Box::pin(async move {
            match kind.as_str() {
                "redeem" => {
                    let pending = app.state::<crate::invite_redeem::RedeemState>().inner().clone();
                    if let Err(e) = crate::invite_redeem::serve_tor(&app, &pending, &mut wr, &mut rd).await {
                        eprintln!("[redeem] serve ended: {e}");
                    }
                }
                "file" => {
                    if let Err(e) = crate::files::serve(&app, &mut wr, &mut rd).await {
                        eprintln!("[file] serve ended: {e}");
                    }
                }
                _ => {}
            }
        })
    }
}

// ── config and paths ──────────────────────────────────────────────────────────

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

/// The app's mesh constants (build_config.yaml) and this profile's Tor dirs.
fn config(app: &AppHandle) -> MeshConfig {
    let base = tor_base(app);
    MeshConfig {
        onion_port: ONION_PORT,
        max_frame: MAX_FRAME,
        write_timeout: Duration::from_secs(crate::build_config::network::TOR_WRITE_TIMEOUT_SECS),
        handshake_timeout: Duration::from_secs(crate::build_config::network::TOR_HANDSHAKE_TIMEOUT_SECS),
        cover_every: COVER_EVERY,
        state_dir: base.join("state"),
        cache_dir: base.join("cache"),
        nickname_prefix: "enigma".into(),
    }
}

// ── framing (used by the invitation and file servers) ────────────────────────

pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<()> {
    beacon_node::write_frame(w, payload).await
}

pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<String> {
    beacon_node::read_frame(r, MAX_FRAME).await
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

/// Start arti if it is not running. Bootstrapping takes from a few seconds
/// (warm cache) to a minute (cold), so the app calls this right after unlock.
pub async fn ensure_started(app: &AppHandle, state: &MeshState) -> Result<()> {
    beacon_node::ensure_started(&state.0, host(app), &config(app)).await
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
    beacon_node::client_of(&state.0).await
}

/// Tear everything down: every room, every link, arti itself (lock, profile
/// switch, airplane mode, quit). arti's state is sealed into the vault.
pub async fn shutdown(_app: &AppHandle, state: &MeshState) {
    beacon_node::shutdown(&state.0).await
}

/// Forget every onion identity (Settings, "Clear selected data"): the next
/// room launch mints fresh addresses.
pub async fn clean_keystore(app: &AppHandle, state: &MeshState) {
    beacon_node::clean_keystore(&state.0, &AppHost(app.clone())).await
}

// ── rooms ─────────────────────────────────────────────────────────────────────

/// Room slug: deterministic from the name.
#[allow(dead_code)]
pub fn room_for(name: &str) -> String {
    beacon_node::room_for(name)
}

/// This device's onion for an open room, if any.
pub async fn room_onion(state: &MeshState, slug: &str) -> Option<String> {
    beacon_node::room_onion(&state.0, slug).await
}

/// Host a room: launch our onion for it and accept members' links. Returns
/// `(slug, my_onion)`. Idempotent.
pub async fn open_room(app: &AppHandle, state: &MeshState, name: String) -> Result<(String, String)> {
    beacon_node::open_room(&state.0, host(app), &config(app), name).await
}

/// The members this device should keep a link to. Replaces the previous list.
pub async fn set_peers(_app: &AppHandle, state: &MeshState, slug: &str, onions: Vec<String>) -> Result<()> {
    beacon_node::set_peers(&state.0, slug, onions).await
}

/// Open a room and link to the given members: reopening a saved room, or
/// entering one after an invitation was redeemed.
pub async fn join_room(app: &AppHandle, state: &MeshState, name: String, peers: Vec<String>) -> Result<(String, String)> {
    beacon_node::join_room(&state.0, host(app), &config(app), name, peers).await
}

/// The join modal's Cancel.
pub async fn cancel_join(state: &MeshState) {
    beacon_node::cancel_join(&state.0).await
}

/// Send one frame to every member (padded; queued for unlinked members).
pub async fn broadcast(state: &MeshState, slug: &str, payload: String) -> Result<()> {
    beacon_node::broadcast(&state.0, slug, payload).await
}

/// Close a room on this device: stop serving its onion and drop its links.
pub async fn leave_room(state: &MeshState, slug: &str) {
    beacon_node::leave_room(&state.0, slug).await
}

/// Destroy a room's onion identity ("delete room").
pub async fn forget_onion(app: &AppHandle, state: &MeshState, name: String) -> Result<()> {
    beacon_node::forget_onion(&state.0, &AppHost(app.clone()), &config(app), name).await
}

/// Dial an onion for an invitation redemption or a file download: same
/// onion, same port, a different `kind`.
pub(crate) async fn dial_kind(
    app: &AppHandle,
    state: &MeshState,
    onion: &str,
    kind: &str,
) -> Result<(tokio::io::ReadHalf<DataStream>, tokio::io::WriteHalf<DataStream>)> {
    beacon_node::dial_kind(&state.0, host(app), &config(app), onion, kind).await
}

#[cfg(test)]
#[path = "mesh_live.rs"]
mod live;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_signature_from_the_device_key_verifies_in_the_node() {
        let k = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        let id = crate::device::id_of(&k);
        let sig = crate::device::sign(&k, &link_message("me.onion", "you.onion", 100));
        assert!(beacon_node::verify_device(&id, &link_message("me.onion", "you.onion", 100), &sig));
        assert!(crate::device::verify(&id, &link_message("me.onion", "you.onion", 100), &sig));
        assert!(!beacon_node::verify_device(&id, &link_message("other.onion", "you.onion", 100), &sig));
    }

    #[test]
    fn the_app_nickname_prefix_is_unchanged() {
        // Onion keys are stored under the nickname: a change would mint new
        // addresses for every saved room.
        assert!(beacon_node::nickname_for("enigma", "a").unwrap().to_string().starts_with("enigma_"));
    }
}
