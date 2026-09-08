// The board as a CRDT — convergence without a server.
//
// RESTORED from `enigma/limbo/frontend/sketch-collab/sketchModel.crdt.ts`
// (parked 2026-07-20). Sketch shipped as a collaborative whiteboard once and
// was cut back to a local editor; `sketchModel.ts`'s own header points here.
// Re-deriving this was tried and rejected: a plain last-writer-wins map
// diverges under four ordinary interleavings that the code below already
// handles — concurrent delete/upsert, a reordered delete-then-upsert, an
// operation racing the join snapshot, and a resync snapshot clobbering newer
// local work. Tombstones and merge-not-replace are what fix all four.
//
// WHAT CHANGED IN THE RESTORE. The parked file was a whole second copy of the
// model, and the live `sketchModel.ts` has moved well past it — rotation
// (`rot`, `shapePivot`, `rotateShape`), arrow heads, better hit-testing. So
// only the CRDT layer is lifted here and the geometry stays where it is; this
// module imports `Shape` rather than redeclaring it. Two consequences:
//
//   * `rot` rides along for free, because a Shape is the live Shape. The
//     parked wire format predates rotation and would have dropped it — the
//     restore note in that directory flags exactly this.
//   * `roomSlug` is gone from the snapshot. Enigma scoped a board to a chat
//     room; zinnia pairs two peers directly, so the session IS the scope.
//
// THE MODEL. An LWW-element-set: shapes keyed by `id`, last-write-wins on
// `updatedAt` with `author` breaking ties; tombstones `id -> deletedAt`
// max-merged; `clearedAt` a grow-only register. Add *and* delete are both LWW
// rather than remove-wins, specifically so an undo can resurrect an erased
// shape by re-stamping it later than its tombstone. Merge is idempotent,
// commutative and associative, so operations and snapshots may arrive in any
// order, any number of times, and every peer lands on the same board.
import type { Shape } from "./sketchModel";

/** Bumped only for a breaking change to the wire shapes below. */
export const SKETCH_WIRE_V = 1 as const;

/** Collaboration metadata carried by every shape on the wire.
 *
 *  Kept OUT of `Shape` itself: the saved `.svg` has no place for it, and a
 *  local drawing session should not have to invent an author. The session
 *  holds these beside the document — see `authorOf`/`stampOf` below. */
export interface ShapeMeta {
  /** Who drew it. Paint-order and LWW tie-break, plus attribution. */
  author: string;
  /** Hybrid-logical-clock ms: paint order AND the clear cutoff. Immutable. */
  createdAt: number;
  /** Hybrid-logical-clock ms of the last edit. The LWW key. */
  updatedAt: number;
}

/** A shape as it travels: the drawing plus who drew it and when. */
export interface WireShape {
  shape: Shape;
  meta: ShapeMeta;
}

export interface SketchCrdt {
  v: typeof SKETCH_WIRE_V;
  /** Live entries only, kept sorted by `compareEntries`. */
  entries: WireShape[];
  /** shapeId → deletedAt. Max-merged; an upsert stamped later resurrects it. */
  tombstones: Record<string, number>;
  clearedAt: number;
}

export function emptyCrdt(): SketchCrdt {
  return { v: SKETCH_WIRE_V, entries: [], tombstones: {}, clearedAt: 0 };
}

/** A hybrid logical clock.
 *
 *  `observe()` every inbound timestamp. Without it a peer whose wall clock
 *  runs slow stamps work below a clear it has already seen — silently voided
 *  everywhere — and loses every LWW race it takes part in. This is the single
 *  most important reason not to use `Date.now()` directly. */
export interface SketchClock {
  now(): number;
  observe(t: number): void;
}

export function makeClock(): SketchClock {
  let last = 0;
  return {
    now() {
      last = Math.max(Date.now(), last + 1);
      return last;
    },
    observe(t: number) {
      if (Number.isFinite(t) && t > last) last = t;
    },
  };
}

/** Paint order, and it must be TOTAL: every peer has to sort an identical set
 *  identically or the same board renders differently on two screens, and
 *  hit-testing picks different shapes. `createdAt` first, then author, then id
 *  — the last two only ever break exact ties. */
export function compareEntries(a: WireShape, b: WireShape): number {
  if (a.meta.createdAt !== b.meta.createdAt) return a.meta.createdAt - b.meta.createdAt;
  if (a.meta.author !== b.meta.author) return a.meta.author < b.meta.author ? -1 : 1;
  return a.shape.id < b.shape.id ? -1 : a.shape.id > b.shape.id ? 1 : 0;
}

/** Which of two versions of one shape survives. Later edit wins; an exact tie
 *  goes to the higher author id, so both peers decide the same way. */
function wins(next: ShapeMeta, prev: ShapeMeta): boolean {
  if (next.updatedAt !== prev.updatedAt) return next.updatedAt > prev.updatedAt;
  return next.author > prev.author;
}

/** Apply one shape. Returns whether the document actually changed — callers
 *  use that to decide whether to re-render or to re-broadcast. */
