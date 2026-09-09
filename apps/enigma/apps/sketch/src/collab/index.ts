// The one collaboration session this app runs.
//
// A singleton, deliberately, and not because there could not be two: a board
// pairs with one peer, the session must outlive the Collab tab (you switch to
// the Sketch tab to draw), and the editor must be able to end it when the
// drawing it was about changes. Three places, one object, no third copy of
// "are we paired" to keep in step — the same reasoning App.vue gives for its
// host registry.
//
// The transport is the real one; tests build their own session over an
// in-memory bus (tests/helpers/fakeBus.ts) and never touch this.
import { createCollabSession } from "./useCollabSession";
import { tauriTransport } from "./transport";
import { tauriBoardStore } from "./persist";
import { documentAvailable, tauriBoardDoc } from "./document";

/** Which drawing is being autosaved.
 *
 *  The file path when there is one, so reopening the same file finds its board.
 *  A never-saved drawing shares one slot: it is the scratch board, and there is
 *  only ever one of it on screen. Set by the editor as files open and close. */
let board = "untitled";

export function setBoardId(path: string | null) {
  board = path ?? "untitled";
}

// The store is the real one. It is behind a Cargo feature that is off by
// default, so on a build without it every call rejects — `saveNow` catches
// that and surfaces it once rather than throwing into the editor, and nothing
// else changes. Persistence is a capability, not a requirement.
// The document is the yrs board in Rust, and it is PROBED rather than passed
// unconditionally. It sits behind a Cargo feature that is off by default, and
// unlike the store it is not optional to the session: with a board handle
// every stroke goes through Rust, so handing one to a build that has no
// `doc_*` commands would fail on every commit instead of degrading. Probing
// makes the older in-memory path the honest fallback.
//
// The probe is asynchronous and the session is created at import time, so the
// handle starts null and is filled in when the answer arrives. That is safe
// because nothing can have drawn yet: the editor mounts, opens a file and only
// then commits, all of which are later than an already-resolved import.
export const collab = createCollabSession(tauriTransport(), {
  store: tauriBoardStore(),
  boardId: () => board,
});

/** Resolves once the document backend has been settled either way. */
export const documentReady = documentAvailable().then((ok) => {
  if (ok) collab.useDocument(tauriBoardDoc());
  return ok;
});
