// Peer-link model — pure types, conflict clock, validation and merge logic for
// person-to-person sync. No Vue/Tauri imports (the deviceSyncModel.ts pattern):
// everything here is wire- and storage-shape logic shared by usePeerSync, the
// Peers UI, and (field-for-field) the Rust handshake in peer_link.rs.
//
// This is NOT deviceSyncModel with a different name. Linked-device sync assumes
// every peer is the same human and therefore filters nothing; a peer link
// assumes the opposite. Three rules follow, and every function here obeys them:
//
//   • Per-peer allow-list. `PEER_SCOPE_KV` is scoped BY GRANT, not global —
//     never `DEVLINK_SYNC_KV`, which carries `p2p:rooms` (bearer join tickets
//     and codes for every room you are in) and your whole contact list.
//   • Per-direction grants. What I send is bounded by MY scopes; what I accept
//     is bounded by THEIRS. Both are enforced, on both sides.
//   • No clock trust. Conflicts resolve by a counter that only advances on a
//     real local edit, tie-broken by NodeId — never by a wall clock, which the
//     receiver cannot verify and which (with exactly two peers and no relay) a
//     fast or lying clock would win forever.
//
// Wire safety: every payload that can arrive over the plink MLS seam is
// re-validated here on receive — never trust a wire object.

// ── Caps ──────────────────────────────────────────────────────────────────────

export const PLINK_VERSION = 1;
/** Max simultaneous peer links — each owns a headless channel (an MLS group +
 *  gossip subscription), so this is a real resource rail, not just UI. */
export const PEER_LINK_MAX = 8;
export const PEER_NAME_MAX_LEN = 200;
export const PEER_NODE_ID_MAX_LEN = 128;
/** Items per plink_cal / plink_board frame (well under network.max_frame_bytes). */
export const PEER_ITEM_CHUNK_MAX = 100;
export const PEER_MEETINGS_MAX = 500;
export const PEER_CARDS_MAX = 1;
export const PEER_BOARD_CARDS_MAX = 500;
export const PEER_BOARD_COLUMNS_MAX = 20;
export const PEER_TEXT_MAX_LEN = 4000;
export const PEER_TITLE_MAX_LEN = 200;
/** Messages per plink_hist frame — mirrors DLINK_HISTORY_CHUNK_MAX_MSGS. */
export const PLINK_HISTORY_CHUNK_MAX_MSGS = 100;

/** HMAC input label for the key-package admission proof (domain separation).
 *  The Rust side mirrors this byte-for-byte; note the `plink` namespace — a
 *  devlink proof must never validate here or vice versa. */
export const PEER_HMAC_LABEL_KP = "enigma/plink/v1/kp";

// ── Scopes ────────────────────────────────────────────────────────────────────

/** The independently grantable data classes (peer.md P2). */
export const PEER_SCOPES = ["calendar", "history", "board", "card"] as const;
export type PeerScope = (typeof PEER_SCOPES)[number];

export function isPeerScope(x: unknown): x is PeerScope {
  return typeof x === "string" && (PEER_SCOPES as readonly string[]).includes(x);
}

/** Narrow an arbitrary wire array to a deduped, ordered scope set. */
export function validateScopes(x: unknown): PeerScope[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<PeerScope>();
  for (const s of x) if (isPeerScope(s)) seen.add(s);
  return PEER_SCOPES.filter((s) => seen.has(s));
}

/** The kv key each scope owns, parameterised by peer — the per-peer analogue of
 *  DEVLINK_SYNC_KV. `history` has no entry: it is the one class that merges
 *  into real app state (`chat:log/<slug>`) rather than a per-peer mirror. */
export function peerScopeKv(scope: Exclude<PeerScope, "history">, nodeId: string) {
  const ns = scope === "calendar" ? "peer:cal" : scope === "board" ? "peer:board" : "peer:card";
  return { ns, scope: nodeId, k: "" };
}

