//! The board, as this app registers it.
//!
//! Thin commands over `crates/board`, compiled only under the `document`
//! feature. The CRDT decisions all live in the crate; what is decided HERE is
//! the shape of the boundary, and there is one thing worth saying about it.
//!
//! # Why a commit returns the whole board
//!
//! Every mutating command answers with the merged shape list. That looks
//! wasteful next to returning a delta the frontend could apply itself — but a
//! delta is only cheaper if the frontend keeps its own copy of the document,
//! and keeping a second copy in sync with the CRDT is precisely the class of
//! bug this migration exists to delete. The board is the single source of
//! truth; the frontend renders what it is given.
//!
//! It is affordable because of what does NOT come through here. A drag emits
//! one commit at `endTransform`, not one per pointer move; the 20 Hz traffic
//! is ephemeral `Live` frames that never touch the document. Measured for a
//! 1000-shape board: 622 µs to build, 85 µs to encode.
//!
//! # What crosses, and what deliberately does not
//!
//! Shapes cross as JSON strings — the same `WireShape` bodies the frontend
//! already had, so the SVG codec, the geometry and the validation stay where
//! they are. This layer never parses one. `crates/board` does not know what a
//! rectangle is, and neither does this file.

use std::sync::Mutex;

use board::Board;
use tauri::State;

/// The open board.
///
/// One per app, replaced when a different file is opened. `None` until the
/// first command, so a build with this feature on costs nothing for someone
/// who never draws.
#[derive(Default)]
pub struct DocState(pub Mutex<Option<Board>>);

/// What every mutating command answers with: the merged board, and the bytes
/// to hand the peers.
///
/// `update` is `None` when nothing changed — a delete of an already-deleted
/// shape, a background set to the colour it already was. Sending an empty
/// update would be harmless and pointless; making the emptiness explicit lets
/// the caller skip the send.
#[derive(serde::Serialize)]
pub struct Committed {
    /// Every shape, in paint order, as the JSON the frontend stored.
    pub shapes: Vec<String>,
    /// The yrs update carrying just this change, for `Frame::Op`.
    pub update: Option<Vec<u8>>,
    /// The background colour, or `None` for transparent.
    ///
    /// Carried on EVERY answer rather than only when it changed, because the
    /// caller applies whatever it is given and a background that arrives in a
    /// peer's update has no other way to reach the screen — the shapes list
    /// cannot express it, and the frontend keeps no second copy to diff
    /// against. Found by a test where a peer's background never arrived.
    pub background: Option<String>,
    /// The board size, which travels for the same reason.
    pub width: u32,
    pub height: u32,
}

fn with<T>(state: &DocState, f: impl FnOnce(&Board) -> T) -> Result<T, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "document_failed: lock poisoned".to_string())?;
    let doc = guard.get_or_insert_with(Board::new);
    Ok(f(doc))
}

/// Run `f`, and report the board plus exactly the bytes `f` produced.
///
/// The update is computed as the diff against the state vector taken BEFORE
/// the change, which is what makes it "just this edit" rather than the whole
/// document. Doing it any other way — encoding the full state and letting the
/// peer sort it out — is what the old design did, and is why a resync cost a
/// whole board.
fn commit(state: &DocState, f: impl FnOnce(&Board)) -> Result<Committed, String> {
    with(state, |doc| {
        let before = doc.state_vector();
        f(doc);
        let update = doc.diff(&before).ok().filter(|u| !is_empty_update(u));
        committed(doc, update)
    })
}

/// The board's whole document state, plus whatever bytes produced it.
fn committed(doc: &Board, update: Option<Vec<u8>>) -> Committed {
    let (width, height) = doc.size();
    Committed {
        shapes: doc.shapes(),
        update,
        background: doc.background(),
        width,
        height,
    }
}

/// An update that carries no changes still encodes to a couple of framing
/// bytes rather than to nothing, so "did anything happen" cannot be a length
/// check against zero.
fn is_empty_update(update: &[u8]) -> bool {
    update.len() <= 2
}

/// Start a fresh board, discarding whatever was open.
///
/// Called when a file is opened or a new drawing started. NOT called on join:
/// a joiner merges the host's snapshot into its own document so that anything
/// drawn before pairing survives, which is the behaviour the old session had
/// and the tests pin.
#[tauri::command]
pub async fn doc_reset(state: State<'_, DocState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "document_failed: lock poisoned".to_string())?;
    *guard = Some(Board::new());
    Ok(())
}

