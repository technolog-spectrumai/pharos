//! The collaboration commands, as this app registers them.
//!
//! Five shims over `crates/collab`, compiled only under the `collab` feature.
//! The session, the admission rules and the frame filtering are the crate's;
//! what is decided HERE is that this app puts them on its IPC surface, and how
//! events reach the window.
//!
//! Events go over a Tauri v2 `Channel`, not `app.emit`: a channel is handed to
//! one caller and reaches one window, so a second window (or a stray listener)
//! never sees another session's frames and nothing has to filter by id on the
//! JS side. Enigma broadcasts globally and filters client-side; the survey
//! called that out as the thing not to copy.
//!
//! The parameter names below are the JSON keys the frontend sends — tauri
//! derives them, and `on_event` becomes `onEvent`. Renaming one breaks the
//! call silently at runtime, not at compile time.

use collab::{Config, Event, Frame, Session};
use serde::Serialize;
use tauri::{ipc::Channel, State};
use tauri::async_runtime::Mutex;

/// One session at a time. A second `host`/`join` closes the first — a board
/// pairs with one peer, and a stale session left running would keep an
/// endpoint bound and a topic subscribed for nothing.
#[derive(Default)]
pub struct CollabState(pub Mutex<Option<Session>>);

#[derive(Serialize)]
pub struct CollabStatus {
    active: bool,
    endpoint_id: Option<String>,
}

#[derive(Serialize)]
pub struct Joined {
    /// The six digits this side shows. Computed in Rust from both endpoint
    /// ids, so the frontend never derives it and cannot get it subtly wrong.
    sas: String,
}

/// Forward the session's events to the window until it closes.
fn pump(session: &mut Session, on_event: Channel<Event>) {
    let Some(mut rx) = session.events() else { return };
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if on_event.send(ev).is_err() {
                break; // the window went away; stop forwarding
            }
        }
    });
}

async fn replace(state: &CollabState, next: Session) {
    if let Some(old) = state.0.lock().await.replace(next) {
        old.close().await;
    }
}

/// Start hosting. Returns the ticket text to show as a QR.
#[tauri::command]
pub async fn collab_host(
    state: State<'_, CollabState>,
    on_event: Channel<Event>,
) -> Result<String, String> {
    let (mut session, ticket) = Session::host(Config::default()).await?;
    pump(&mut session, on_event);
    let text = collab::ticket::encode(&ticket)?;
    replace(&state, session).await;
    Ok(text)
}

/// Join from a scanned or pasted ticket. Returns the short-auth-string to show.
#[tauri::command]
pub async fn collab_join(
    state: State<'_, CollabState>,
    ticket: String,
    on_event: Channel<Event>,
) -> Result<Joined, String> {
    let parsed = collab::ticket::decode(&ticket)?;
    let mut session = Session::join(Config::default(), &parsed).await?;
    pump(&mut session, on_event);
    let sas = session.sas_with_host().ok_or_else(|| "not_joined: no host to pair with".to_string())?;
    replace(&state, session).await;
    Ok(Joined { sas })
}

/// Broadcast a frame. `bytes` arrive as a JSON array of numbers — fine for
/// ops and live strokes; a large snapshot pays for it, which is a known cost
/// to revisit with a raw channel if it ever shows.
#[tauri::command]
pub async fn collab_send(state: State<'_, CollabState>, frame: Frame) -> Result<(), String> {
    let guard = state.0.lock().await;
    let session = guard.as_ref().ok_or_else(|| "no_session: not paired".to_string())?;
    session.send(frame).await
}

#[tauri::command]
pub async fn collab_close(state: State<'_, CollabState>) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.take() {
        session.close().await;
    }
    Ok(())
}

/// Whether a session is live. The frontend also uses this as its PROBE: a
/// build without the feature has no such command, the call fails, and the
/// Collab tab hides itself — the gate the review said the frontend was missing.
#[tauri::command]
pub async fn collab_status(state: State<'_, CollabState>) -> Result<CollabStatus, String> {
    let guard = state.0.lock().await;
    Ok(CollabStatus {
        active: guard.is_some(),
        endpoint_id: guard.as_ref().map(|s| s.endpoint_id()),
    })
}