/** The complete set of namespaces peer sync may ever write. A pinning test
 *  guards this list — anything not here is out of reach of a peer, by
 *  construction. `chat:log` is included for history backfill (merge-only). */
export const PEER_SCOPE_KV: readonly string[] = [
  "peer:cal", "peer:board", "peer:card", "chat:log",
] as const;

export function isPeerWritableNs(ns: string): boolean {
  return PEER_SCOPE_KV.includes(ns);
}

// ── Conflict clock ────────────────────────────────────────────────────────────
// Per-item {counter, author}. The counter advances ONLY when this device makes
// a real local edit — never on resend, never from a clock. Higher counter wins;
// equal counters break by the lexicographically lower NodeId, so both sides
// converge on the same answer without trusting anything on the wire.

export interface LClock {
  /** Monotonic per-item edit counter. */
  c: number;
  /** NodeId of the device that made that edit (the tiebreak key). */
  by: string;
}

export function validateLClock(x: unknown): LClock | null {
  if (!isRecord(x)) return null;
  if (!isFinite_(x.c) || x.c < 0 || !Number.isInteger(x.c)) return null;
  if (!isNonEmptyString(x.by, PEER_NODE_ID_MAX_LEN)) return null;
  return { c: x.c, by: x.by };
}

/** Does `incoming` beat `local`? Absent local always loses; ties go to the
 *  lower NodeId. Deterministic and symmetric — both peers compute the same
 *  winner from the same pair. */
export function lclockWins(incoming: LClock, local: LClock | undefined): boolean {
  if (!local) return true;
  if (incoming.c !== local.c) return incoming.c > local.c;
  if (incoming.by === local.by) return false; // same author, same counter: no news
  return incoming.by < local.by;
}

/** The clock for a fresh local edit: one past whatever we last saw for it. */
export function bumpClock(prev: LClock | undefined, me: string): LClock {
  return { c: (prev?.c ?? 0) + 1, by: me };
}

// ── validation helpers (mirrors deviceSyncModel's, kept local so this module
//    stays dependency-free) ───────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFinite_(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNonEmptyString(x: unknown, max: number): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= max;
}

const B64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

// ── Grant ─────────────────────────────────────────────────────────────────────
// One per peer, stored sealed at `peers/<nodeId>/""`. Holds BOTH directions:
// `myScopes` is what I share with them, `theirScopes` is what they share with
// me. Each side maintains its own record; the two are not required to agree
// beyond the handshake that created them (peer.md P3).

export interface PeerGrant {
  v: typeof PLINK_VERSION;
  /** The peer's stable iroh NodeId — the identity and the storage key. */
  peerNodeId: string;
  /** Their display name as of the handshake (presentation only, never trusted). */
  peerName: string;
  /** base64 32-byte pairwise link key, minted by the requester at accept time. */
  linkKey: string;
  /** Hidden gossip room name, derived Rust-side from linkKey (blake3). */
  roomName: string;
  /** 16-digit fingerprint of the two NodeIds, shown for out-of-band comparison. */
  safetyNumber: string;
  /** What I share with them. */
  myScopes: PeerScope[];
  /** What they share with me. */
  theirScopes: PeerScope[];
  /** True when I opened the request (I minted the link key). */
  initiator: boolean;
  createdAt: number;
  /** Monotonic revision — bumped whenever either scope set changes. */
  rev: number;
  /** Unix ms when revoked; the record stays as a tombstone so admission stays
   *  refused even though the peer still knows the link key. */
  revokedAt?: number;
}