/// Add or replace a shape.
#[tauri::command]
pub async fn doc_put(
    state: State<'_, DocState>,
    id: String,
    shape: String,
) -> Result<Committed, String> {
    commit(&state, |doc| doc.put(&id, &shape))
}

/// Add or replace several shapes as ONE update.
///
/// A paste, a multi-select drag or an undo of a group is many shapes and one
/// user action. Sending it as one update rather than N keeps the peer's board
/// from rendering a half-applied group, and costs one frame instead of N.
#[tauri::command]
pub async fn doc_put_many(
    state: State<'_, DocState>,
    shapes: Vec<(String, String)>,
) -> Result<Committed, String> {
    commit(&state, |doc| {
        for (id, shape) in &shapes {
            doc.put(id, shape);
        }
    })
}

/// Remove shapes.
#[tauri::command]
pub async fn doc_remove(
    state: State<'_, DocState>,
    ids: Vec<String>,
) -> Result<Committed, String> {
    commit(&state, |doc| {
        for id in &ids {
            doc.remove(id);
        }
    })
}

/// Remove every shape.
#[tauri::command]
pub async fn doc_clear(state: State<'_, DocState>) -> Result<Committed, String> {
    commit(&state, |doc| doc.clear())
}

/// Set the background, or clear it to transparent.
#[tauri::command]
pub async fn doc_set_background(
    state: State<'_, DocState>,
    color: Option<String>,
) -> Result<Committed, String> {
    commit(&state, |doc| doc.set_background(color.as_deref()))
}

/// Set the board size, which travels to peers so a joiner draws on the same
/// canvas rather than at its own default.
#[tauri::command]
pub async fn doc_set_size(
    state: State<'_, DocState>,
    width: u32,
    height: u32,
) -> Result<Committed, String> {
    commit(&state, |doc| doc.set_size(width, height))
}

/// The board as it stands, without changing it.
#[derive(serde::Serialize)]
pub struct DocView {
    pub shapes: Vec<String>,
    pub background: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn doc_read(state: State<'_, DocState>) -> Result<DocView, String> {
    with(&state, |doc| {
        let (width, height) = doc.size();
        DocView {
            shapes: doc.shapes(),
            background: doc.background(),
            width,
            height,
        }
    })
}

/// Merge an update from a peer or from the store.
///
/// Always a merge. Local work drawn while the update was in flight survives —
/// the property the old `applySnapshot` had to implement by hand and which is
/// now the library's.
#[tauri::command]
pub async fn doc_apply(state: State<'_, DocState>, update: Vec<u8>) -> Result<Committed, String> {
    let applied = with(&state, |doc| doc.apply(&update))?;
    applied.map_err(|e| e.to_string())?;
    with(&state, |doc| committed(doc, None))
}

/// Everything, as one update — what a joiner is sent, and what goes to disk.
#[tauri::command]
pub async fn doc_snapshot(state: State<'_, DocState>) -> Result<Vec<u8>, String> {
    with(&state, |doc| doc.snapshot())
}

/// What this board has, so a peer can answer a `Resync` with only the missing
/// part instead of the whole document.
#[tauri::command]
pub async fn doc_state_vector(state: State<'_, DocState>) -> Result<Vec<u8>, String> {
    with(&state, |doc| doc.state_vector())
}

/// Just the part a peer lacks, given what it says it has.
#[tauri::command]
pub async fn doc_diff(state: State<'_, DocState>, have: Vec<u8>) -> Result<Vec<u8>, String> {
    with(&state, |doc| doc.diff(&have))?.map_err(|e| e.to_string())
}

/// Drop the edit history, keeping the board.
///
/// Only safe with no live peers — a compacted document shares no history with
/// a peer's copy, so merging the two duplicates the paint order and resurrects
/// deletes (`crates/board` proves both). The frontend calls this on load, not
/// during a session.
#[tauri::command]
pub async fn doc_compact(state: State<'_, DocState>) -> Result<Committed, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "document_failed: lock poisoned".to_string())?;
    let doc = guard.get_or_insert_with(Board::new);
    let small = doc.compacted();
    let answer = committed(&small, None);
    *guard = Some(small);
    Ok(answer)
}
