//! The whole lifecycle, over the real crates.
//!
//! Everything else in this repo tests one seam: the CRDT converges, the store
//! round-trips, the session sends what the board produced. This is the one
//! that puts them together and asks the question a user would — draw, pair,
//! both edit, close the app, come back, keep drawing with the same peer.
//!
//! It lives here rather than in the frontend because both halves are Rust and
//! the IPC layer in between is three lines of shim per command. What it would
//! not catch is a mistake in that shim; `apps/sketch/tests/unit/collabYrs`
//! drives the same crate through a process for exactly that reason.

use board::Board;
use hoard::Hoard;

fn shape(id: &str, x: i32) -> String {
    format!(r#"{{"id":"{id}","kind":"rect","x":{x},"y":10,"w":50,"h":40}}"#)
}

fn ids(b: &Board) -> Vec<String> {
    b.shapes()
        .iter()
        .filter_map(|s| {
            s.split_once("\"id\":\"")
                .and_then(|(_, r)| r.split_once('"'))
                .map(|(i, _)| i.to_string())
        })
        .collect()
}

#[test]
fn a_drawing_survives_a_session_a_restart_and_a_rejoin() {

    let dir = tempfile::tempdir().unwrap();

    // Host draws, joiner joins mid-session, both draw, both converge.
    let host = Board::new();
    host.set_size(1920, 1080);
    host.set_background(Some("#111827"));
    host.put("h1", &shape("h1", 10));
    host.put("h2", &shape("h2", 60));

    let joiner = Board::from_update(&host.snapshot()).unwrap();
    assert_eq!(ids(&joiner), ["h1", "h2"], "joiner gets the board");
    assert_eq!(joiner.size(), (1920, 1080), "and the canvas size");
    assert_eq!(joiner.background().as_deref(), Some("#111827"));

    // Concurrent edits, exchanged as deltas.
    host.put("h3", &shape("h3", 110));
    joiner.put("j1", &shape("j1", 300));
    let to_j = host.diff(&joiner.state_vector()).unwrap();
    let to_h = joiner.diff(&host.state_vector()).unwrap();
    joiner.apply(&to_j).unwrap();
    host.apply(&to_h).unwrap();
    assert_eq!(ids(&host), ids(&joiner), "converged");
    assert_eq!(ids(&host).len(), 4);

    // The host saves; the app is killed; it comes back.
    {
        let store = Hoard::open(dir.path()).unwrap();
        store.save("plan.svg", &host.snapshot()).unwrap();
    }
    let restored = {
        let store = Hoard::open(dir.path()).unwrap();
        Board::from_update(&store.load("plan.svg").unwrap().unwrap()).unwrap()
    };
    assert_eq!(ids(&restored), ids(&host), "survived the restart");
    assert_eq!(restored.size(), (1920, 1080));
    assert_eq!(restored.background().as_deref(), Some("#111827"));

    // The restored board rejoins and still converges with the peer.
    joiner.put("j2", &shape("j2", 400));
    restored.apply(&joiner.diff(&restored.state_vector()).unwrap()).unwrap();
    joiner.apply(&restored.diff(&joiner.state_vector()).unwrap()).unwrap();
    assert_eq!(ids(&restored), ids(&joiner), "rejoined and converged");

    // Nothing but the board on disk.
    let raw = {
        let store = Hoard::open(dir.path()).unwrap();
        store.load("plan.svg").unwrap().unwrap()
    };
    let text = String::from_utf8_lossy(&raw).to_lowercase();
    for forbidden in ["nonce", "welcome", "key_package", "endpoint", "secret", "ticket"] {
        assert!(!text.contains(forbidden), "{forbidden} reached the disk");
    }}
