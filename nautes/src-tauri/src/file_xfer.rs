// Direct 1:1 peer-to-peer file transfer — Enigma's shim over ferrozine::file.
//
// The protocol, its MLS sealing, the KeyPackage authorization and the hash
// chain all live in `crates/ferrozine` (see its src/file.rs and
// docs/security.md). What stays here is what is Enigma's:
//
//   * the Tauri commands and their names, unchanged for the frontend;
//   * the `file://progress` / `file://done` / `file://error` events;
//   * the user's settings (chunk size, integrity), read per transfer;
//   * the network-policy gates — airplane mode blocks all networking, and
//     Tor-exclusive mode blocks file transfer entirely because it is iroh-only
//     (a direct QUIC connection from a Tor-routed profile would leak the IP).
//
// The wire format is ferrozine's `enigma/file/1`, byte for byte what this file
// spoke before the extraction, so transfers between old and new builds work.
//
// The offer coordinates and the downloader's commitment travel inside each
// feature's own MLS-encrypted signalling (chat `file_offer` / `file_accept`,
// devlink `dlink_file_bind`). The endpoint is deliberately ephemeral: the offer
// address is relayed fresh per offer, so nothing ever reconnects by id, and
// transfers are not linkable to each other.

use std::collections::HashMap;
use std::sync::Arc;

use ferrozine::endpoint::{EndpointConfig, Node, Relays};
use ferrozine::file::{self, Direction, FileHost, HostSettings, Limits, Observer, Prepared, TransferEvent};
use iroh::protocol::Router;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::{active_config, load_profile_state, AppConfigState};

const FILE_ALPN: &[u8] = file::ENIGMA_ALPN;

/// The build's chunk bounds (build_config.yaml `file_chunk_kib`).
fn limits() -> Limits {
    use crate::build_config::settings as s;
    Limits {
        min_chunk: (s::FILE_CHUNK_MIN_KIB as usize) * 1024,
        max_chunk: (s::FILE_CHUNK_MAX_KIB as usize) * 1024,
    }
}

/// The user's "file chunk size" setting, bytes. Re-read per transfer (Settings
/// edits apply live, never a baked literal). The HOST's value governs a transfer.
pub(crate) fn file_chunk_bytes(app: &AppHandle) -> usize {
    use crate::build_config::settings as s;
    let kib = crate::vault::kv_get_raw(app, "p2p:settings", "default", "file_chunk_kib")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(s::FILE_CHUNK_MIN_KIB, s::FILE_CHUNK_MAX_KIB))
        .unwrap_or(s::FILE_CHUNK_DEFAULT_KIB);
    (kib as usize) * 1024
}

/// The user's integrity-check toggle (Settings), default from the build config.
pub(crate) fn file_integrity_enabled(app: &AppHandle) -> bool {
    match crate::vault::kv_get_raw(app, "p2p:settings", "default", "file_integrity").as_deref() {
        Some("on") => true,
        Some("off") => false,
        _ => crate::build_config::defaults::FILE_INTEGRITY_DEFAULT,
    }
}

// Every networked feature reports airplane mode with this same string.
pub(crate) const OFFLINE_BLOCKED: &str = "Offline — all network connections are blocked.";
const TOR_BLOCKED: &str = "File transfer is unavailable in Tor mode.";

// ── network-policy gates ──────────────────────────────────────────────────────

/// Both gates at once — every networked file command runs this first.
fn check_network_policy(app: &AppHandle, config: &State<'_, AppConfigState>) -> Result<(), String> {
    let Ok(cfg) = active_config(config) else { return Ok(()) };
    let profile = load_profile_state(app, &cfg);
    if crate::is_offline(&profile) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    if crate::is_use_tor(&profile) {
        return Err(TOR_BLOCKED.to_string());
    }
    Ok(())
}

// ── state ────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct FileXferState(pub Mutex<Option<FileNode>>);

pub struct FileNode {
    node: Node,
    _router: Router,
    host: FileHost,
}

/// Transfers moving bytes, in either direction. The lock watchdog (vault.rs)
/// reads this as presence: a frozen webview sends no heartbeats, and the
/// fallback must not cut a transfer that is still running. Chat files, map
/// regions and Files → Devices sync all ride this path.
pub fn transfers_active() -> bool {
    file::transfers_active()
}

/// Downloads minted by `file_prepare`, awaiting their `file_download`. Global
/// rather than on FileNode because an airplane/Tor toggle can rebind the node
/// between the two calls.
static PREPARED: std::sync::OnceLock<Mutex<HashMap<String, Prepared>>> = std::sync::OnceLock::new();

fn prepared() -> &'static Mutex<HashMap<String, Prepared>> {
    PREPARED.get_or_init(Mutex::default)
}

// ── events ───────────────────────────────────────────────────────────────────

fn dir_name(direction: Direction) -> &'static str {
    match direction {
        Direction::Send => "send",
        Direction::Recv => "recv",
    }
}

fn emit_error(app: &AppHandle, offer_id: &str, message: &str) {
    let _ = app.emit("file://error", serde_json::json!({ "offerId": offer_id, "message": message }));
}

/// ferrozine's transfer events as Enigma's `file://` events.
fn observer(app: AppHandle) -> Observer {
    Arc::new(move |event| match event {
        TransferEvent::Progress { offer_id, direction, transferred, total } => {
            let _ = app.emit(
                "file://progress",
                serde_json::json!({ "offerId": offer_id, "dir": dir_name(direction), "transferred": transferred, "total": total }),
            );
        }
        TransferEvent::Done { offer_id, direction } => {
            let _ = app.emit("file://done", serde_json::json!({ "offerId": offer_id, "dir": dir_name(direction) }));
        }
        // The downloader's failures are the user's to see. A host-side failure
        // is usually a dial that was refused (an unauthorized peer), which the
        // offering user cannot act on — logged, as before the extraction.
        TransferEvent::Failed { offer_id, direction: Direction::Recv, message } => emit_error(&app, &offer_id, &message),
        TransferEvent::Failed { offer_id, direction: Direction::Send, message } => {
            eprintln!("[file] serving {offer_id} ended: {message}");
        }
        // A dial turned away before admission (unknown offer, unauthorized
        // peer): logged, as before the extraction; the offer stays open.
        TransferEvent::Refused { offer_id, message } => {
            eprintln!("[file] refused a downloader for {offer_id}: {message}");
        }
    })
}

