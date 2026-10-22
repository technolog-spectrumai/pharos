// Group Kanban board — pure data model + reconcilers (no Vue/Tauri imports).
//
// One board per chat room (board identity = room slug). Columns are owned by the
// room CAPTAIN (lowest live MLS id): they travel as a single snapshot behind a
// monotonic `columnsRev`, exactly like room_meta (see useChatChannel.ts). Cards
// are collaboratively owned — ANY member creates/edits/moves/deletes them — so
// they reconcile by last-write-wins on `updatedAt` (author id breaks ties, and a
// delete wins a same-timestamp tie). A move / promote / demote / reorder is just
// a card upsert that changes `columnId` / `orderKey`. Both flow over the chat
// channel's MLS-encrypted sync seam via `kanban_*` inner types (see useKanban.ts).
//
// Trust model: cooperative — `author` / `fromDevice` / the captain id are
// self-asserted inside the ciphertext, authenticating MLS-group membership, not
// authorship. A malicious member could forge them. Same posture as meetingModel.ts.

// ── fractional index (LexoRank-lite) ──────────────────────────────────────────
// Order keys are base-62 fraction strings compared lexicographically (ASCII order
// == rank order). `keyBetween(a, b)` returns a key strictly between neighbours,
// with null = "before everything" (lower) / "after everything" (upper). Inline
// port of rocicorp's `fractional-indexing` midpoint — zero dependencies.

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A key strictly between `a` and `b` (both base-62 fraction strings after an
 *  implicit "0."). `b == null` ⇒ no upper bound; recursion terminates because a
 *  bounded interval always contains a longer/greater string. Requires a < b. */
