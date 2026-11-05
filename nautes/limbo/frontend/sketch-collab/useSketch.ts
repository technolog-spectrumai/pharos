// Shared sketch orchestrator — one collaborative board per chat room.
//
// Everything rides the chat channel's MLS-encrypted sync seam (`onSync`/`sendSync`,
// `sketch_*` inner types), and each profile persists the open room's board in the
// encrypted kv store (namespace "sketch", one doc per room slug).
//
// The document is a CRDT (see sketchModel.ts): an LWW-element-set, so merges are
// idempotent, commutative and associative and ops can be applied in any order any
// number of times. That is what makes the transport survivable — iroh gossip is
// unordered and silently drops frames when a receiver falls behind
// (`Event::Lagged => {}` in p2p_iroh.rs), and nothing in the app acks or retries.
//
// Cost model, which drives every batching decision here: EVERY message sent or
// received is a full MLS state export + AEAD seal + fsync (mls_encrypt → persist →
// PersistMode::SyncAll), and every kvPut is an fsync too. So the budget is messages
// per second, not bytes:
//   - freehand streams at most ONE delta per ~150 ms tick, never per pointermove;
//   - an eraser drag sends one batched delete, not one per shape;
//   - late joiners get ONE compacted snapshot, not one message per shape (which is
//     what kanban does per card — fine for 500 cards, not for a stroke stream);
//   - persistence is debounced, and flushed explicitly on room switch/unmount.
//
// Backpressure is handled by COALESCING rather than queueing: a tick that can't
// send merges into the pending batch, so a hiccup makes the next batch bigger
// rather than building a backlog that would make the board feel permanently laggy.
//
// Late joiners: on roster growth a snapshot is sent, captain-preferred with a
// jittered non-captain fallback so an absent captain still heals the board without
// every peer answering at once. A dropped commit is caught by the piggybacked
// `count` digest on the next add → throttled `sketch_want` → snapshot. Residual gap,
// accepted for v1 (same as useKanban/useMeetings): a peer never online at the same
// time as any holder never learns those shapes.
//
// Trust model: cooperative — see sketchModel.ts.

import { computed, ref, watch } from "vue";
import { getBuildConfig, kvGet, kvPut } from "rakotis";
import type { ChatChannel } from "rakotis";
import {
  clearAll,
  deleteShapes,
  emptyDoc,
  gcTombstones,
  hitTest,
  LIVE_STROKE_TTL_MS,
  makeClock,
  mergeSnapshot,
  quant,
  scaleShape,
  shapeBounds,
  SKETCH_WIRE_V,
  translateShape,
  truncateSnapshot,
  upsertShape,
  validateDoc,
  validateShape,
  validateSnapshot,
  validateStrokeDelta,
  type ArrowShape,
  type EllipseShape,
  type PathShape,
  type RectShape,
  type Shape,
  type SketchCaps,
  type SketchDoc,
  type SnapshotWire,
  type TextShape,
  type TriangleShape,
} from "./sketchModel";

const KV_NS = "sketch";
const KV_SCOPE = "default";

/** Outbox tick. One freehand delta per tick ⇒ ~7 msg/s while drawing. */
const FLUSH_MS = 150;
/** Hard ceiling on messages (= fsyncs) per tick. */
const MAX_OPS_PER_TICK = 3;
const PERSIST_DEBOUNCE_MS = 800;
/** Never send snapshots faster than this, however many joins arrive. */
const SNAPSHOT_MIN_INTERVAL_MS = 5000;
/** A non-captain waits this long (jittered) before answering, and stands down if
 *  anyone else covered it. */
const SNAPSHOT_FALLBACK_MIN_MS = 1200;
const SNAPSHOT_FALLBACK_JITTER_MS = 1800;
const WANT_THROTTLE_MS = 15000;
/** Eraser drag is sampled along the segment so a fast flick can't skip shapes. */
const ERASE_STEP = 4;

