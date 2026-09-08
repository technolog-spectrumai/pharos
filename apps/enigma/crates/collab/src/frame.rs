// What travels on the topic.
//
// The crate deliberately knows nothing about shapes. A frame carries opaque
// `bytes` and the session's job is delivery, not meaning — which is what lets
// the same transport serve a drawing board, a spreadsheet, or anything else
// that converges. The CRDT lives in the app (`apps/sketch/src/sketch/
// sketchCrdt.ts`); this is the pipe.
//
// Two classes of frame, and the distinction is the whole design:
//
//   COMMITTED (`Op`, `Snapshot`) carry a per-author `seq`. A gap means a lost
//   frame and the receiver asks for a resync. These must not be dropped.
//
//   EPHEMERAL (`Live`, `Cursor`) carry no `seq` and may be dropped freely.
//   A stroke in progress is redrawn 20 times a second; losing one is invisible,
//   and making them reliable would put a retransmit queue in front of the
//   frames that actually matter.
//
// `Hello` and `Welcome` are the handshake. `Resync` is the repair path — see
// the note on `Lagged` in `session.rs`, which is the reason it exists at all.

use serde::{Deserialize, Serialize};

/// Bumped only for a breaking change. A peer that meets a version it does not
/// know refuses the session rather than misreading the stream — the same
/// reasoning as enigma's ALPN version bump: *"a v0 peer cannot negotiate this
/// ALPN, so a version skew fails to connect instead of misreading the stream."*
pub const PROTO_V: u16 = 1;

// No `Eq`: `Cursor` carries f32 coordinates, and floats have no total
// equality. `PartialEq` is what the round-trip tests need anyway.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Frame {
    /// Joiner → host, first frame. Echoes the ticket nonce, which is what makes
    /// a photographed-and-replayed ticket fail after the real peer paired.
    Hello {
        proto: u16,
        nonce: [u8; 16],
    },
    /// Host → joiner, once it has accepted. Carries the board so the joiner
    /// draws on the same canvas — a joiner that assumed a default size would
    /// put the host's stroke at x=3000 off its own edge.
    Welcome {
        proto: u16,
        width: u32,
        height: u32,
    },
    /// A committed change. `seq` is per author and monotonic; a gap is a lost
    /// frame, which the receiver answers with `Resync`.
    Op {
        seq: u64,
        bytes: Vec<u8>,
    },
    /// The whole document, for a joiner or after a `Resync`.
    Snapshot {
        seq: u64,
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    },
    /// A stroke in progress. Dropped freely; never persisted.
    Live {
        bytes: Vec<u8>,
    },
    /// A pointer position. Presence only.
    Cursor {
        x: f32,
        y: f32,
    },
    /// "I missed something — send me everything." Answered with `Snapshot`.
    Resync,
    /// A clean goodbye, so the peer clears the cursor and any half-drawn
    /// stroke at once instead of waiting for the ~15s idle timeout.
    Bye,
}

impl Frame {
    /// Whether losing this frame would lose work.
    ///
    /// Used by the receive path to decide if a `seq` gap matters: an ephemeral
    /// frame has no `seq` and no claim on reliability.
    pub fn is_committed(&self) -> bool {
        matches!(self, Frame::Op { .. } | Frame::Snapshot { .. })
    }

    /// The per-author sequence number, for the frames that carry one.
    pub fn seq(&self) -> Option<u64> {
        match self {
            Frame::Op { seq, .. } | Frame::Snapshot { seq, .. } => Some(*seq),
            _ => None,
        }
    }
}

pub fn encode(frame: &Frame) -> Result<Vec<u8>, String> {
    postcard::to_stdvec(frame).map_err(|e| format!("bad_frame: {e}"))
}

pub fn decode(bytes: &[u8]) -> Result<Frame, String> {
    postcard::from_bytes(bytes).map_err(|_| "bad_frame: damaged or truncated".to_string())
}

/// Tracks one peer's committed stream and reports a gap.
///
/// Gossip does not promise ordering, so this tolerates REORDERING as well as
/// loss: a frame that arrives out of turn is remembered, and only a sequence
/// that never fills in is reported missing. Enigma's receive loop ignores
/// `Event::Lagged` entirely (`p2p_iroh.rs:637`), which is survivable for chat
/// and is not for a document that must converge.
#[derive(Debug, Default)]
pub struct SeqTracker {
    /// Highest contiguous seq delivered.
    contiguous: u64,
    /// Seen but not yet contiguous — arrived early.
    ahead: std::collections::BTreeSet<u64>,
    started: bool,
}