export function upsertShape(doc: SketchCrdt, e: WireShape): boolean {
  // Predates a clear everyone has seen: it is not late news, it is void.
  if (e.meta.createdAt <= doc.clearedAt) return false;
  const tomb = doc.tombstones[e.shape.id];
  // A delete wins a same-clock tie — deliberate, and the reason an undo must
  // re-stamp strictly later rather than replaying the original timestamp.
  if (tomb !== undefined && e.meta.updatedAt <= tomb) return false;
  if (tomb !== undefined) delete doc.tombstones[e.shape.id];

  const i = doc.entries.findIndex((x) => x.shape.id === e.shape.id);
  if (i === -1) {
    doc.entries.push(e);
    doc.entries.sort(compareEntries);
    return true;
  }
  if (!wins(e.meta, doc.entries[i].meta)) return false;
  // `createdAt` is IMMUTABLE — keep ours, so a remote edit cannot rewrite
  // paint order by restamping a shape and jumping it to the front.
  doc.entries[i] = { shape: e.shape, meta: { ...e.meta, createdAt: doc.entries[i].meta.createdAt } };
  return true;
}

/** Tombstone ids at `at`, and drop any live entry the tombstone now covers. */
export function deleteShapes(doc: SketchCrdt, ids: string[], at: number): number {
  let changed = 0;
  for (const id of ids) {
    const prev = doc.tombstones[id];
    if (prev === undefined || at > prev) {
      doc.tombstones[id] = at;
      changed++;
    }
  }
  const before = doc.entries.length;
  doc.entries = doc.entries.filter((e) => {
    const tomb = doc.tombstones[e.shape.id];
    return tomb === undefined || e.meta.updatedAt > tomb;
  });
  return changed + (before - doc.entries.length);
}

/** Clear the board. A grow-only register: only a LATER clear has any effect,
 *  and tombstones can be dropped because `clearedAt` subsumes them. */
export function clearAll(doc: SketchCrdt, at: number): boolean {
  if (at <= doc.clearedAt) return false;
  doc.clearedAt = at;
  doc.entries = doc.entries.filter((e) => e.meta.createdAt > at);
  doc.tombstones = {};
  return true;
}

/** What a joining peer is sent, and what a resync asks for. */
export interface SnapshotWire {
  v: typeof SKETCH_WIRE_V;
  entries: WireShape[];
  /** `[id, deletedAt]` pairs — compact next to an object. */
  tombs: [string, number][];
  clearedAt: number;
  /** The sender dropped the oldest shapes to fit a size cap. */
  truncated: boolean;
  /** Board size travels WITH the snapshot: a joiner starts from an empty
   *  document at the default size, and the host's board is whatever its file's
   *  viewBox says. Without this the two peers draw on different-sized boards
   *  and a stroke at x=3000 is off-canvas on one of them. */
  width: number;
  height: number;
}

/** Merge a snapshot INTO a document — never a replace.
 *
 *  The order matters: the clear first (it voids everything older), then
 *  tombstones, then upserts. Applying it as a replace is the bug the review
 *  caught in the from-scratch design: an operation that arrives while the
 *  snapshot is in flight, or local work drawn while a resync was pending,
 *  would be silently thrown away. Every path here goes through the same
 *  per-id merge as a live operation, so both survive. */
export function mergeSnapshot(doc: SketchCrdt, wire: SnapshotWire): number {
  let changed = 0;
  if (clearAll(doc, wire.clearedAt)) changed++;
  for (const [id, at] of wire.tombs) changed += deleteShapes(doc, [id], at);
  for (const e of wire.entries) if (upsertShape(doc, e)) changed++;
  return changed;
}

/** Bound the tombstone map. They are needed only long enough to outlive an
 *  in-flight upsert of the same shape; the newest are the ones that matter. */
export function gcTombstones(doc: SketchCrdt, max = 5000): number {
  const entries = Object.entries(doc.tombstones);
  if (entries.length <= max) return 0;
  entries.sort((a, b) => b[1] - a[1]);
  doc.tombstones = Object.fromEntries(entries.slice(0, max));
  return entries.length - max;
}

/** Shrink a snapshot to fit a frame. Drops the OLDEST shapes, because the
 *  newest are what a joiner most needs to see; `truncated` tells the receiver
 *  its board is incomplete so it can say so rather than pretend. */
export function truncateSnapshot(
  entries: WireShape[],
  tombs: [string, number][],
  clearedAt: number,
  maxBytes: number,
): { entries: WireShape[]; tombs: [string, number][]; truncated: boolean } {
  let kept = entries;
  let truncated = false;
  const size = () => JSON.stringify({ entries: kept, tombs, clearedAt }).length;
  while (kept.length > 1 && size() > maxBytes) {
    kept = kept.slice(Math.ceil(kept.length * 0.15));
    truncated = true;
  }
  return { entries: kept, tombs, truncated };
}

/** The drawing, in paint order — what the canvas renders. */
export function liveShapes(doc: SketchCrdt): Shape[] {
  return doc.entries.map((e) => e.shape);
}

/** Who last wrote a shape, or null if it is not on the board. Per-author undo
 *  reads this: I may revert only what is still mine. */
export function authorOf(doc: SketchCrdt, id: string): string | null {
  return doc.entries.find((e) => e.shape.id === id)?.meta.author ?? null;
}
