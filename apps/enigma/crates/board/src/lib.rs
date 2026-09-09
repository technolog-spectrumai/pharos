//! The drawing, as a CRDT.
//!
//! `yrs` — the Rust port of Yjs — holding one board. This replaces a
//! hand-rolled LWW-element-set that worked and was well tested; what it buys
//! is not convergence, which the old one had, but three things it could not:
//!
//! * **Density.** 1000 shapes encode to ~123 KB against a JSON snapshot that
//!   had to be truncated at 700 KB to fit the transport. So `truncateSnapshot`,
//!   `gcTombstones`, the `truncated` flag and the user-visible "your board is
//!   incomplete" warning all delete, and nothing replaces them.
//! * **Delta sync.** A state vector asks for exactly what is missing, where
//!   the old design answered every resync with the whole board.
//! * **No clock.** The old CRDT needed a hybrid logical clock and an
//!   `observe()` on every inbound timestamp, or a peer with a slow wall clock
//!   silently lost every race it took part in. yrs uses Lamport clocks
//!   internally; that entire failure mode is gone.
//!
//! # The data model, and why it is two types rather than one
//!
//! ```text
//!   order : YArray<String>          shape ids, in paint order
//!   shapes: YMap<String, String>    id -> the shape as JSON
//!   meta  : YMap<String, Any>       background, board width and height
//! ```
//!
//! A `YMap` alone has no order, and paint order is load-bearing — two peers
//! rendering the same set in different orders draw different pictures and
//! hit-test differently. A `YArray` alone cannot address a shape by id.
//! Together they give what the old `compareEntries` hand-rolled: editing a
//! shape does not move it in z, and concurrent appends converge to the same
//! order on both peers. Both verified before this was written.
//!
//! Shapes are stored as whole JSON values, not as nested maps of fields. That
//! looks lossy for a drag — but a drag is PROVISIONAL in this app and commits
//! exactly once, at `endTransform`; the 20 Hz traffic is ephemeral preview
//! frames that never reach the document. Per-field granularity would buy
//! nothing and cost a nested-type explosion.
//!
//! # How the document grows, measured — and a correction
//!
//! An earlier note in this project claimed yrs garbage-collects overwritten
//! values outright, on the strength of one shape rewritten 5000 times growing
//! by 32 bytes. That generalised wrongly. yrs merges a run of overwrites only
//! when they are CONTIGUOUS in the writer's item list, which rewriting a
//! single key in a loop trivially is. A real session round-robins across many
//! shapes, and those overwrites interleave, so each one stands alone:
//!
//! ```text
//!   300 shapes, live                            25 KB
//!   + 9000 gestures (30 edits per shape)       107 KB   (4.2x)
//!   + 210000 rewrites                         2110 KB   (~10 bytes each, linear, forever)
//!   the same board compacted                    26 KB
//! ```
//!
//! So growth is bounded by SESSION LENGTH, not by how much is on the board,
//! and it does not settle on its own. It is still a large improvement on what
//! it replaces — a heavy session lands well inside the 700 KB at which the old
//! JSON snapshot had to truncate itself, which is why `truncateSnapshot`, the
//! `truncated` flag and its user-visible warning can go. But the fix for a
//! board that has been open all week is [`Board::compacted`], not a claim that
//! the problem cannot arise.
//!
//! # What this crate does NOT know
//!
//! What a shape *is*. It moves opaque JSON keyed by id, exactly as
//! `crates/collab` moves opaque bytes. The geometry, the SVG codec and the
//! validation stay in the frontend where they already are.

use std::collections::HashMap;

use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Array, ArrayRef, Doc, Map, MapRef, ReadTxn, StateVector, Transact, Update,
};

/// Named once: a typo in a root type name is a silently empty document.
const ORDER: &str = "order";
const SHAPES: &str = "shapes";
const META: &str = "meta";

/// Keys in the `meta` map.
const BACKGROUND: &str = "background";
const WIDTH: &str = "width";
const HEIGHT: &str = "height";

#[derive(Debug)]
pub enum BoardError {
    /// An update from a peer could not be decoded.
    Update(String),
}