export function validatePeerGrant(x: unknown): PeerGrant | null {
  if (!isRecord(x) || x.v !== PLINK_VERSION) return null;
  if (!isNonEmptyString(x.peerNodeId, PEER_NODE_ID_MAX_LEN)) return null;
  if (typeof x.peerName !== "string" || x.peerName.length > PEER_NAME_MAX_LEN) return null;
  if (typeof x.linkKey !== "string" || !B64_32_BYTES.test(x.linkKey)) return null;
  if (!isNonEmptyString(x.roomName, 256)) return null;
  if (typeof x.safetyNumber !== "string" || x.safetyNumber.length > 40) return null;
  if (!isFinite_(x.createdAt) || x.createdAt < 0) return null;
  if (!isFinite_(x.rev) || x.rev < 0) return null;
  const grant: PeerGrant = {
    v: PLINK_VERSION,
    peerNodeId: x.peerNodeId,
    peerName: x.peerName,
    linkKey: x.linkKey,
    roomName: x.roomName,
    safetyNumber: x.safetyNumber,
    myScopes: validateScopes(x.myScopes),
    theirScopes: validateScopes(x.theirScopes),
    initiator: x.initiator === true,
    createdAt: x.createdAt,
    rev: x.rev,
  };
  if (isFinite_(x.revokedAt) && x.revokedAt > 0) grant.revokedAt = x.revokedAt;
  return grant;
}

export function grantIsLive(g: PeerGrant | null | undefined): g is PeerGrant {
  return !!g && !g.revokedAt;
}

/** May I SEND this scope to them? */
export function mayISend(g: PeerGrant, scope: PeerScope): boolean {
  return grantIsLive(g) && g.myScopes.includes(scope);
}

/** May I ACCEPT this scope from them? A frame outside the grant is dropped,
 *  never merged — this is the receive-side half of the enforcement. */
export function mayIAccept(g: PeerGrant, scope: PeerScope): boolean {
  return grantIsLive(g) && g.theirScopes.includes(scope);
}

// ── Safety number ─────────────────────────────────────────────────────────────

/** Group the Rust-computed 16 digits as "1234 5678 9012 3456". Presentation
 *  only — the derivation itself is blake3 in peer_link.rs so both sides and
 *  both languages agree byte-for-byte. */
export function formatSafetyNumber(digits: string): string {
  const clean = digits.replace(/\D/g, "").slice(0, 16);
  return (clean.match(/.{1,4}/g) ?? []).join(" ");
}

// ── Shared meetings (calendar scope) ──────────────────────────────────────────
// A structural subset of the app's Meeting (no import — this module stays
// dependency-free and rakotis must not depend on the app). Only meetings the
// sender ORGANISES are ever shared: a meeting someone else invited them to is
// third-party data (peer.md §1.4).

export interface PeerMeeting {
  id: string;
  title: string;
  start: number;
  end: number;
  location: string;
  notes: string;
  status: "scheduled" | "cancelled";
  /** Display name of the organiser (the sharing peer). */
  organizer: string;
  clock: LClock;
}

export function validatePeerMeeting(x: unknown): PeerMeeting | null {
  if (!isRecord(x)) return null;
  if (!isNonEmptyString(x.id, 64)) return null;
  if (typeof x.title !== "string" || x.title.length > PEER_TITLE_MAX_LEN) return null;
  if (!isFinite_(x.start) || !isFinite_(x.end) || x.start < 0 || x.end < x.start) return null;
  if (x.status !== "scheduled" && x.status !== "cancelled") return null;
  const clock = validateLClock(x.clock);
  if (!clock) return null;
  return {
    id: x.id,
    title: x.title,
    start: x.start,
    end: x.end,
    location: typeof x.location === "string" ? x.location.slice(0, PEER_TITLE_MAX_LEN) : "",
    notes: typeof x.notes === "string" ? x.notes.slice(0, PEER_TEXT_MAX_LEN) : "",
    status: x.status,
    organizer: typeof x.organizer === "string" ? x.organizer.slice(0, PEER_NAME_MAX_LEN) : "",
    clock,
  };
}

/** Merge an incoming meeting set into the stored mirror, per-item by clock.
 *  The peer owns their calendar mirror outright, so an item they drop is
 *  dropped here too when `authoritative` (a full-set frame, not a delta). */
