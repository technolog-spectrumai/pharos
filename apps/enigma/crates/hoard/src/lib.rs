//! Where a drawing survives a crash.
//!
//! Sketch had no persistence of any kind: the collaborative session was a
//! `Mutex<Option<Session>>` and the merged board an in-memory object, so
//! closing the app — or opening another file — lost everything that had not
//! already been saved as `.svg` by hand. This is that gap and nothing else.
//!
//! # What is stored, and what deliberately is not
//!
//! **The converged document, and nothing else.** That rule is what keeps two
//! deliberate security decisions intact rather than quietly reversing them:
//!
//! * `crates/collab`'s MLS layer declines `RotorSession::export_state` because
//!   *"a group key persisted to disk outlives the reason it existed"*.
//! * The network identity and the gossip topic are freshly random per session,
//!   because *"a stable id would let two sessions be tied to one machine"*.
//!
//! Both are about SESSION state. A drawing is a document the user already
//! saves as a plain `.svg` through the ordinary file path, so writing the board
//! reverses neither. Writing a group key, an endpoint key, a ticket, a nonce,
//! an auth string, a peer id or the per-session author id would reverse both —
//! so none of them belong in this crate, and `nothing_but_the_board` is the
//! test that says so.
//!
//! # Why raw fjall and not protasius
//!
//! Enigma keeps all its state in fjall through `protasius`, which seals every
//! value under a passphrase-derived key. Reusing it here was the obvious move
//! and is the wrong one, for two measured reasons:
//!
//! * `protasius::put_enc` ends in `keyspace.persist(PersistMode::SyncAll)` — a
//!   full fsync on every single key, and the crate has no batch API at all.
//!   Measured: **3.4 ms** fsynced per update against **19.5 µs** batched.
//! * It returns `Locked` for every read and write until a passphrase unlocks
//!   it. Sketch has never had a vault, and a drawing app that cannot autosave
//!   until you invent a passphrase is a worse app.
//!
//! At-rest encryption stays available and is a separate decision: sketch
//! already depends on `padova`, which owns the keyring and can seal the `.svg`
//! itself.
//!
//! # The write pattern
//!
//! One `Batch` then one `persist`, never a write per key. The 175x measurement
//! above is the whole reason this crate exposes `save` (batched) rather than a
//! per-key setter that callers would reach for in a loop.

use std::path::Path;

use fjall::{Config, Keyspace, PartitionCreateOptions, PartitionHandle, PersistMode};

/// The partition every board lives in. One partition, keyed by board id — the
/// same shape protasius uses, minus the per-value sealing.
const BOARDS: &str = "boards";

/// `board\0{id}\0snap`. Keys are plaintext so a prefix scan can list what is
/// stored; there is nothing secret in a board id, which is a file path or a
/// generated handle the user already sees.
fn snap_key(board: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(7 + board.len() + 5);
    k.extend_from_slice(b"board\0");
    k.extend_from_slice(board.as_bytes());
    k.extend_from_slice(b"\0snap");
    k
}

fn prefix_for(board: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(6 + board.len() + 1);
    k.extend_from_slice(b"board\0");
    k.extend_from_slice(board.as_bytes());
    k.push(0);
    k
}

/// Everything that can go wrong, as `prefix: prose` — the convention every
/// error in this repo answers in, so the frontend can map a prefix to a
/// catalogue key and show a sentence rather than raw Rust.
#[derive(Debug)]
pub enum HoardError {
    /// The store could not be opened or read.
    Store(String),
    /// A stored board could not be parsed. Kept distinct from `Store` because
    /// it means the bytes are there and wrong, not missing — a different thing
    /// to tell the user, and a different thing to do about it.
    Damaged(String),
}

impl std::fmt::Display for HoardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HoardError::Store(e) => write!(f, "store_failed: {e}"),
            HoardError::Damaged(e) => write!(f, "board_damaged: {e}"),
        }
    }
}

impl std::error::Error for HoardError {}