function midpoint(a: string, b: string | null): string {
  const zero = DIGITS[0];
  if (b != null && a >= b) throw new Error(`kanban keyBetween: ${a} >= ${b}`);
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
    throw new Error("kanban keyBetween: trailing zero");
  }
  if (b) {
    // Copy the shared prefix, then find the midpoint of the remainder.
    let n = 0;
    while ((a[n] || zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b != null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  // First digits are consecutive.
  if (b && b.length > 1) return b.slice(0, 1);
  // `b` is null or a single digit: descend into `a`'s tail with no upper bound.
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/** Order key strictly between `a` and `b` (existing keys, or null for the open
 *  ends). `keyBetween(null, null)` seeds the first key; `keyBetween(last, null)`
 *  appends; `keyBetween(null, first)` prepends. */
export function keyBetween(a: string | null, b: string | null): string {
  return midpoint(a ?? "", b);
}

/** Evenly-spaced initial keys for `count` seed columns (all > the open lower end). */
export function seedKeys(count: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = keyBetween(prev, null);
    out.push(prev);
  }
  return out;
}

// ── label colours (categorical, theme-mapped in the card component) ───────────
export const CARD_COLORS = ["slate", "red", "amber", "green", "blue", "violet"] as const;
export type CardColor = (typeof CARD_COLORS)[number];

// ── types ─────────────────────────────────────────────────────────────────────

export interface Column {
  id: string;
  title: string;
  orderKey: string; // fractional index, left→right
  color?: string;
}

export interface Card {
  id: string; // uuid — globally unique
  columnId: string; // membership; move/promote/demote changes this
  title: string;
  description: string;
  assignee: string; // roster MLS id ("" = unassigned)
  dueDate: number | null; // epoch ms
  color: string; // CardColor token
  orderKey: string; // within-column fractional index
  author: string; // MLS id of the LAST writer (LWW tiebreak + rebroadcast anchor)
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms — LWW clock
  deleted: boolean; // tombstone (retained; heals concurrent re-add)
  needsBroadcast?: boolean; // local-only outbox flag (never sent)
}

/** Full card snapshot as it travels inside the MLS ciphertext. `fromName`/
 *  `fromDevice` are appended by the sender. */
export interface CardWire {
  roomSlug: string;
  id: string;
  columnId: string;
  title: string;
  description: string;
  assignee: string;
  dueDate: number | null;
  color: string;
  orderKey: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  fromName: string;
  fromDevice: string;
}

/** The captain-authoritative columns snapshot (models room_meta). */
export interface ColumnsWire {
  roomSlug: string;
  columns: Column[];
  columnsRev: number;
  fromName: string;
  fromDevice: string;
}

/** The persisted per-room board document (encrypted kv, keyed by room slug). */
export interface BoardDoc {
  columns: Column[];
  columnsRev: number;
  cards: Card[]; // includes tombstones
}

export interface CardDraft {
  title: string;
  description: string;
  assignee: string;
  dueDate: number | null;
  color: string;
}

// ── protocol helpers ──────────────────────────────────────────────────────────

/** Wire snapshot of a card (local-only flags stripped). `fromName`/`fromDevice`
 *  are appended by the sender. */
export function wireFromCard(c: Card, roomSlug: string): Omit<CardWire, "fromName" | "fromDevice"> {
  return {
    roomSlug,
    id: c.id,
    columnId: c.columnId,
    title: c.title,
    description: c.description,
    assignee: c.assignee,
    dueDate: c.dueDate,
    color: c.color,
    orderKey: c.orderKey,
    author: c.author,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    deleted: c.deleted,
  };
}

/** Merge an incoming `kanban_card_upsert`.
 *
 *  Multi-writer last-write-wins by `updatedAt`; on an equal timestamp a delete
 *  beats a non-delete, else the higher `author` id wins (deterministic), else the
 *  message is a duplicate. Returns the card to store, or null when it must be
 *  dropped (stale / duplicate). One rule covers create / edit / move / reorder /
 *  delete (a delete is an upsert with `deleted:true`). */
export function applyRemoteCard(existing: Card | undefined, wire: CardWire): Card | null {
  if (!wire.id || typeof wire.updatedAt !== "number") return null;
  if (existing) {
    if (wire.updatedAt < existing.updatedAt) return null; // stale
    if (wire.updatedAt === existing.updatedAt) {
      if (existing.deleted !== wire.deleted) {
        if (!wire.deleted) return null; // existing delete wins the tie
        // else incoming delete wins → accept
      } else if (wire.author <= existing.author) {
        return null; // same class, not a higher author ⇒ duplicate
      }
    }
  }
  return {
    id: wire.id,
    columnId: wire.columnId,
    title: wire.title,
    description: wire.description,
    assignee: wire.assignee ?? "",
    dueDate: typeof wire.dueDate === "number" ? wire.dueDate : null,
    color: wire.color,
    orderKey: wire.orderKey,
    author: wire.author,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    deleted: !!wire.deleted,
  };
}

/** Apply an incoming `kanban_columns` snapshot — captain-authoritative with the
 *  room_meta handoff rule (`useChatChannel.ts:789`): the captain's snapshot
 *  applies at same-or-higher rev; anyone else's only when STRICTLY newer (the
 *  handoff path when captaincy just changed). Returns sorted columns, or null
 *  when the message must be dropped. */
export function applyRemoteColumns(
  localRev: number,
  wire: ColumnsWire,
  fromCaptain: boolean,
): Column[] | null {
  const accept = fromCaptain ? wire.columnsRev >= localRev : wire.columnsRev > localRev;
  if (!accept || !Array.isArray(wire.columns)) return null;
  const clean = wire.columns
    .filter(
      (c): c is Column =>
        !!c &&
        typeof c.id === "string" &&
        typeof c.title === "string" &&
        typeof c.orderKey === "string",
    )
    .map((c) => ({
      id: c.id,
      title: c.title,
      orderKey: c.orderKey,
      color: typeof c.color === "string" ? c.color : undefined,
    }));
  return columnsSorted(clean);
}

// ── ordering / derivation ─────────────────────────────────────────────────────

/** Total order across peers: by orderKey, then author, then id — so identical
 *  order keys (concurrent inserts) still sort identically everywhere. */
export function compareCards(a: Card, b: Card): number {
  if (a.orderKey !== b.orderKey) return a.orderKey < b.orderKey ? -1 : 1;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function columnsSorted(columns: Column[]): Column[] {
  return [...columns].sort((a, b) =>
    a.orderKey !== b.orderKey
      ? a.orderKey < b.orderKey
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
}

/** Live (non-tombstone) cards of one column, in board order. */
export function sortColumnCards(cards: Card[], columnId: string): Card[] {
  return cards.filter((c) => !c.deleted && c.columnId === columnId).sort(compareCards);
}

/** Last element or undefined (the project's TS lib target predates Array.at). */
export function last<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

// ── validation ────────────────────────────────────────────────────────────────

/** i18n error key under `kanban.*`, or null when the draft is valid. */
export function validateCardDraft(
  draft: Pick<CardDraft, "title" | "description">,
  maxTitle: number,
  maxDesc: number,
): string | null {
  if (!draft.title.trim()) return "titleRequired";
  if (draft.title.length > maxTitle) return "titleTooLong";
  if (draft.description.length > maxDesc) return "descriptionTooLong";
  return null;
}