impl std::fmt::Display for BoardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BoardError::Update(e) => write!(f, "bad_update: {e}"),
        }
    }
}

impl std::error::Error for BoardError {}

/// One board.
pub struct Board {
    doc: Doc,
    order: ArrayRef,
    shapes: MapRef,
    meta: MapRef,
}

impl Default for Board {
    fn default() -> Self {
        Self::new()
    }
}

impl Board {
    pub fn new() -> Self {
        let doc = Doc::new();
        let order = doc.get_or_insert_array(ORDER);
        let shapes = doc.get_or_insert_map(SHAPES);
        let meta = doc.get_or_insert_map(META);
        Self { doc, order, shapes, meta }
    }

    /// Rebuild from a stored or received update.
    pub fn from_update(update: &[u8]) -> Result<Self, BoardError> {
        let board = Self::new();
        board.apply(update)?;
        Ok(board)
    }

    /// Add or replace a shape.
    ///
    /// A shape already present keeps its place in the paint order — the whole
    /// reason the order is a separate array. Editing a rectangle must not
    /// bring it to the front.
    pub fn put(&self, id: &str, shape_json: &str) {
        let mut txn = self.doc.transact_mut();
        let known = self.shapes.get(&txn, id).is_some();
        self.shapes.insert(&mut txn, id, shape_json);
        if !known {
            self.order.push_back(&mut txn, id);
        }
    }

    /// Remove a shape.
    pub fn remove(&self, id: &str) {
        let mut txn = self.doc.transact_mut();
        self.shapes.remove(&mut txn, id);
        let at = self
            .order
            .iter(&txn)
            .position(|v| v.to_string(&txn) == id);
        if let Some(i) = at {
            self.order.remove(&mut txn, i as u32);
        }
    }

    /// Remove every shape.
    ///
    /// NOTE the semantics, which differ from the CRDT this replaces: a shape a
    /// peer draws CONCURRENTLY with this clear survives it. The old design
    /// carried a `clearedAt` cutoff that voided anything stamped earlier,
    /// including work still in flight. Destroying someone's stroke because it
    /// raced your clear is hard to defend, and the cutoff existed to make a
    /// hand-rolled merge converge rather than because anyone chose it.
    pub fn clear(&self) {
        let mut txn = self.doc.transact_mut();
        let ids: Vec<String> = self
            .order
            .iter(&txn)
            .map(|v| v.to_string(&txn))
            .collect();
        for id in &ids {
            self.shapes.remove(&mut txn, id);
        }
        let n = self.order.len(&txn);
        if n > 0 {
            self.order.remove_range(&mut txn, 0, n);
        }
    }

    /// The shapes, in paint order, as the JSON they were stored as.
    ///
    /// Driven by `order` rather than by the map: the map has no order, and an
    /// id in the order with no shape behind it is skipped rather than faked —
    /// that pairing can be momentarily uneven while an update is applying.
    ///
    /// An id appearing TWICE in the order yields one shape, not two. The order
    /// is a plain sequence with no key constraint, so a merge can legitimately
    /// leave a duplicate in it — merging a compacted board into a peer's copy
    /// does exactly that, since the map collapses on id and the array cannot.
    /// Rendering the shape twice would be a visible bug for something the CRDT
    /// considers converged, so the read side de-duplicates and the array is
    /// allowed to be untidy.
    pub fn shapes(&self) -> Vec<String> {
        let txn = self.doc.transact();
        let mut seen = std::collections::HashSet::new();
        self.order
            .iter(&txn)
            .filter_map(|v| {
                let id = v.to_string(&txn);
                if !seen.insert(id.clone()) {
                    return None;
                }
                self.shapes.get(&txn, &id).map(|s| s.to_string(&txn))
            })
            .collect()
    }

    pub fn len(&self) -> usize {
        self.shapes.len(&self.doc.transact()) as usize
    }