export function mergePeerMeetings(
  local: PeerMeeting[],
  remote: PeerMeeting[],
  authoritative: boolean,
): { merged: PeerMeeting[]; changed: boolean } {
  const byId = new Map(local.map((m) => [m.id, m]));
  let changed = false;
  for (const r of remote) {
    const cur = byId.get(r.id);
    if (lclockWins(r.clock, cur?.clock)) {
      byId.set(r.id, r);
      changed = true;
    }
  }
  if (authoritative) {
    const keep = new Set(remote.map((m) => m.id));
    for (const id of [...byId.keys()]) {
      if (!keep.has(id)) {
        byId.delete(id);
        changed = true;
      }
    }
  }
  const merged = [...byId.values()]
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))
    .slice(0, PEER_MEETINGS_MAX);
  return { merged, changed };
}

// ── Contact card (card scope) ─────────────────────────────────────────────────

export interface PeerCard {
  name: string;
  /** Small JPEG data URL, "" = none (same shape as the chat avatar). */
  avatar: string;
  /** Free-text "about" line the peer chooses to publish. */
  about: string;
  clock: LClock;
}

export const PEER_CARD_AVATAR_MAX_LEN = 512 * 1024;

export function validatePeerCard(x: unknown): PeerCard | null {
  if (!isRecord(x)) return null;
  const clock = validateLClock(x.clock);
  if (!clock) return null;
  if (typeof x.name !== "string" || x.name.length > PEER_NAME_MAX_LEN) return null;
  return {
    name: x.name,
    avatar:
      typeof x.avatar === "string" && x.avatar.length <= PEER_CARD_AVATAR_MAX_LEN ? x.avatar : "",
    about: typeof x.about === "string" ? x.about.slice(0, PEER_TEXT_MAX_LEN) : "",
    clock,
  };
}

// ── Peer board (board scope) ──────────────────────────────────────────────────
// A board that belongs to the LINK, not to any room — so no room slug, and no
// captain election (which is meaningless with two people). The owner is
// whichever side created the link; both may edit, and every edit carries a
// clock, so authority never needs to be resolved by role (peer.md P8).

export interface PeerBoardColumn {
  id: string;
  title: string;
  /** Fractional index (LexoRank-lite) — see peers/boardKeys.ts `keyBetween`. */
  key: string;
}

export interface PeerBoardCard {
  id: string;
  columnId: string;
  title: string;
  description: string;
  key: string;
  /** Display name of whoever created it (presentation only). */
  author: string;
  done: boolean;
  clock: LClock;
  /** Tombstone — a deleted card stays as a stub so the delete converges instead
   *  of the peer re-pushing the card back forever. */
  deleted?: boolean;
}

export interface PeerBoard {
  v: typeof PLINK_VERSION;
  columns: PeerBoardColumn[];
  cards: PeerBoardCard[];
  /** Clock for the column set as a whole (columns move as one document). */
  columnsClock: LClock;
}

export function emptyPeerBoard(me: string, titles: string[], keys: string[]): PeerBoard {
  return {
    v: PLINK_VERSION,
    columns: titles.map((title, i) => ({ id: `c${i}`, title, key: keys[i] ?? `a${i}` })),
    cards: [],
    columnsClock: { c: 1, by: me },
  };
}

export function validatePeerBoardColumn(x: unknown): PeerBoardColumn | null {
  if (!isRecord(x)) return null;
  if (!isNonEmptyString(x.id, 64)) return null;
  if (typeof x.title !== "string" || x.title.length > PEER_TITLE_MAX_LEN) return null;
  if (!isNonEmptyString(x.key, 64)) return null;
  return { id: x.id, title: x.title, key: x.key };
}

