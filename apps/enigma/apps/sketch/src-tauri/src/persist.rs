//! The board on disk, as this app registers it.
//!
//! Three shims over `crates/hoard`, compiled only under the `persist` feature.
//! What is decided HERE is where the store lives and that these three commands
//! are on the IPC surface; the store itself, and the rule about what may go
//! into it, are the crate's.
//!
//! Note what is NOT here, and could not be added without noticing: there is no
//! command that writes a key, a ticket or a peer id. `hoard::save` takes a
//! board id and opaque document bytes, so the only thing this surface can put
//! on disk is a drawing — which is what keeps the collaboration layer's two
//! deliberate choices (no group key persisted, no stable identity) intact.

use std::sync::Mutex;

use hoard::Hoard;
use tauri::{AppHandle, Manager, State};

/// The store, opened on first use.
///
/// Lazy rather than opened at startup: a build with this feature on should not
/// create a database directory for someone who never draws anything, and the
/// first save is early enough to find out the disk is unwritable.
#[derive(Default)]
pub struct PersistState(pub Mutex<Option<Hoard>>);

/// Where the boards live: the app's own data directory, beside whatever else
/// Tauri keeps for it. NOT the profile directory enigma uses — sketch has no
/// profiles, and inventing one here would be inventing a concept.
fn open(app: &AppHandle, state: &PersistState) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "store_failed: lock poisoned".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("store_failed: no data directory: {e}"))?
        .join("boards");
    *guard = Some(Hoard::open(dir).map_err(|e| e.to_string())?);
    Ok(())
}

fn with<T>(
    app: &AppHandle,
    state: &PersistState,
    f: impl FnOnce(&Hoard) -> Result<T, hoard::HoardError>,
) -> Result<T, String> {
    open(app, state)?;
    let guard = state.0.lock().map_err(|_| "store_failed: lock poisoned".to_string())?;
    let store = guard.as_ref().ok_or_else(|| "store_failed: not open".to_string())?;
    f(store).map_err(|e| e.to_string())
}

/// Write a board. `snapshot` is the session's own wire JSON, stored verbatim.
#[tauri::command]
pub async fn board_save(
    app: AppHandle,
    state: State<'_, PersistState>,
    board: String,
    snapshot: String,
) -> Result<(), String> {
    with(&app, &state, |h| h.save(&board, snapshot.as_bytes()))
}

/// Read a board back, or `null` when nothing was stored for it.
///
/// The distinction matters to the caller: `null` means start fresh, an empty
/// string means restore a board somebody deliberately cleared.
#[tauri::command]
pub async fn board_load(
    app: AppHandle,
    state: State<'_, PersistState>,
    board: String,
) -> Result<Option<String>, String> {
    let bytes = with(&app, &state, |h| h.load(&board))?;
    match bytes {
        None => Ok(None),
        Some(b) => String::from_utf8(b)
            .map(Some)
            .map_err(|e| format!("board_damaged: not text: {e}")),
    }
}

/// Forget a board entirely.
#[tauri::command]
pub async fn board_forget(
    app: AppHandle,
    state: State<'_, PersistState>,
    board: String,
) -> Result<(), String> {
    with(&app, &state, |h| h.forget(&board))
}