    /// How many entries the paint order holds, which is `len()` or more —
    /// they diverge exactly when a merge has left a duplicate id behind.
    pub fn order_len(&self) -> usize {
        self.order.len(&self.doc.transact()) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The board's background colour, or `None` for transparent.
    pub fn background(&self) -> Option<String> {
        let txn = self.doc.transact();
        match self.meta.get(&txn, BACKGROUND) {
            Some(v) => {
                let s = v.to_string(&txn);
                if s == "null" {
                    None
                } else {
                    Some(s)
                }
            }
            None => None,
        }
    }

    pub fn set_background(&self, color: Option<&str>) {
        let mut txn = self.doc.transact_mut();
        self.meta.insert(&mut txn, BACKGROUND, color.unwrap_or("null"));
    }

    /// The board size. Travels with the document because a joiner starts from
    /// an empty one at a default size, and a stroke at x=3000 is off-canvas on
    /// a board that thinks it is 1920 wide.
    pub fn size(&self) -> (u32, u32) {
        let txn = self.doc.transact();
        let read = |k: &str| match self.meta.get(&txn, k) {
            Some(v) => v.to_string(&txn).parse::<u32>().unwrap_or(0),
            None => 0,
        };
        (read(WIDTH), read(HEIGHT))
    }

    pub fn set_size(&self, width: u32, height: u32) {
        let mut txn = self.doc.transact_mut();
        self.meta.insert(&mut txn, WIDTH, Any::from(width as i64));
        self.meta.insert(&mut txn, HEIGHT, Any::from(height as i64));
    }

    /// Everything, as one update — for a joiner or for the store.
    pub fn snapshot(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// What this board has, so a peer can answer with only what it lacks.
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    /// Just the part `their_state` is missing.
    ///
    /// This is the delta sync the old design could not do: a resync answered
    /// with the whole board because a JSON snapshot has no notion of "what you
    /// already have".
    pub fn diff(&self, their_state: &[u8]) -> Result<Vec<u8>, BoardError> {
        let sv = StateVector::decode_v1(their_state)
            .map_err(|e| BoardError::Update(e.to_string()))?;
        Ok(self.doc.transact().encode_state_as_update_v1(&sv))
    }

    /// Merge an update from a peer or the store. Always a merge, never a
    /// replace — local work drawn while the update was in flight survives.
    pub fn apply(&self, update: &[u8]) -> Result<(), BoardError> {
        let u = Update::decode_v1(update).map_err(|e| BoardError::Update(e.to_string()))?;
        let mut txn = self.doc.transact_mut();
        txn.apply_update(u);
        Ok(())
    }

    /// Who wrote what, for per-author undo — the client id yrs stamps on every
    /// change. Kept as a method rather than stored per shape: the old design
    /// carried an `author` field on every shape's metadata, and yrs already
    /// knows.
    pub fn client_id(&self) -> u64 {
        self.doc.client_id()
    }

    /// The same board, with its edit history dropped.
    ///
    /// Replays the live shapes into a fresh document. Cheap, because the live
    /// state is all this app ever renders — nothing reads back through the
    /// history, there is no server-side revision list, and undo is bounded to
    /// the running session anyway.
    ///
    /// The cost is that it is a NEW document with new ids, so it converges
    /// with a peer's copy only by replacing it wholesale. That makes this safe
    /// exactly where a board has no live peers: on load, or on save. Compacting
    /// mid-session would hand collaborators a document unrelated to the one
    /// they hold, and every edit in flight would land in the gap.
    pub fn compacted(&self) -> Self {
        let fresh = Self::new();
        for shape in self.shapes() {
            if let Some(id) = shape_id(&shape) {
                fresh.put(&id, &shape);
            }
        }
        if let Some(bg) = self.background() {
            fresh.set_background(Some(&bg));
        }
        let (w, h) = self.size();
        if w > 0 || h > 0 {
            fresh.set_size(w, h);
        }
        fresh
    }
}

/// The `id` out of a shape's JSON, without paying for a full parse — this
/// crate deliberately does not know what a shape is, and a serde model of one
/// would be exactly the coupling it avoids.
fn shape_id(shape: &str) -> Option<String> {
    shape
        .split_once("\"id\":\"")
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(id, _)| id.to_string())
}

/// Shapes keyed by id, for a caller that wants to look one up rather than
/// walk the paint order.
pub fn by_id(shapes: &[String]) -> HashMap<String, &String> {
    let mut out = HashMap::new();
    for s in shapes {
        if let Some(id) = shape_id(s) {
            out.insert(id, s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(id: &str, x: i32) -> String {
        format!(r#"{{"id":"{id}","kind":"rect","x":{x},"y":10,"w":50,"h":40}}"#)
    }

    fn ids(b: &Board) -> Vec<String> {
        b.shapes().iter().filter_map(|s| shape_id(s)).collect()
    }

    /// Bring two boards to the same state, both directions.
    fn sync(a: &Board, b: &Board) {
        let for_b = a.diff(&b.state_vector()).unwrap();
        b.apply(&for_b).unwrap();
        let for_a = b.diff(&a.state_vector()).unwrap();
        a.apply(&for_a).unwrap();
    }

    #[test]
    fn a_shape_goes_in_and_comes_back() {
        let b = Board::new();
        b.put("s1", &shape("s1", 10));
        assert_eq!(b.shapes(), vec![shape("s1", 10)]);
        assert_eq!(b.len(), 1);
    }

    #[test]
    fn editing_a_shape_does_not_move_it_in_the_paint_order() {
        // The reason the order is a separate array. A `YMap` alone has no
        // order at all, and re-inserting into one would put the edited shape
        // wherever the map felt like — so a rectangle you recoloured would
        // jump in front of things drawn after it.
        let b = Board::new();
        for id in ["s1", "s2", "s3"] {
            b.put(id, &shape(id, 0));
        }
        b.put("s1", &shape("s1", 99));
        assert_eq!(ids(&b), ["s1", "s2", "s3"], "s1 stays first");
        assert!(b.shapes()[0].contains("\"x\":99"), "and it did change");
    }

    #[test]
    fn two_peers_converge_on_the_same_board() {
        let (a, b) = (Board::new(), Board::new());
        a.put("from-a", &shape("from-a", 1));
        b.put("from-b", &shape("from-b", 2));
        sync(&a, &b);
        assert_eq!(ids(&a), ids(&b), "both peers agree");
        assert_eq!(a.len(), 2);
    }

    #[test]
    fn three_peers_converge_whatever_order_they_meet_in() {
        // The property N-peer rests on. The old CRDT proved this with 35
        // hand-written tests; here it is the library's job and this is the
        // check that it is doing it.
        let boards: Vec<Board> = (0..3).map(|_| Board::new()).collect();
        for (i, b) in boards.iter().enumerate() {
            b.put(&format!("s{i}"), &shape(&format!("s{i}"), i as i32));
        }
        // Gossip in an awkward order: 0<->2, then 1<->0, then 2<->1.
        sync(&boards[0], &boards[2]);
        sync(&boards[1], &boards[0]);
        sync(&boards[2], &boards[1]);
        sync(&boards[0], &boards[1]);
        let first = ids(&boards[0]);
        assert_eq!(first.len(), 3);
        for b in &boards {
            assert_eq!(ids(b), first, "every peer sees the same board, same order");
        }
    }

    #[test]
    fn applying_the_same_update_twice_changes_nothing() {
        // Gossip can deliver a message twice; a board that grew a duplicate
        // shape would diverge from one that did not.
        let a = Board::new();
        a.put("s1", &shape("s1", 1));
        let b = Board::new();
        let u = a.snapshot();
        b.apply(&u).unwrap();
        b.apply(&u).unwrap();
        assert_eq!(ids(&b), ["s1"]);
    }

    #[test]
    fn a_delete_reaches_the_other_peer() {
        let (a, b) = (Board::new(), Board::new());
        a.put("s1", &shape("s1", 1));
        sync(&a, &b);
        a.remove("s1");
        sync(&a, &b);
        assert!(b.is_empty(), "the delete crossed");
        assert_eq!(ids(&b).len(), 0, "and left no orphan in the order");
    }

    #[test]
    fn a_deleted_shape_can_come_back() {
        // How undo-of-a-delete works. The old CRDT needed tombstones and
        // resurrect-by-restamp for this; here it is an ordinary re-insert.
        let b = Board::new();
        b.put("s1", &shape("s1", 1));
        b.remove("s1");
        assert!(b.is_empty());
        b.put("s1", &shape("s1", 2));
        assert_eq!(ids(&b), ["s1"]);
        assert!(b.shapes()[0].contains("\"x\":2"));
    }

    #[test]
    fn a_clear_empties_the_board_for_both_peers() {
        let (a, b) = (Board::new(), Board::new());
        for id in ["s1", "s2"] {
            a.put(id, &shape(id, 0));
        }
        sync(&a, &b);
        a.clear();
        sync(&a, &b);
        assert!(a.is_empty() && b.is_empty());
    }

    #[test]
    fn a_concurrent_stroke_survives_a_clear() {
        // A DELIBERATE change from the CRDT this replaces, which carried a
        // `clearedAt` cutoff that voided anything stamped before it — including
        // a shape the peer was drawing at that moment. Silently destroying
        // someone's work because it raced your clear is hard to defend, and
        // the cutoff was there to make the old merge converge rather than
        // because anyone chose that behaviour.
        let (a, b) = (Board::new(), Board::new());
        a.put("old", &shape("old", 0));
        sync(&a, &b);
        a.clear();
        b.put("drawn-meanwhile", &shape("drawn-meanwhile", 5));
        sync(&a, &b);
        assert_eq!(ids(&a), ["drawn-meanwhile"]);
        assert_eq!(ids(&b), ids(&a), "and both peers agree about it");
    }

    #[test]
    fn the_background_and_the_board_size_travel() {
        // A joiner starts from an empty document at a default size; without
        // these a stroke at x=3000 is off-canvas on one of the two screens.
        let (a, b) = (Board::new(), Board::new());
        a.set_background(Some("#111827"));
        a.set_size(800, 600);
        sync(&a, &b);
        assert_eq!(b.background().as_deref(), Some("#111827"));
        assert_eq!(b.size(), (800, 600));
    }

    #[test]
    fn a_transparent_background_is_not_the_string_null() {
        let b = Board::new();
        b.set_background(Some("#fff"));
        b.set_background(None);
        assert_eq!(b.background(), None);
    }

    #[test]
    fn a_diff_carries_only_what_the_peer_lacks() {
        // The delta sync the old design could not do: it answered every resync
        // with the whole board.
        let (a, b) = (Board::new(), Board::new());
        for i in 0..50 {
            a.put(&format!("s{i}"), &shape(&format!("s{i}"), i));
        }
        sync(&a, &b);
        let whole = a.snapshot().len();
        a.put("one-more", &shape("one-more", 99));
        let delta = a.diff(&b.state_vector()).unwrap().len();
        assert!(delta < whole / 5, "delta {delta} should be far under {whole}");
        b.apply(&a.diff(&b.state_vector()).unwrap()).unwrap();
        assert_eq!(ids(&b).len(), 51);
    }

    #[test]
    fn a_snapshot_round_trips_through_bytes() {
        let a = Board::new();
        a.put("s1", &shape("s1", 7));
        a.set_size(1920, 1080);
        let restored = Board::from_update(&a.snapshot()).unwrap();
        assert_eq!(ids(&restored), ["s1"]);
        assert_eq!(restored.size(), (1920, 1080));
    }

    #[test]
    fn a_damaged_update_is_refused_rather_than_panicking() {
        let b = Board::new();
        let err = b.apply(b"not an update at all").unwrap_err();
        assert!(err.to_string().starts_with("bad_update:"), "{err}");
        assert!(b.is_empty(), "and the board is untouched");
    }

    #[test]
    fn a_long_session_grows_with_the_edits_not_with_the_board() {
        // The honest bound, and a CORRECTION of what this project previously
        // recorded. yrs merges overwrites only when they are contiguous in the
        // writer's item list; a session that round-robins across many shapes
        // interleaves them, so each rewrite costs about ten bytes and they do
        // not settle. Growth tracks how long the board has been open, not how
        // much is on it.
        //
        // This is still far better than what it replaces — a heavy session
        // lands well inside the 700 KB at which the old JSON snapshot had to
        // truncate itself and warn the user — but `compacted` is the answer to
        // a board left open for a week, not a claim that it cannot grow.
        let b = Board::new();
        for i in 0..100 {
            b.put(&format!("s{i}"), &shape(&format!("s{i}"), 0));
        }
        let live = b.snapshot().len();
        for round in 1..30 {
            for i in 0..100 {
                b.put(&format!("s{i}"), &shape(&format!("s{i}"), round));
            }
        }
        let grown = b.snapshot().len();
        assert!(grown > live * 2, "history is real: {live} -> {grown}");
        assert!(
            grown < 200_000,
            "but a heavy session stays well under the old 700 KB cap: {grown}",
        );
    }

    #[test]
    fn compacting_drops_the_history_and_keeps_the_board() {
        let b = Board::new();
        for i in 0..100 {
            b.put(&format!("s{i}"), &shape(&format!("s{i}"), 0));
        }
        b.set_background(Some("#111827"));
        b.set_size(1920, 1080);
        let live = b.snapshot().len();
        for round in 1..30 {
            for i in 0..100 {
                b.put(&format!("s{i}"), &shape(&format!("s{i}"), round));
            }
        }
        let small = b.compacted();
        assert!(
            small.snapshot().len() < live * 2,
            "compacted {} should be near the live {live}",
            small.snapshot().len(),
        );
        assert_eq!(ids(&small), ids(&b), "same shapes, same order");
        assert_eq!(small.shapes(), b.shapes(), "and the same contents");
        assert_eq!(small.background().as_deref(), Some("#111827"));
        assert_eq!(small.size(), (1920, 1080));
    }

    #[test]
    fn a_compacted_board_must_not_be_merged_into_a_peers_copy() {
        // The constraint that decides WHERE compaction may happen: on load or
        // on save, never mid-session.
        //
        // The damage is NOT duplicated shapes — the map is keyed by id, so it
        // collapses. It is the paint ORDER, which is a plain sequence with no
        // key constraint, and a delete that the compaction dropped: the fresh
        // document carries no tombstone, so the peer's copy resurrects it.
        // Measured before this test was written; `shapes()` de-duplicates so
        // the first half is invisible, which is exactly why it is asserted on
        // the raw array rather than through the reader.
        let a = Board::new();
        for i in 0..3 {
            a.put(&format!("s{i}"), &shape(&format!("s{i}"), 0));
        }
        let peer = Board::from_update(&a.snapshot()).unwrap();
        a.remove("s1");
        peer.apply(&a.compacted().snapshot()).unwrap();

        assert!(
            peer.order_len() > peer.len(),
            "the order array duplicates where the map cannot",
        );
        assert!(
            ids(&peer).contains(&"s1".to_string()),
            "and a delete the compaction dropped comes back",
        );
    }

    #[test]
    fn a_duplicated_id_in_the_order_still_renders_once() {
        // The guard that keeps the above from being a VISIBLE bug. A merge can
        // leave an id in the order twice; drawing the shape twice would be
        // wrong for a document the CRDT considers converged.
        let a = Board::new();
        a.put("s1", &shape("s1", 1));
        let peer = Board::from_update(&a.snapshot()).unwrap();
        peer.apply(&a.compacted().snapshot()).unwrap();
        assert!(peer.order_len() > 1, "the order really did duplicate");
        assert_eq!(ids(&peer), ["s1"], "but it renders once");
    }

    #[test]
    fn two_peers_editing_one_shape_end_up_agreeing() {
        let (a, b) = (Board::new(), Board::new());
        a.put("contested", &shape("contested", 1));
        sync(&a, &b);
        a.put("contested", &shape("contested", 10));
        b.put("contested", &shape("contested", 20));
        sync(&a, &b);
        assert_eq!(a.shapes(), b.shapes(), "one winner, and both agree who");
        assert_eq!(a.len(), 1, "and not two copies");
    }
}
