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
export const collab = createCollabSession(tauriTransport(), {
  store: tauriBoardStore(),
  boardId: () => board,
});