export function validatePeerBoardCard(x: unknown): PeerBoardCard | null {
  if (!isRecord(x)) return null;
  if (!isNonEmptyString(x.id, 64)) return null;
  if (!isNonEmptyString(x.columnId, 64)) return null;
  if (typeof x.title !== "string" || x.title.length > PEER_TITLE_MAX_LEN) return null;
  if (!isNonEmptyString(x.key, 64)) return null;
  const clock = validateLClock(x.clock);
  if (!clock) return null;
  const card: PeerBoardCard = {
    id: x.id,
    columnId: x.columnId,
    title: x.title,
    description:
      typeof x.description === "string" ? x.description.slice(0, PEER_TEXT_MAX_LEN) : "",
    key: x.key,
    author: typeof x.author === "string" ? x.author.slice(0, PEER_NAME_MAX_LEN) : "",
    done: x.done === true,
    clock,
  };
  if (x.deleted === true) card.deleted = true;
  return card;
}

export function validatePeerBoard(x: unknown): PeerBoard | null {
  if (!isRecord(x) || x.v !== PLINK_VERSION) return null;
  const columnsClock = validateLClock(x.columnsClock);
  if (!columnsClock) return null;
  if (!Array.isArray(x.columns) || x.columns.length > PEER_BOARD_COLUMNS_MAX) return null;
  if (!Array.isArray(x.cards) || x.cards.length > PEER_BOARD_CARDS_MAX * 2) return null;
  const columns: PeerBoardColumn[] = [];
  for (const c of x.columns) {
    const col = validatePeerBoardColumn(c);
    if (!col) return null;
    columns.push(col);
  }
  const cards: PeerBoardCard[] = [];
  for (const c of x.cards) {
    const card = validatePeerBoardCard(c);
    if (!card) return null;
    cards.push(card);
  }
  return { v: PLINK_VERSION, columns, cards, columnsClock };
}

/** Merge a remote board into the local one: cards per-id by clock (tombstones
 *  included, so a delete wins over a stale copy), columns as one clocked
 *  document. Never authoritative — with both sides editing, a missing card
 *  means "I haven't heard of it", not "it was deleted". */
export function mergePeerBoards(
  local: PeerBoard,
  remote: PeerBoard,
): { merged: PeerBoard; changed: boolean } {
  let changed = false;
  const byId = new Map(local.cards.map((c) => [c.id, c]));
  for (const r of remote.cards) {
    if (lclockWins(r.clock, byId.get(r.id)?.clock)) {
      byId.set(r.id, r);
      changed = true;
    }
  }
  let columns = local.columns;
  let columnsClock = local.columnsClock;
  if (lclockWins(remote.columnsClock, local.columnsClock)) {
    columns = remote.columns;
    columnsClock = remote.columnsClock;
    changed = true;
  }
  const cards = [...byId.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1))
    .slice(0, PEER_BOARD_CARDS_MAX * 2);
  return { merged: { v: PLINK_VERSION, columns, cards, columnsClock }, changed };
}

/** The cards a board actually shows: tombstones are storage, not content. */
export function livePeerCards(board: PeerBoard): PeerBoardCard[] {
  return board.cards.filter((c) => !c.deleted).slice(0, PEER_BOARD_CARDS_MAX);
}

// ── plink_* wire payloads (inner MLS messages on the hidden link room) ────────
// All versioned v:1; unknown or invalid frames are dropped silently.

export interface PlinkHello {
  type: "plink_hello";
  v: typeof PLINK_VERSION;
  /** My grant revision, so a peer whose record is behind can re-request. */
  rev: number;
  /** What I currently share with them — the receive side re-checks its own
   *  record, so this is a hint for diffing, never an authorisation. */
  scopes: PeerScope[];
  /** Rooms I hold history for, so the peer can ask for what it misses. */
  rooms: { slug: string; latestTs: number }[];
}

export interface PlinkCal {
  type: "plink_cal";
  v: typeof PLINK_VERSION;
  meetings: PeerMeeting[];
  /** True when this frame is the sender's COMPLETE set (enables deletions). */
  full: boolean;
}

export interface PlinkBoard {
  type: "plink_board";
  v: typeof PLINK_VERSION;
  board: PeerBoard;
}

export interface PlinkCard {
  type: "plink_card";
  v: typeof PLINK_VERSION;
  card: PeerCard;
}

