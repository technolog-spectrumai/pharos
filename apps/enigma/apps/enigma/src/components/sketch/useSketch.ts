// Sketch orchestrator — one standalone local drawing board.
//
// Not tied to a chat room and not shared with anyone: the board is this device's,
// persisted in the encrypted kv store and exported as SVG or PNG. (It was once a
// per-room collaborative surface; that engine is parked in
// `limbo/frontend/sketch-collab/` — see its NOTES.md.)
//
// Persistence is debounced because **every kvPut is an fsync** (`kv_put` →
// protasius `put_enc` → `persist`), and drawing mutates state on every pointer
// release. `flushPersist()` forces a write before unmount and before export.
//
// The board is a module-level singleton (`getSketch()`), not view state: the router
// uses createMemoryHistory and unmounts views on navigation, so a per-view ref would
// drop the drawing and its undo history every time the user visits another tab. It
// is deliberately NOT a Pinia store — `stores/chat.ts` documents the reason, namely
// that Pinia's reactive() deep-unwraps inner refs, and the canvas/toolbar components
// take the whole orchestrator as a prop and read `.value` directly.

import { computed, ref } from "vue";
import { getBuildConfig, kvDelete, kvGet, kvPut } from "rakotis";
import {
  emptyDoc,
  hitTest,
  MIN_POINT_DIST,
  normDeg,
  quant,
  rotatePoint,
  scaleShape,
  shapeBounds,
  shapePivot,
  translateShape,
  validateBackgroundImage,
  validateDoc,
  type ArrowShape,
  type EllipseShape,
  type PathShape,
  type RectShape,
  type Shape,
  type SketchCaps,
  type SketchDoc,
  type TextShape,
  type TriangleShape,
} from "./sketchModel";

const KV_NS = "sketch";
const KV_SCOPE = "default";
/** Single board ⇒ the empty-key convention used by `contacts` / `p2p:rooms`.
 *  Not in DEVLINK_SYNC_KV, so the board stays device-local by construction. */
const KV_KEY = "";
/** The background image lives under its own key. Drawing rewrites the shape
 *  document constantly (and every kvPut is an fsync), so a megabyte of base64
 *  riding along on each autosave would be paid over and over for nothing — the
 *  image only changes when the user picks one. */
const KV_KEY_IMAGE = "background";

const PERSIST_DEBOUNCE_MS = 800;
/** Bounded so a long session can't grow the history without limit. */
const UNDO_LIMIT = 100;
/** Eraser drag is sampled along the segment so a fast flick can't skip shapes. */
const ERASE_STEP = 4;

/** The in-progress freehand stroke. Local preview only — it becomes a real shape on
 *  pointer release, so it is never persisted mid-drag. */
interface LiveStroke {
  id: string;
  pts: number[];
  color: string;
  sw: number;
  opacity: number;
}