impl SeqTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a committed frame. Returns true when there is a hole — the
    /// caller should ask for a resync.
    pub fn observe(&mut self, seq: u64) -> bool {
        if !self.started {
            // The first frame seen sets the baseline: a peer may join a session
            // already in progress, and everything before it is not "missing",
            // it is simply before we arrived.
            self.started = true;
            self.contiguous = seq;
            return false;
        }
        if seq <= self.contiguous {
            return false; // duplicate or late; harmless
        }
        self.ahead.insert(seq);
        while self.ahead.remove(&(self.contiguous + 1)) {
            self.contiguous += 1;
        }
        !self.ahead.is_empty()
    }

    /// Highest seq with no hole beneath it.
    pub fn contiguous(&self) -> u64 {
        self.contiguous
    }

    /// Forget the history — called after a snapshot has re-based the document.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_frame_round_trips() {
        let frames = vec![
            Frame::Hello { proto: PROTO_V, nonce: [3u8; 16] },
            Frame::Welcome { proto: PROTO_V, width: 1920, height: 1080 },
            Frame::Op { seq: 7, bytes: vec![1, 2, 3] },
            Frame::Snapshot { seq: 9, width: 800, height: 600, bytes: vec![4] },
            Frame::Live { bytes: vec![5, 6] },
            Frame::Cursor { x: 1.5, y: -2.5 },
            Frame::Resync,
            Frame::Bye,
        ];
        for f in frames {
            assert_eq!(decode(&encode(&f).unwrap()).unwrap(), f, "{f:?}");
        }
    }

    #[test]
    fn a_damaged_frame_is_refused_rather_than_panicking() {
        assert!(decode(&[]).is_err());
        assert!(decode(&[0xff, 0xff, 0xff]).is_err());
        let good = encode(&Frame::Op { seq: 1, bytes: vec![1, 2, 3, 4] }).unwrap();
        assert!(decode(&good[..good.len() / 2]).is_err());
    }

    #[test]
    fn only_committed_frames_claim_reliability() {
        assert!(Frame::Op { seq: 1, bytes: vec![] }.is_committed());
        assert!(Frame::Snapshot { seq: 1, width: 1, height: 1, bytes: vec![] }.is_committed());
        // Ephemeral: dropping one is invisible, so it carries no seq.
        assert!(!Frame::Live { bytes: vec![] }.is_committed());
        assert!(!Frame::Cursor { x: 0.0, y: 0.0 }.is_committed());
        assert_eq!(Frame::Live { bytes: vec![] }.seq(), None);
        assert_eq!(Frame::Op { seq: 42, bytes: vec![] }.seq(), Some(42));
    }

    #[test]
    fn a_contiguous_stream_reports_no_gap() {
        let mut t = SeqTracker::new();
        for seq in 1..=5 {
            assert!(!t.observe(seq), "seq {seq} should not report a gap");
        }
        assert_eq!(t.contiguous(), 5);
    }

    #[test]
    fn a_hole_is_reported_and_then_healed_when_it_fills() {
        let mut t = SeqTracker::new();
        t.observe(1);
        assert!(t.observe(3), "3 after 1 leaves a hole at 2");
        assert_eq!(t.contiguous(), 1);
        assert!(!t.observe(2), "the hole is filled");
        assert_eq!(t.contiguous(), 3);
    }

    #[test]
    fn reordering_alone_is_not_a_gap_once_it_settles() {
        // Gossip gives no ordering guarantee, so out-of-order delivery must not
        // trigger a resync storm — only a sequence that never arrives should.
        let mut t = SeqTracker::new();
        t.observe(1);
        assert!(t.observe(4), "4 before 2 and 3 is a hole, for now");
        assert!(t.observe(3), "still a hole: 2 has not arrived");
        assert!(!t.observe(2), "2 closes it — reordering alone is not loss");
        assert_eq!(t.contiguous(), 4, "all four are now contiguous");
    }

    #[test]
    fn a_duplicate_is_harmless() {
        let mut t = SeqTracker::new();
        t.observe(1);
        t.observe(2);
        assert!(!t.observe(2), "a replay must not look like a gap");
        assert_eq!(t.contiguous(), 2);
    }

    #[test]
    fn joining_mid_session_is_not_a_gap() {
        // The first frame we ever see sets the baseline: everything before it
        // happened before we arrived and is not missing.
        let mut t = SeqTracker::new();
        assert!(!t.observe(1000));
        assert_eq!(t.contiguous(), 1000);
    }
}