export interface PlinkHistReq {
  type: "plink_hist_req";
  v: typeof PLINK_VERSION;
  room: string;
  /** Send messages strictly newer than this Unix ms (0 = everything). */
  sinceTs: number;
}

export interface PlinkHist {
  type: "plink_hist";
  v: typeof PLINK_VERSION;
  room: string;
  /** Validated against validatePersistedMessage by the consumer (deviceSyncModel
   *  owns that shape; this module must not import it back). */
  msgs: unknown[];
  chunk: number;
  of: number;
}

export interface PlinkRevoke {
  type: "plink_revoke";
  v: typeof PLINK_VERSION;
}

export function validatePlinkHello(x: unknown): PlinkHello | null {
  if (!isRecord(x) || x.type !== "plink_hello" || x.v !== PLINK_VERSION) return null;
  if (!isFinite_(x.rev) || x.rev < 0) return null;
  const rooms: PlinkHello["rooms"] = [];
  if (Array.isArray(x.rooms)) {
    for (const r of x.rooms.slice(0, 1024)) {
      if (!isRecord(r) || !isNonEmptyString(r.slug, 256) || !isFinite_(r.latestTs)) continue;
      rooms.push({ slug: r.slug, latestTs: r.latestTs });
    }
  }
  return { type: "plink_hello", v: PLINK_VERSION, rev: x.rev, scopes: validateScopes(x.scopes), rooms };
}

export function validatePlinkCal(x: unknown): PlinkCal | null {
  if (!isRecord(x) || x.type !== "plink_cal" || x.v !== PLINK_VERSION) return null;
  if (!Array.isArray(x.meetings) || x.meetings.length > PEER_MEETINGS_MAX) return null;
  const meetings: PeerMeeting[] = [];
  for (const m of x.meetings) {
    const valid = validatePeerMeeting(m);
    if (!valid) return null;
    meetings.push(valid);
  }
  return { type: "plink_cal", v: PLINK_VERSION, meetings, full: x.full === true };
}

export function validatePlinkBoard(x: unknown): PlinkBoard | null {
  if (!isRecord(x) || x.type !== "plink_board" || x.v !== PLINK_VERSION) return null;
  const board = validatePeerBoard(x.board);
  return board ? { type: "plink_board", v: PLINK_VERSION, board } : null;
}

export function validatePlinkCard(x: unknown): PlinkCard | null {
  if (!isRecord(x) || x.type !== "plink_card" || x.v !== PLINK_VERSION) return null;
  const card = validatePeerCard(x.card);
  return card ? { type: "plink_card", v: PLINK_VERSION, card } : null;
}

export function validatePlinkHistReq(x: unknown): PlinkHistReq | null {
  if (!isRecord(x) || x.type !== "plink_hist_req" || x.v !== PLINK_VERSION) return null;
  if (!isNonEmptyString(x.room, 256)) return null;
  if (!isFinite_(x.sinceTs) || x.sinceTs < 0) return null;
  return { type: "plink_hist_req", v: PLINK_VERSION, room: x.room, sinceTs: x.sinceTs };
}

export function validatePlinkHist(x: unknown): PlinkHist | null {
  if (!isRecord(x) || x.type !== "plink_hist" || x.v !== PLINK_VERSION) return null;
  if (!isNonEmptyString(x.room, 256)) return null;
  if (!isFinite_(x.chunk) || !isFinite_(x.of) || x.chunk < 1 || x.of < 1 || x.chunk > x.of) return null;
  if (!Array.isArray(x.msgs) || x.msgs.length > PLINK_HISTORY_CHUNK_MAX_MSGS) return null;
  return { type: "plink_hist", v: PLINK_VERSION, room: x.room, msgs: x.msgs, chunk: x.chunk, of: x.of };
}

export function validatePlinkRevoke(x: unknown): PlinkRevoke | null {
  if (!isRecord(x) || x.type !== "plink_revoke" || x.v !== PLINK_VERSION) return null;
  return { type: "plink_revoke", v: PLINK_VERSION };
}