export function useSketch() {
  const cfg = getBuildConfig();
  const caps: SketchCaps = {
    maxShapes: cfg.sketch_max_shapes_per_board,
    maxTextLen: cfg.sketch_max_text_len,
  };

  const doc = ref<SketchDoc>(emptyDoc());
  /** Board-cropped data URL, or null. Kept beside the document, not inside it. */
  const backgroundImage = ref<string | null>(null);
  const selfLive = ref<LiveStroke | null>(null);
  const selectedId = ref<string | null>(null);
  const boardFull = ref(false);
  /** A load has been started (dedupes concurrent load() calls). */
  const loading = ref(false);
  /** A load has FINISHED. Persisting before this would write the initial empty
   *  document over the user's saved board — see persist(). */
  const ready = ref(false);
  /** Storage could not be read, so persistence is disabled to avoid overwriting a
   *  board we never managed to see. Surfaced in the UI. */
  const loadFailed = ref(false);

  const shapes = computed(() => doc.value.shapes);
  const selected = computed(() => doc.value.shapes.find((s) => s.id === selectedId.value) ?? null);
  const selectionBounds = computed(() => (selected.value ? shapeBounds(selected.value) : null));
  const selectionPivot = computed(() => (selected.value ? shapePivot(selected.value) : null));

  // ── tool settings ──────────────────────────────────────────────────────────

  const currentColor = ref<string>("#111827");
  const currentWidth = ref<number>(4);
  const currentOpacity = ref<number>(1);
  /** null = outline only. Applies to rect / ellipse / triangle. */
  const currentFill = ref<string | null>(null);

  function styleOf() {
    return {
      color: currentColor.value,
      sw: currentWidth.value,
      opacity: currentOpacity.value,
      fill: currentFill.value,
    };
  }

  // ── persistence ────────────────────────────────────────────────────────────

  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function persist() {
    // Never write before the load has come back. `load()` awaits an IPC read, and
    // the view fires it without awaiting; a flush in that window (tab switch, or
    // an export) would otherwise save the initial empty document over a board the
    // user has not even seen yet, and the in-flight load would then repopulate
    // memory only — so the loss stays invisible until the next restart.
    if (!ready.value) return;
    await kvPut(KV_NS, KV_SCOPE, KV_KEY, JSON.stringify(doc.value)).catch(() => {});
  }

  /** Written on its own, only from setBackgroundImage / undo-redo of one. */
  async function persistImage() {
    if (!ready.value) return;
    const v = backgroundImage.value;
    await (v
      ? kvPut(KV_NS, KV_SCOPE, KV_KEY_IMAGE, v)
      : kvDelete(KV_NS, KV_SCOPE, KV_KEY_IMAGE)
    ).catch(() => {});
  }

  /** Persist now — before unmount or export. */
  async function flushPersist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persist();
  }

  /** Load the saved board. Safe to call repeatedly; only the first load applies.
   *
   *  The two keys are read and recovered INDEPENDENTLY. Sharing one try (or one
   *  Promise.all) means a failure in either discards the other — and a failure
   *  reading the image would open the persist gate over an empty document, so the
   *  next flush would destroy a drawing that was never even unreadable. */
  async function load() {
    if (loading.value) return;
    loading.value = true;

    // Storage read and content parse are handled separately, because they call for
    // opposite responses: unreadable STORAGE means we must not write (we would be
    // overwriting something we failed to see), while readable-but-corrupt CONTENT
    // means there is nothing left to protect and starting fresh is right.
    let raw: string | null = null;
    let storageOk = true;
    try {
      raw = await kvGet(KV_NS, KV_SCOPE, KV_KEY);
    } catch {
      storageOk = false;
    }

    if (storageOk) {
      try {
        const parsed = raw ? validateDoc(JSON.parse(raw), caps) : null;
        if (parsed) doc.value = parsed;
      } catch {
        doc.value = emptyDoc();
      }
      ready.value = true;
    } else {
      // Refuse to persist for the rest of the session rather than clobber the
      // board, and say so — silently not saving would be its own kind of loss.
      loadFailed.value = true;
    }

    try {
      // Validated because this string goes straight into an SVG href and the DOM.
      backgroundImage.value = validateBackgroundImage(await kvGet(KV_NS, KV_SCOPE, KV_KEY_IMAGE));
    } catch {
      backgroundImage.value = null;
    }
  }

  /** Re-read the board from scratch (profile switch). */
  async function reload() {
    loading.value = false;
    ready.value = false;
    loadFailed.value = false;
    doc.value = emptyDoc();
    backgroundImage.value = null;
    selectedId.value = null;
    undoStack.value = [];
    redoStack.value = [];
    await load();
  }

  // ── undo / redo ────────────────────────────────────────────────────────────
  // Whole-document snapshots. With one user and an immutable-by-convention shape
  // list, this is both simpler and harder to get wrong than inverse operations —
  // and boards are small enough (capped at `maxShapes`) that the copies are cheap.
  // The background is document state too, so it rides in the snapshot; otherwise
  // undoing a shape edit would silently revert a background change made after it.

  interface DocState {
    shapes: Shape[];
    background: string | null;
    /** A reference, not a copy: strings are immutable, so repeating a multi-MB
     *  data URL across 100 undo entries costs 100 pointers. */
    image: string | null;
  }

  const undoStack = ref<DocState[]>([]);
  const redoStack = ref<DocState[]>([]);

  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);

  function currentState(): DocState {
    return {
      shapes: doc.value.shapes.slice(),
      background: doc.value.background,
      image: backgroundImage.value,
    };
  }

  /** Call BEFORE mutating the document. */
  function snapshot() {
    undoStack.value.push(currentState());
    if (undoStack.value.length > UNDO_LIMIT) undoStack.value.shift();
    redoStack.value = []; // a fresh action forks the timeline
  }

  function applyShapes(next: Shape[]) {
    doc.value.shapes = next;
    if (selectedId.value && !next.some((s) => s.id === selectedId.value)) {
      selectedId.value = null;
    }
    boardFull.value = next.length >= caps.maxShapes;
    schedulePersist();
  }

  function applyState(next: DocState) {
    doc.value.background = next.background;
    const imageChanged = backgroundImage.value !== next.image;
    backgroundImage.value = next.image;
    applyShapes(next.shapes);
    // Only touch the image key when it actually moved — see KV_KEY_IMAGE.
    if (imageChanged) void persistImage();
  }

  function undo() {
    const prev = undoStack.value.pop();
    if (!prev) return;
    redoStack.value.push(currentState());
    applyState(prev);
  }

  function redo() {
    const next = redoStack.value.pop();
    if (!next) return;
    undoStack.value.push(currentState());
    applyState(next);
  }

  // ── creating shapes ────────────────────────────────────────────────────────

  function atCapacity(): boolean {
    if (doc.value.shapes.length < caps.maxShapes) return false;
    boardFull.value = true;
    return true;
  }

  /** Fields every newly created shape shares. */
  function newBase() {
    return { id: crypto.randomUUID(), ...styleOf(), rot: 0 };
  }

  /** Append a shape as the new topmost, with an undo point. */
  function commit(shape: Shape) {
    snapshot();
    applyShapes([...doc.value.shapes, shape]);
  }

  function beginStroke(x: number, y: number) {
    if (atCapacity()) return;
    selfLive.value = {
      id: crypto.randomUUID(),
      pts: [quant(x), quant(y)],
      color: currentColor.value,
      sw: currentWidth.value,
      opacity: currentOpacity.value,
    };
  }

  function extendStroke(x: number, y: number) {
    const live = selfLive.value;
    if (!live) return;
    const n = live.pts.length;
    // Thin: a pointer that barely moved adds nothing but JSON.
    if (n >= 2 && Math.hypot(x - live.pts[n - 2], y - live.pts[n - 1]) < MIN_POINT_DIST) return;
    live.pts.push(quant(x), quant(y));
  }

  function commitStroke() {
    const live = selfLive.value;
    selfLive.value = null;
    if (!live || live.pts.length < 2) return;
    commit({
      id: live.id,
      kind: "path",
      color: live.color,
      sw: live.sw,
      opacity: live.opacity,
      fill: null,
      rot: 0,
      pts: live.pts.slice(),
    } as PathShape);
  }

  function cancelStroke() {
    selfLive.value = null;
  }

  function addRect(x: number, y: number, w: number, h: number) {
    if (atCapacity() || Math.abs(w) < 1 || Math.abs(h) < 1) return;
    commit({
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
    commit({
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
    commit({
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
    commit({
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
    commit({
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

  // ── selection + transforms ─────────────────────────────────────────────────

  function selectAt(x: number, y: number, radius: number) {
    selectedId.value = hitTest(doc.value.shapes, x, y, radius);
    return selectedId.value;
  }

  function clearSelection() {
    selectedId.value = null;
  }

  /** Replace the selected shape in place — used for live drag previews, so it takes
   *  no undo point and does not schedule a write. */
  function replaceSelected(next: Shape) {
    const i = doc.value.shapes.findIndex((s) => s.id === next.id);
    if (i !== -1) doc.value.shapes[i] = next;
  }

  /** Snapshot taken at the start of a drag so the whole gesture is ONE undo step. */
  let dragBefore: Shape[] | null = null;

  function beginTransform() {
    dragBefore = doc.value.shapes.slice();
  }

  function moveSelected(dx: number, dy: number) {
    const s = selected.value;
    if (!s) return;
    replaceSelected(translateShape(s, dx, dy));
  }

  /** Scale about (ox,oy) in the shape's UNROTATED frame — the caller maps the
   *  pointer into that frame first.
   *
   *  Rotation makes this more than a plain scale: every renderer turns the shape
   *  about the centre of its bounds, and scaling MOVES that centre, so a naive
   *  scale would swing the shape away from the anchor the user is dragging
   *  against. Compensate by translating so the anchor corner stays put on screen. */
  function resizeSelected(fx: number, fy: number, ox: number, oy: number) {
    const s = selected.value;
    if (!s) return;
    const scaled = scaleShape(s, ox, oy, fx, fy);
    if (!s.rot) {
      replaceSelected(scaled);
      return;
    }
    // Where the anchor renders before vs after the pivot shift. Translating by the
    // difference is exact: a translation moves point and pivot together, so it
    // shifts the rendered position by exactly that vector.
    const p0 = shapePivot(s);
    const p1 = shapePivot(scaled);
    const a0 = rotatePoint(ox, oy, p0.cx, p0.cy, s.rot);
    const a1 = rotatePoint(ox, oy, p1.cx, p1.cy, s.rot);
    replaceSelected(translateShape(scaled, a0.x - a1.x, a0.y - a1.y));
  }

  /** Absolute rotation in degrees, about the shape's own pivot. */
  function rotateSelected(deg: number) {
    const s = selected.value;
    if (!s) return;
    replaceSelected({ ...s, rot: normDeg(deg) });
  }

  /** Commit a drag: one undo entry for the whole gesture, one persist. */
  function endTransform() {
    const before = dragBefore;
    dragBefore = null;
    if (!before) return;
    if (JSON.stringify(before) === JSON.stringify(doc.value.shapes)) return; // no-op drag
    const after = doc.value.shapes.slice();
    doc.value.shapes = before;
    snapshot();
    applyShapes(after);
  }

  /** Rotate/restyle from a control rather than a drag: snapshot and commit at once. */
  function commitSelectedChange(mutate: (s: Shape) => Shape) {
    const s = selected.value;
    if (!s) return;
    const next = mutate(s);
    if (JSON.stringify(next) === JSON.stringify(s)) return;
    snapshot();
    applyShapes(doc.value.shapes.map((x) => (x.id === next.id ? next : x)));
  }

  /** Apply the current tool style to the selected shape. */
  function restyleSelected() {
    commitSelectedChange((s) => ({ ...s, ...styleOf() }));
  }

  /** Set the selected shape's rotation from the numeric field. */
  function setSelectedRotation(deg: number) {
    if (!Number.isFinite(deg)) return;
    commitSelectedChange((s) => ({ ...s, rot: normDeg(deg) }));
  }

  function deleteSelected() {
    const s = selected.value;
    if (!s) return;
    snapshot();
    applyShapes(doc.value.shapes.filter((x) => x.id !== s.id));
  }

  // ── erase + clear ──────────────────────────────────────────────────────────

  /** One eraser press-drag-release is ONE undo step, however many samples it spans
   *  — otherwise a single sweep costs a dozen Ctrl+Z and can evict real history at
   *  UNDO_LIMIT. Reset on pointerdown; the snapshot is taken lazily at the first
   *  shape actually erased, so a sweep over empty canvas adds nothing. */
  let eraseSnapshotTaken = false;

  function beginErase() {
    eraseSnapshotTaken = false;
  }

  /** Erase along the segment from the previous pointer position to this one — a fast
   *  drag emits sparse moves and would otherwise skip shapes. */
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
    if (!eraseSnapshotTaken) {
      snapshot();
      eraseSnapshotTaken = true;
    }
    applyShapes(doc.value.shapes.filter((s) => !hits.has(s.id)));
  }

  /** Set the board background, or null for transparent. Undoable. */
  function setBackground(color: string | null) {
    if (doc.value.background === color) return;
    snapshot();
    doc.value.background = color;
    schedulePersist();
  }

  /** Set or clear the board background image. Expects an already board-cropped,
   *  validated data URL from `backgroundImageFromFile`. Undoable. */
  function setBackgroundImage(dataUrl: string | null) {
    const next = dataUrl === null ? null : validateBackgroundImage(dataUrl);
    if (backgroundImage.value === next) return;
    snapshot();
    backgroundImage.value = next;
    void persistImage();
  }

  function clearBoard() {
    if (!doc.value.shapes.length) return;
    snapshot();
    applyShapes([]);
    boardFull.value = false;
  }

  return {
    // state
    doc,
    shapes,
    selfLive,
    boardFull,
    loadFailed,
    // tool settings
    currentColor,
    currentWidth,
    currentOpacity,
    currentFill,
    // caps
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
    beginErase,
    eraseAlong,
    clearBoard,
    setBackground,
    backgroundImage,
    setBackgroundImage,
    // selection + transforms
    selectedId,
    selected,
    selectionBounds,
    selectionPivot,
    selectAt,
    clearSelection,
    beginTransform,
    moveSelected,
    resizeSelected,
    rotateSelected,
    endTransform,
    restyleSelected,
    setSelectedRotation,
    deleteSelected,
    // history
    canUndo,
    canRedo,
    undo,
    redo,
    // lifecycle
    load,
    reload,
    flushPersist,
  };
}

export type Sketch = ReturnType<typeof useSketch>;

// Lazy module singleton: created on first use (so nothing touches the kv store at
// import time) and shared by every view, which is what keeps the drawing and its
// undo history alive across tab navigation.
let instance: Sketch | null = null;

export function getSketch(): Sketch {
  if (!instance) instance = useSketch();
  return instance;
}

/** Test seam — drops the singleton so a fresh one is built next call. */
export function resetSketch(): void {
  instance = null;
}

/** Re-exported for the rotate handle so the canvas doesn't reach into the model. */
export { rotatePoint };
