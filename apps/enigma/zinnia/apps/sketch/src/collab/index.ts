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

export const collab = createCollabSession(tauriTransport());