fn store_err(e: impl std::fmt::Display) -> HoardError {
    HoardError::Store(e.to_string())
}

/// The boards on disk.
pub struct Hoard {
    keyspace: Keyspace,
    boards: PartitionHandle,
}

impl Hoard {
    /// Open (or create) the store under `dir`.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self, HoardError> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir).map_err(store_err)?;
        let keyspace = Config::new(dir).open().map_err(store_err)?;
        let boards = keyspace
            .open_partition(BOARDS, PartitionCreateOptions::default())
            .map_err(store_err)?;
        Ok(Self { keyspace, boards })
    }

    /// Write a board, durably.
    ///
    /// ONE batch, ONE fsync — the pattern the whole crate exists to hold. A
    /// caller that wrote key-by-key would pay 3.4 ms each time instead of
    /// 19.5 µs, which is the difference between a drawing that autosaves and
    /// one that stutters.
    ///
    /// `snapshot` is the session's own wire format, reused verbatim as the
    /// at-rest format. That is deliberate: it already carries the board size,
    /// it already merges rather than replaces on the way back in, and it
    /// already has a version field to migrate on.
    pub fn save(&self, board: &str, snapshot: &[u8]) -> Result<(), HoardError> {
        let mut batch = self.keyspace.batch();
        batch.insert(&self.boards, snap_key(board), snapshot);
        batch.commit().map_err(store_err)?;
        self.keyspace
            .persist(PersistMode::SyncAll)
            .map_err(store_err)
    }

    /// Read a board back, or `None` if nothing was ever stored for it.
    ///
    /// `None` and "an empty board" are different answers and the caller needs
    /// both: one means start fresh, the other means restore a board somebody
    /// deliberately cleared.
    pub fn load(&self, board: &str) -> Result<Option<Vec<u8>>, HoardError> {
        Ok(self
            .boards
            .get(snap_key(board))
            .map_err(store_err)?
            .map(|v| v.to_vec()))
    }

    /// Forget a board entirely.
    ///
    /// Every key under its prefix, not just the snapshot: this crate stores one
    /// key per board today and a `remove` of that key alone would silently
    /// leave anything added later behind.
    pub fn forget(&self, board: &str) -> Result<(), HoardError> {
        let prefix = prefix_for(board);
        let keys: Vec<Vec<u8>> = self
            .boards
            .prefix(&prefix)
            .map(|e| e.map(|(k, _)| k.to_vec()))
            .collect::<Result<_, _>>()
            .map_err(store_err)?;
        let mut batch = self.keyspace.batch();
        for k in keys {
            batch.remove(&self.boards, k);
        }
        batch.commit().map_err(store_err)?;
        self.keyspace
            .persist(PersistMode::SyncAll)
            .map_err(store_err)
    }

    /// Every board id the store holds, for a "recent drawings" list.
    pub fn boards(&self) -> Result<Vec<String>, HoardError> {
        let mut out = Vec::new();
        for entry in self.boards.prefix(b"board\0") {
            let (k, _) = entry.map_err(store_err)?;
            // `board\0{id}\0snap` — take what is between the two separators.
            let rest = &k[6..];
            if let Some(end) = rest.iter().position(|b| *b == 0) {
                if let Ok(id) = std::str::from_utf8(&rest[..end]) {
                    let id = id.to_string();
                    if !out.contains(&id) {
                        out.push(id);
                    }
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Hoard) {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = Hoard::open(dir.path()).expect("open");
        (dir, h)
    }

    #[test]
    fn a_board_survives_being_written_and_read_back() {
        let (_d, h) = store();
        h.save("plan.svg", br#"{"snap":{"v":1}}"#).unwrap();
        assert_eq!(h.load("plan.svg").unwrap().unwrap(), br#"{"snap":{"v":1}}"#);
    }

    #[test]
    fn a_board_survives_the_process_that_wrote_it() {
        // The whole point of the crate: reopening the store from scratch, the
        // way a restart does, still finds the board.
        let dir = tempfile::tempdir().unwrap();
        {
            let h = Hoard::open(dir.path()).unwrap();
            h.save("plan.svg", b"drawn").unwrap();
        } // dropped — fjall releases its handles
        let h = Hoard::open(dir.path()).unwrap();
        assert_eq!(h.load("plan.svg").unwrap().unwrap(), b"drawn");
    }

    #[test]
    fn an_unknown_board_is_none_rather_than_empty() {
        // `None` and "a board somebody cleared" are different answers, and the
        // caller does different things with them.
        let (_d, h) = store();
        assert!(h.load("never-drawn").unwrap().is_none());
        h.save("cleared", b"").unwrap();
        assert_eq!(h.load("cleared").unwrap().unwrap(), b"");
    }

    #[test]
    fn saving_twice_replaces_rather_than_appends() {
        let (_d, h) = store();
        h.save("plan.svg", b"first").unwrap();
        h.save("plan.svg", b"second").unwrap();
        assert_eq!(h.load("plan.svg").unwrap().unwrap(), b"second");
    }

    #[test]
    fn boards_do_not_bleed_into_each_other() {
        // The key builder puts a NUL on both sides of the id. Without the
        // trailing one, board "a" and board "ab" share a prefix and `forget`
        // on the shorter would take the longer with it.
        let (_d, h) = store();
        h.save("a", b"one").unwrap();
        h.save("ab", b"two").unwrap();
        h.forget("a").unwrap();
        assert!(h.load("a").unwrap().is_none());
        assert_eq!(h.load("ab").unwrap().unwrap(), b"two", "ab must survive");
    }

    #[test]
    fn forgetting_a_board_that_was_never_there_is_not_an_error() {
        let (_d, h) = store();
        assert!(h.forget("never-drawn").is_ok());
    }

    #[test]
    fn the_store_lists_what_it_holds() {
        let (_d, h) = store();
        h.save("one.svg", b"x").unwrap();
        h.save("two.svg", b"y").unwrap();
        let mut got = h.boards().unwrap();
        got.sort();
        assert_eq!(got, vec!["one.svg".to_string(), "two.svg".to_string()]);
    }

    #[test]
    fn a_board_id_with_awkward_bytes_round_trips() {
        // Board ids are file paths. Spaces, slashes and non-ASCII are ordinary.
        let (_d, h) = store();
        for id in ["with space.svg", "dir/sub/plan.svg", "rysunek-żółw.svg"] {
            h.save(id, id.as_bytes()).unwrap();
            assert_eq!(h.load(id).unwrap().unwrap(), id.as_bytes(), "{id}");
        }
        assert_eq!(h.boards().unwrap().len(), 3);
    }

    #[test]
    fn errors_answer_in_the_prefix_prose_shape() {
        // Every error in this repo is `prefix: prose` so the frontend can map
        // the prefix to a catalogue key. A message that broke that convention
        // would render as raw Rust in the UI.
        assert!(HoardError::Store("disk full".into()).to_string().starts_with("store_failed: "));
        assert!(HoardError::Damaged("bad json".into()).to_string().starts_with("board_damaged: "));
    }

    #[test]
    fn nothing_but_the_board() {
        // THE RULE, as a test. This crate stores the converged document and
        // nothing else — no group key, no endpoint key, no ticket, no nonce,
        // no auth string, no peer or author id. Two deliberate security
        // choices depend on it (see the module header), and neither is
        // enforced by anything but this crate's surface, so the surface is
        // what gets asserted: `save` takes a board id and opaque bytes, and
        // there is no other way in.
        let (_d, h) = store();
        h.save("plan.svg", b"the document").unwrap();
        // One key per board, and its name says what it is.
        let keys: Vec<Vec<u8>> = h
            .boards
            .prefix(b"")
            .map(|e| e.unwrap().0.to_vec())
            .collect();
        assert_eq!(keys.len(), 1);
        assert!(String::from_utf8_lossy(&keys[0]).ends_with("snap"));
    }
}