/** A peer's in-progress stroke. Ephemeral — never merged into the doc, never persisted. */
export interface LiveStroke {
  strokeId: string;
  author: string;
  authorName: string;
  pts: number[];
  color: string;
  sw: number;
  opacity: number;
  /** Next point index we expect; a jump means we lost deltas. */
  nextIndex: number;
  gapped: boolean;
  lastSeenAt: number;
}

/** The local in-progress stroke. Rendered from local state, so it draws at input
 *  latency rather than network latency. */
interface SelfStroke {
  strokeId: string;
  pts: number[];
  color: string;
  sw: number;
  opacity: number;
  /** Points already handed to a delta that was actually SENT. */
  sentUpTo: number;
}

export function useSketch(channel: ChatChannel) {
  const cfg = getBuildConfig();
  const caps: SketchCaps = {
    maxShapes: cfg.sketch_max_shapes_per_board,
    maxPointsPerStroke: cfg.sketch_max_points_per_stroke,
    maxTextLen: cfg.sketch_max_text_len,
  };
  const snapshotMaxBytes = cfg.sketch_snapshot_max_bytes;

  const clock = makeClock();
  const doc = ref<SketchDoc>(emptyDoc());
  const boardSlug = ref("");
  const selfLive = ref<SelfStroke | null>(null);
  const liveStrokes = ref<Map<string, LiveStroke>>(new Map());
  const truncatedWarning = ref(false);
  const boardFull = ref(false);
  /** Nav attention dot: remote changes not yet seen in the Sketch tab. */
  const unseen = ref(0);
  /** Selected shape id (select tool). Local-only — selection is never shared. */
  const selectedId = ref<string | null>(null);

  const selfName = () => channel.currentUserName.value;
  const selfDevice = () => channel.mlsIdentity.value;

  const shapes = computed(() => doc.value.shapes);
  const remoteLive = computed(() => [...liveStrokes.value.values()]);
  const attentionCount = computed(() => unseen.value);
  function markSeen() {
    unseen.value = 0;
  }

  /** `sendEncryptedMedia` dereferences `currentRoom.value!`, so never send blind. */
  function canSend(): boolean {
    const slug = channel.currentRoom.value?.slug;
    return !!slug && slug === boardSlug.value && channel.mlsStatus.value === "ready";
  }

  function base() {
    return {
      roomSlug: boardSlug.value,
      v: SKETCH_WIRE_V,
      fromName: selfName(),
      fromDevice: selfDevice(),
    };
  }

  // ── persistence (debounced: every kvPut is an fsync) ────────────────────────

  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function persist() {
    const slug = boardSlug.value;
    if (!slug) return;
    gcTombstones(doc.value);
    await kvPut(KV_NS, KV_SCOPE, slug, JSON.stringify(doc.value)).catch(() => {});
  }

  /** Persist now — before a room switch, unmount, or export. */
  async function flushPersist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persist();
  }

  async function loadDoc(slug: string) {
    if (!slug) {
      doc.value = emptyDoc();
      return;
    }
    try {
      const raw = await kvGet(KV_NS, KV_SCOPE, slug);
      // Re-validate: a corrupted or tampered kv entry must not poison the renderer
      // any more than a wire message may.
      const parsed = raw ? validateDoc(JSON.parse(raw), caps) : null;
      doc.value = parsed ?? emptyDoc();
    } catch {
      doc.value = emptyDoc();
    }
    for (const s of doc.value.shapes) clock.observe(s.createdAt);
    clock.observe(doc.value.clearedAt);
  }

  // ── outbox: coalescing buffers, not queues ─────────────────────────────────

  let pendingDelta:
    | { strokeId: string; from: number; pts: number[]; color: string; sw: number; opacity: number }
    | null = null;
  let pendingEraseIds: string[] = [];
  const pendingOps: Array<() => Promise<void>> = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let sending = false;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setInterval(() => void tick(), FLUSH_MS);
  }

  function stopFlushIfIdle() {
    if (flushTimer && !pendingDelta && !pendingOps.length && !pendingEraseIds.length) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  async function tick() {
    // Skipping leaves the buffers to keep coalescing — the next batch is bigger,
    // the backlog never grows.
    if (sending || !canSend()) return;
    sending = true;
    try {
      let n = 0;
      // Authoritative ops first: a commit is worth more than a preview frame.
      if (pendingEraseIds.length) {
        const ids = pendingEraseIds;
        pendingEraseIds = [];
        await channel.sendSync("sketch_shape_delete", { ...base(), ids, deletedAt: clock.now() });
        n++;
      }
      while (pendingOps.length && n < MAX_OPS_PER_TICK) {
        await pendingOps.shift()!();
        n++;
      }
      if (pendingDelta && n < MAX_OPS_PER_TICK) {
        const d = pendingDelta;
        pendingDelta = null;
        await channel.sendSync("sketch_stroke_delta", { ...base(), ...d });
        // Only now is the tail considered sent; a skipped tick re-sends it whole,
        // so we never create a gap of our own.
        if (selfLive.value && selfLive.value.strokeId === d.strokeId) {
          selfLive.value.sentUpTo = d.from + d.pts.length / 2;
        }
      }
    } catch {
      // Same posture as every other sender here: state stays locally authoritative
      // and heals via commit / snapshot.
    } finally {
      sending = false;
      stopFlushIfIdle();
    }
  }

  // ── live-stroke TTL sweep (a lost commit must not leave a ghost) ────────────

  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  function ensureSweep() {
    if (sweepTimer || liveStrokes.value.size === 0) return;
    sweepTimer = setInterval(() => {
      const cutoff = Date.now() - LIVE_STROKE_TTL_MS;
      let dropped = false;
      for (const [id, l] of liveStrokes.value) {
        if (l.lastSeenAt < cutoff) {
          liveStrokes.value.delete(id);
          dropped = true;
        }
      }
      if (dropped) liveStrokes.value = new Map(liveStrokes.value);
      if (liveStrokes.value.size === 0 && sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    }, 2000);
  }

  // ── local drawing ──────────────────────────────────────────────────────────

  const currentColor = ref<string>("#111827");
  const currentWidth = ref<number>(4);
  const currentOpacity = ref<number>(1);
  /** null = outline only. Applies to rect / ellipse / triangle. */
  const currentFill = ref<string | null>(null);

  function atCapacity(): boolean {
    if (doc.value.shapes.length < caps.maxShapes) return false;
    boardFull.value = true;
    return true;
  }

  function styleOf() {
    return {
      color: currentColor.value,
      sw: currentWidth.value,
      opacity: currentOpacity.value,
      fill: currentFill.value,
    };
  }

  // ── undo / redo ────────────────────────────────────────────────────────────
  // Per-user and local-only: an entry records the shapes I touched, before and
  // after. Undo re-broadcasts the "before" state stamped with a fresh clock, so it
  // wins LWW on every peer — including resurrecting something I erased, which is
  // why deletion is LWW rather than remove-wins (see sketchModel.ts).
  //
  // Clear is deliberately NOT undoable: `clearAll` drops the shapes outright and a
  // peer that already applied it has nothing to restore, so faking an undo would
  // desync. Clearing empties both stacks instead.

  interface UndoEntry {
    /** State to restore on undo; absent id ⇒ the shape did not exist. */
    before: Shape[];
    /** State to restore on redo; empty ⇒ the shapes were deleted. */
    after: Shape[];
    /** Ids touched, so an undo of a creation knows what to delete. */
    ids: string[];
  }

  const undoStack = ref<UndoEntry[]>([]);
  const redoStack = ref<UndoEntry[]>([]);
  const UNDO_LIMIT = 100;

  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);

  function pushUndo(entry: UndoEntry) {
    undoStack.value.push(entry);
    if (undoStack.value.length > UNDO_LIMIT) undoStack.value.shift();
    redoStack.value = []; // a fresh action forks the timeline
  }

  /** Apply a set of shapes as the current truth, deleting any id that has no shape
   *  in `target`. Everything is re-stamped so it wins LWW remotely. */
  function applyRestore(ids: string[], target: Shape[]) {
    const at = clock.now();
    const byId = new Map(target.map((s) => [s.id, s]));
    const gone = ids.filter((id) => !byId.has(id));

    for (const s of target) {
      const restored = { ...s, updatedAt: at };
      if (upsertShape(doc.value, restored)) {
        pendingOps.push(() =>
          channel.sendSync("sketch_shape_upsert", {
            ...base(),
            shape: restored,
            count: doc.value.shapes.length,
            clearedAt: doc.value.clearedAt,
          }),
        );
      }
    }
    if (gone.length) {
      deleteShapes(doc.value, gone, at);
      for (const id of gone) if (!pendingEraseIds.includes(id)) pendingEraseIds.push(id);
    }
    schedulePersist();
    scheduleFlush();
  }

  function undo() {
    const entry = undoStack.value.pop();
    if (!entry) return;
    redoStack.value.push(entry);
    applyRestore(entry.ids, entry.before);
    if (selectedId.value && !doc.value.shapes.some((s) => s.id === selectedId.value)) {
      selectedId.value = null;
    }
  }

  function redo() {
    const entry = redoStack.value.pop();
    if (!entry) return;
    undoStack.value.push(entry);
    applyRestore(entry.ids, entry.after);
  }

  function beginStroke(x: number, y: number) {
    if (atCapacity()) return;
    selfLive.value = {
      strokeId: crypto.randomUUID(),
      pts: [quant(x), quant(y)],
      color: currentColor.value,
      sw: currentWidth.value,
      opacity: currentOpacity.value,
      sentUpTo: 0,
    };
    scheduleFlush();
  }

  function extendStroke(x: number, y: number) {
    const live = selfLive.value;
    if (!live) return;
    live.pts.push(quant(x), quant(y));
    // Re-offer everything not yet actually sent, so a skipped tick self-repairs.
    pendingDelta = {
      strokeId: live.strokeId,
      from: live.sentUpTo,
      pts: live.pts.slice(live.sentUpTo * 2),
      color: live.color,
      sw: live.sw,
      opacity: live.opacity,
    };
    scheduleFlush();
    if (live.pts.length / 2 >= caps.maxPointsPerStroke) void commitStroke(true);
  }

  /** Commit the in-progress stroke. `autoSplit` continues seamlessly past the cap. */
  async function commitStroke(autoSplit = false) {
    const live = selfLive.value;
    if (!live) return;
    pendingDelta = null; // superseded by the full point list below

    if (live.pts.length >= 2) {
      const at = clock.now();
      const shape: PathShape = {
        id: live.strokeId,
        kind: "path",
        author: selfDevice(),
        createdAt: at,
        updatedAt: at,
        color: live.color,
        sw: live.sw,
        opacity: live.opacity,
        fill: null,
        pts: live.pts.slice(),
      };
      commitLocal(shape);
    }

    if (autoSplit) {
      // Seed the continuation with the last point so the halves visually join.
      const n = live.pts.length;
      selfLive.value = {
        strokeId: crypto.randomUUID(),
        pts: [live.pts[n - 2], live.pts[n - 1]],
        color: live.color,
        sw: live.sw,
        opacity: live.opacity,
        sentUpTo: 0,
      };
    } else {
      selfLive.value = null;
    }
  }

  function cancelStroke() {
    selfLive.value = null;
    pendingDelta = null;
  }

  /** Add locally, record it for undo, then queue the authoritative broadcast. */
  function commitLocal(shape: Shape, track = true) {
    if (!upsertShape(doc.value, shape)) return;
    if (track) pushUndo({ before: [], after: [shape], ids: [shape.id] });
    schedulePersist();
    pendingOps.push(() =>
      channel.sendSync("sketch_shape_upsert", {
        ...base(),
        shape,
        count: doc.value.shapes.length,
        clearedAt: doc.value.clearedAt,
      }),
    );
    scheduleFlush();
  }

  /** Fields every newly created shape shares. */
  function newBase() {
    const at = clock.now();
    return { id: crypto.randomUUID(), author: selfDevice(), createdAt: at, updatedAt: at, ...styleOf() };
  }

  function addRect(x: number, y: number, w: number, h: number) {
    if (atCapacity() || Math.abs(w) < 1 || Math.abs(h) < 1) return;
    commitLocal({
      ...newBase(),
      kind: "rect",
      x: quant(Math.min(x, x + w)),
      y: quant(Math.min(y, y + h)),
      w: quant(Math.abs(w)),
      h: quant(Math.abs(h)),
    } as RectShape);
  }

  function addTriangle(x: number, y: number, w: number, h: number) {
    if (atCapacity() || Math.abs(w) < 1 || Math.abs(h) < 1) return;
    commitLocal({
      ...newBase(),
      kind: "triangle",
      x: quant(Math.min(x, x + w)),
      y: quant(Math.min(y, y + h)),
      w: quant(Math.abs(w)),
      h: quant(Math.abs(h)),
    } as TriangleShape);
  }

  function addEllipse(cx: number, cy: number, rx: number, ry: number) {
    if (atCapacity() || rx < 0.5 || ry < 0.5) return;
    commitLocal({
      ...newBase(),
      kind: "ellipse",
      cx: quant(cx),
      cy: quant(cy),
      rx: quant(rx),
      ry: quant(ry),
    } as EllipseShape);
  }

  function addArrow(x1: number, y1: number, x2: number, y2: number) {
    if (atCapacity() || Math.hypot(x2 - x1, y2 - y1) < 2) return;
    commitLocal({
      ...newBase(),
      kind: "arrow",
      x1: quant(x1),
      y1: quant(y1),
      x2: quant(x2),
      y2: quant(y2),
    } as ArrowShape);
  }

  function addText(x: number, y: number, text: string, size: number, tw: number, th: number) {
    const clean = text.trim().slice(0, caps.maxTextLen);
    if (!clean || atCapacity()) return;
    commitLocal({
      ...newBase(),
      kind: "text",
      x: quant(x),
      y: quant(y),
      text: clean,
      size,
      tw: quant(tw),
      th: quant(th),
    } as TextShape);
  }

  // ── select + transform ─────────────────────────────────────────────────────

  const selected = computed(() => doc.value.shapes.find((s) => s.id === selectedId.value) ?? null);

  function selectAt(x: number, y: number, radius: number) {
    selectedId.value = hitTest(doc.value.shapes, x, y, radius);
    return selectedId.value;
  }

  function clearSelection() {
    selectedId.value = null;
  }

  /** Snapshot taken at the start of a drag, so the whole gesture is one undo step
   *  and only the final position is broadcast (a move is not worth streaming). */
  let transformBefore: Shape | null = null;

  function beginTransform() {
    transformBefore = selected.value ? { ...selected.value } : null;
  }

  /** Live local-only preview during a drag — no network, no undo entry. */
  function previewTransform(next: Shape) {
    const i = doc.value.shapes.findIndex((s) => s.id === next.id);
    if (i !== -1) doc.value.shapes[i] = next;
  }

  function moveSelected(dx: number, dy: number) {
    const s = selected.value;
    if (!s) return;
    previewTransform(translateShape(s, dx, dy));
  }

  function resizeSelected(fx: number, fy: number, ox: number, oy: number) {
    const s = selected.value;
    if (!s) return;
    previewTransform(scaleShape(s, ox, oy, fx, fy));
  }

  /** Commit the drag: one undo entry, one broadcast. */
  function endTransform() {
    const before = transformBefore;
    transformBefore = null;
    const after = selected.value;
    if (!before || !after || JSON.stringify(before) === JSON.stringify(after)) return;
    const stamped = { ...after, updatedAt: clock.now() };
    previewTransform(stamped);
    pushUndo({ before: [before], after: [stamped], ids: [stamped.id] });
    schedulePersist();
    pendingOps.push(() =>
      channel.sendSync("sketch_shape_upsert", {
        ...base(),
        shape: stamped,
        count: doc.value.shapes.length,
        clearedAt: doc.value.clearedAt,
      }),
    );
    scheduleFlush();
  }

  /** Restyle the selected shape (colour / width / opacity / fill) in place. */
  function restyleSelected() {
    const s = selected.value;
    if (!s) return;
    const before = { ...s };
    const after = { ...s, ...styleOf(), updatedAt: clock.now() };
    if (JSON.stringify(before) === JSON.stringify({ ...after, updatedAt: before.updatedAt })) return;
    previewTransform(after);
    pushUndo({ before: [before], after: [after], ids: [after.id] });
    schedulePersist();
    pendingOps.push(() =>
      channel.sendSync("sketch_shape_upsert", {
        ...base(),
        shape: after,
        count: doc.value.shapes.length,
        clearedAt: doc.value.clearedAt,
      }),
    );
    scheduleFlush();
  }

  function deleteSelected() {
    const s = selected.value;
    if (!s) return;
    pushUndo({ before: [{ ...s }], after: [], ids: [s.id] });
    deleteShapes(doc.value, [s.id], clock.now());
    if (!pendingEraseIds.includes(s.id)) pendingEraseIds.push(s.id);
    selectedId.value = null;
    schedulePersist();
    scheduleFlush();
  }

  /** Bounds of the current selection, for the handles the canvas draws. */
  const selectionBounds = computed(() => (selected.value ? shapeBounds(selected.value) : null));

  /** Erase along the segment from the previous pointer position to this one — a
   *  fast drag emits sparse moves and would otherwise skip shapes. Deletes are
   *  batched into one message per flush tick. */
  function eraseAlong(fromX: number, fromY: number, toX: number, toY: number, radius: number) {
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const steps = Math.max(1, Math.ceil(dist / ERASE_STEP));
    const hits = new Set<string>();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const id = hitTest(doc.value.shapes, fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, radius);
      if (id) hits.add(id);
    }
    if (!hits.size) return;
    const ids = [...hits];
    // Capture what we are about to erase so undo can put it back.
    const before = doc.value.shapes.filter((s) => hits.has(s.id)).map((s) => ({ ...s }));
    if (before.length) pushUndo({ before, after: [], ids });
    deleteShapes(doc.value, ids, clock.now());
    for (const id of ids) if (!pendingEraseIds.includes(id)) pendingEraseIds.push(id);
    if (selectedId.value && hits.has(selectedId.value)) selectedId.value = null;
    schedulePersist();
    scheduleFlush();
  }

  /** Clear is not undoable — `clearAll` drops the shapes outright, and a peer that
   *  already applied it has nothing to restore, so a faked undo would desync. */
  function clearBoard() {
    const at = clock.now();
    clearAll(doc.value, at);
    truncatedWarning.value = false;
    boardFull.value = false;
    selectedId.value = null;
    undoStack.value = [];
    redoStack.value = [];
    schedulePersist();
    pendingOps.push(() => channel.sendSync("sketch_clear", { ...base(), clearedAt: at }));
    scheduleFlush();
  }

  // ── snapshots ──────────────────────────────────────────────────────────────

  let lastSnapshotAt = 0;
  let snapshotsSeen = 0;
  let lastWantAt = 0;

  function buildSnapshot(): SnapshotWire {
    const tombs = Object.entries(doc.value.tombstones) as [string, number][];
    const out = truncateSnapshot(doc.value.shapes, tombs, doc.value.clearedAt, snapshotMaxBytes);
    if (out.truncated) truncatedWarning.value = true;
    return {
      ...base(),
      shapes: out.shapes,
      tombs: out.tombs,
      clearedAt: doc.value.clearedAt,
      truncated: out.truncated,
    } as SnapshotWire;
  }

  async function maybeSendSnapshot(reason: "roster" | "want" | "manual") {
    if (!canSend()) return;
    if (Date.now() - lastSnapshotAt < SNAPSHOT_MIN_INTERVAL_MS) return;
    if (!doc.value.shapes.length && !doc.value.clearedAt) return; // nothing to share

    if (reason !== "manual" && !channel.amCaptain.value) {
      // Captain answers by default; everyone else waits a jittered moment and
      // stands down if a snapshot showed up meanwhile. Keeps an absent captain
      // from stalling the heal without making N peers answer at once.
      const mark = snapshotsSeen;
      await new Promise((r) =>
        setTimeout(r, SNAPSHOT_FALLBACK_MIN_MS + Math.random() * SNAPSHOT_FALLBACK_JITTER_MS),
      );
      if (snapshotsSeen !== mark || !canSend()) return;
    }

    lastSnapshotAt = Date.now();
    pendingOps.push(() => channel.sendSync("sketch_snapshot", { ...buildSnapshot() }));
    scheduleFlush();
  }

  function requestSnapshotThrottled() {
    if (Date.now() - lastWantAt < WANT_THROTTLE_MS) return;
    lastWantAt = Date.now();
    pendingOps.push(() => channel.sendSync("sketch_want", { ...base() }));
    scheduleFlush();
  }

  /** Toolbar action: ask everyone to re-share, and re-share ourselves. */
  async function resync() {
    lastWantAt = 0;
    requestSnapshotThrottled();
    lastSnapshotAt = 0;
    await maybeSendSnapshot("manual");
  }

  // ── receive ────────────────────────────────────────────────────────────────

  channel.onSync((type, payload) => {
    if (!type.startsWith("sketch_")) return;
    if (payload.fromDevice === selfDevice()) return; // self-echo
    if (payload.v !== SKETCH_WIRE_V) return;
    const slug = boardSlug.value;
    if (!slug || payload.roomSlug !== slug) return;

    switch (type) {
      case "sketch_stroke_delta": {
        const wire = validateStrokeDelta(payload, caps);
        if (!wire) return;
        const existing = liveStrokes.value.get(wire.strokeId);
        if (!existing) {
          liveStrokes.value.set(wire.strokeId, {
            strokeId: wire.strokeId,
            author: wire.fromDevice,
            authorName: wire.fromName,
            pts: wire.pts.slice(),
            color: wire.color,
            sw: wire.sw,
            opacity: wire.opacity,
            nextIndex: wire.from + wire.pts.length / 2,
            gapped: wire.from > 0,
            lastSeenAt: Date.now(),
          });
        } else if (wire.from === existing.nextIndex) {
          existing.pts.push(...wire.pts);
          existing.nextIndex += wire.pts.length / 2;
          existing.lastSeenAt = Date.now();
        } else if (wire.from > existing.nextIndex) {
          // Lost deltas: render the jump rather than stalling. The commit repairs it.
          existing.pts.push(...wire.pts);
          existing.nextIndex = wire.from + wire.pts.length / 2;
          existing.gapped = true;
          existing.lastSeenAt = Date.now();
        } else {
          return; // duplicate or reordered — already have it
        }
        liveStrokes.value = new Map(liveStrokes.value);
        ensureSweep();
        return;
      }

      case "sketch_shape_upsert": {
        const shape = validateShape((payload as { shape?: unknown }).shape, caps);
        if (!shape) return;
        clock.observe(shape.createdAt);
        clock.observe(shape.updatedAt);
        const clearedAt = (payload as { clearedAt?: number }).clearedAt;
        if (typeof clearedAt === "number" && Number.isFinite(clearedAt)) {
          clock.observe(clearedAt);
          clearAll(doc.value, clearedAt);
        }
        if (upsertShape(doc.value, shape)) {
          unseen.value++;
          schedulePersist();
        }
        liveStrokes.value.delete(shape.id);
        liveStrokes.value = new Map(liveStrokes.value);

        // Piggybacked digest: if the sender has meaningfully more than we do we
        // missed something, so ask for a snapshot. Costs nothing in the happy path.
        const count = (payload as { count?: number }).count;
        if (typeof count === "number" && doc.value.shapes.length < count - 1) {
          requestSnapshotThrottled();
        }
        return;
      }

      case "sketch_shape_delete": {
        const raw = (payload as { ids?: unknown }).ids;
        const at = (payload as { deletedAt?: number }).deletedAt;
        if (!Array.isArray(raw) || typeof at !== "number" || !Number.isFinite(at)) return;
        const ids = raw.filter((i): i is string => typeof i === "string" && i.length > 0 && i.length <= 64);
        if (!ids.length) return;
        clock.observe(at);
        if (deleteShapes(doc.value, ids, at)) {
          unseen.value++;
          schedulePersist();
        }
        return;
      }

      case "sketch_clear": {
        const at = (payload as { clearedAt?: number }).clearedAt;
        if (typeof at !== "number" || !Number.isFinite(at)) return;
        clock.observe(at);
        if (clearAll(doc.value, at)) {
          unseen.value++;
          truncatedWarning.value = false;
          boardFull.value = false;
          schedulePersist();
        }
        return;
      }

      case "sketch_snapshot": {
        const wire = validateSnapshot(payload, caps);
        if (!wire) return;
        snapshotsSeen++;
        for (const s of wire.shapes) clock.observe(s.createdAt);
        clock.observe(wire.clearedAt);
        if (mergeSnapshot(doc.value, wire) > 0) {
          unseen.value++;
          schedulePersist();
        }
        return;
      }

      case "sketch_want": {
        void maybeSendSnapshot("want");
        return;
      }
    }
  });

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async function switchRoom(slug: string) {
    await flushPersist();
    // Abandon everything addressed to the old room: those closures would otherwise
    // be encrypted under the NEW room's MLS group.
    cancelStroke();
    pendingEraseIds = [];
    pendingOps.length = 0;
    liveStrokes.value = new Map();
    truncatedWarning.value = false;
    boardFull.value = false;
    selectedId.value = null;
    undoStack.value = [];
    redoStack.value = [];
    boardSlug.value = slug;
    doc.value = emptyDoc();
    await loadDoc(slug);
  }

  watch(channel.mlsStatus, (s) => {
    if (s === "ready") void tick();
  });

  watch(
    () => channel.participants.value.length,
    (n, o) => {
      if (n > (o ?? 0)) {
        void tick();
        void maybeSendSnapshot("roster");
      }
    },
  );

  watch(
    () => channel.currentRoom.value?.slug,
    (slug) => {
      void switchRoom(slug ?? "");
    },
    { immediate: true },
  );

  /** Re-read the open room's board (profile switch). */
  async function reload() {
    await switchRoom(channel.currentRoom.value?.slug ?? "");
  }

  return {
    // state
    doc,
    shapes,
    selfLive,
    remoteLive,
    boardSlug,
    truncatedWarning,
    boardFull,
    attentionCount,
    markSeen,
    // tool settings
    currentColor,
    currentWidth,
    currentOpacity,
    currentFill,
    // caps (for the UI)
    maxShapes: caps.maxShapes,
    maxTextLen: caps.maxTextLen,
    // drawing
    beginStroke,
    extendStroke,
    commitStroke,
    cancelStroke,
    addRect,
    addTriangle,
    addEllipse,
    addArrow,
    addText,
    eraseAlong,
    clearBoard,
    // selection + transforms
    selectedId,
    selected,
    selectionBounds,
    selectAt,
    clearSelection,
    beginTransform,
    moveSelected,
    resizeSelected,
    endTransform,
    restyleSelected,
    deleteSelected,
    // history
    canUndo,
    canRedo,
    undo,
    redo,
    // lifecycle
    resync,
    reload,
    flushPersist,
  };
}

export type Sketch = ReturnType<typeof useSketch>;