// ── lifecycle ────────────────────────────────────────────────────────────────

async fn ensure_started(app: &AppHandle, state: &FileXferState) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    // Hosted-infra policy is build-time: n0 relays + discovery, or direct QUIC only.
    let relays = if crate::features::HOSTED_RELAYS { Relays::Hosted } else { Relays::None };
    let node = Node::bind(EndpointConfig::ephemeral(relays)).await.map_err(|e| format!("file {e}"))?;
    let settings_app = app.clone();
    let host = FileHost::new(
        limits(),
        move || HostSettings {
            chunk_size: file_chunk_bytes(&settings_app),
            integrity: file_integrity_enabled(&settings_app),
        },
        observer(app.clone()),
    );
    let router = Router::builder(node.endpoint.clone()).accept(FILE_ALPN, host.clone()).spawn();
    *guard = Some(FileNode { node, _router: router, host });
    Ok(())
}

/// Tear down the file node (airplane mode on, Tor mode on, profile switch). Pending
/// offers and in-flight transfers die with the endpoint; the next offer/download
/// lazily re-binds a fresh (ephemeral-identity) node.
pub async fn shutdown(state: &FileXferState) {
    let mut guard = state.0.lock().await;
    if let Some(node) = guard.take() {
        node.node.endpoint.close().await;
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct OfferCreated {
    offer_id: String,
    addr: String,
    name: String,
    size: u64,
    mime: String,
}

/// Host: register a local file to serve and return the offer metadata (including our
/// dialable `EndpointAddr`) for the frontend to relay to the chosen peer.
#[tauri::command]
pub async fn file_offer_create(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    state: State<'_, FileXferState>,
    path: String,
) -> Result<OfferCreated, String> {
    check_network_policy(&app, &config)?;
    ensure_started(&app, &state).await?;
    let guard = state.0.lock().await;
    let node = guard.as_ref().ok_or("file not started")?;
    let offer = node.host.offer(&path).map_err(|e| format!("stat failed: {e}"))?;
    Ok(OfferCreated {
        offer_id: offer.offer_id,
        addr: node.node.addr_text(),
        name: offer.name,
        size: offer.size,
        mime: offer.mime,
    })
}

/// Host: forget an offer (declined / cancelled / finished) and its
/// authorization. Ungated — it only clears local state.
#[tauri::command]
pub async fn file_offer_cancel(state: State<'_, FileXferState>, offer_id: String) -> Result<(), String> {
    if let Some(node) = state.0.lock().await.as_ref() {
        node.host.cancel(&offer_id);
    }
    Ok(())
}

/// Mint this device's transfer KeyPackage and return its commitment. The caller
/// publishes it to the host over its feature's own MLS signalling; the host
/// then accepts only a connection presenting that KeyPackage. Must be called
/// before `file_download`.
#[tauri::command]
pub async fn file_prepare(offer_id: String) -> Result<String, String> {
    let ready = file::prepare(&offer_id).map_err(|e| e.to_string())?;
    let commitment = ready.commitment();
    prepared().lock().await.insert(offer_id, ready);
    Ok(commitment)
}

/// Host side: authorize exactly one peer for an offer, by the commitment it
/// published over signalling. Until this lands, a connection is refused.
#[tauri::command]
pub async fn file_authorize(
    state: State<'_, FileXferState>,
    offer_id: String,
    kp_hash: String,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    guard.as_ref().ok_or("file not started")?.host.authorize(&offer_id, &kp_hash);
    Ok(())
}

/// Downloader: connect to the host and stream the offered file to `dest`. Returns
/// once the transfer has started; progress arrives via `file://progress`.
#[tauri::command]
pub async fn file_download(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    state: State<'_, FileXferState>,
    addr: String,
    offer_id: String,
    dest: String,
) -> Result<(), String> {
    check_network_policy(&app, &config)?;
    ensure_started(&app, &state).await?;
    let endpoint = state.0.lock().await.as_ref().ok_or("file not started")?.node.endpoint.clone();
    let addr = ferrozine::addr::decode(&addr).map_err(|e| format!("invalid addr: {e}"))?;
    tauri::async_runtime::spawn(async move {
        let Some(ready) = prepared().lock().await.remove(&offer_id) else {
            emit_error(&app, &offer_id, "call file_prepare before downloading");
            return;
        };
        // Failures are reported through the observer (as `file://error`).
        let _ = file::download(
            &endpoint,
            addr,
            FILE_ALPN,
            ready,
            std::path::Path::new(&dest),
            file_integrity_enabled(&app),
            limits(),
            observer(app.clone()),
        )
        .await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The protocol's own tests are in crates/ferrozine. These pin how Enigma
    // configures it.

    #[test]
    fn the_largest_chunk_fits_one_wire_frame() {
        let l = limits();
        assert!(l.min_chunk <= l.max_chunk);
        assert!(l.max_chunk <= crate::build_config::network::MAX_FRAME_BYTES);
    }

    #[test]
    fn the_alpn_is_unchanged_so_old_and_new_builds_still_transfer() {
        assert_eq!(FILE_ALPN, b"enigma/file/1");
    }
}
