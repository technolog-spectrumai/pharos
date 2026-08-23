// i18n keys for the four grantable data classes (peerSyncModel's PEER_SCOPES).
// Written once, here, rather than per component: a label or a "what this
// actually shares" line that drifts from what the scope really sends is a
// consent bug, not a copy bug.

import { PEER_SCOPES, type PeerScope } from "rakotis";

const SUFFIX: Record<PeerScope, string> = {
  calendar: "Calendar",
  history: "History",
  board: "Board",
  card: "Card",
};

export function scopeLabelKey(scope: PeerScope): string {
  return `peers.scope${SUFFIX[scope]}`;
}

export function scopeDescKey(scope: PeerScope): string {
  return `peers.scope${SUFFIX[scope]}Desc`;
}

/** `scopes` in PEER_SCOPES (wire) order, so chips never reshuffle between the
 *  request dialog and the links panel. */
export function orderScopes(scopes: readonly PeerScope[]): PeerScope[] {
  return PEER_SCOPES.filter((s) => scopes.includes(s));
}

/** Tick/untick `scope` in `scopes`, keeping the result in wire order. */
export function toggleScope(scopes: readonly PeerScope[], scope: PeerScope): PeerScope[] {
  return scopes.includes(scope)
    ? scopes.filter((s) => s !== scope)
    : orderScopes([...scopes, scope]);
}
