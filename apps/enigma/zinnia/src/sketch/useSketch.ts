// Sketch orchestrator — the editing state for ONE open .svg file.
//
// This was a module-level singleton over one board stored in the kv store. It is
// now a FACTORY: the editor opens N files by path, and each gets its own
// document, undo history and selection, created on open and dropped on close.
// Persistence moved out entirely — Files → Local owns save (an explicit press,
// through the same sealed `local_note_write` the notes editor uses), so there is
// no debounce, no autosave and no kv document key any more.
//
// What it still holds beside the shapes is the ENVELOPE: the root attributes,
// the prologue and every opaque node of the file it was opened from, so saving
// rewrites only our own shapes and leaves the rest of a foreign SVG untouched.
//
// The palette is the one thing that stays in the kv store: seven colour slots are
// a device-wide tool preference, not part of any document.
//
// Deliberately NOT a Pinia store — `stores/chat.ts` documents the reason, namely
// that Pinia's reactive() deep-unwraps inner refs, and the canvas/toolbar
// components take the whole orchestrator as a prop and read `.value` directly.

import { computed, ref } from "vue";
import { loadPaletteRaw, savePaletteRaw } from "./paletteStore";
import {
  DEFAULT_CAPS,
  DEFAULT_SLOT_COLORS,
  hitTest,
  MIN_POINT_DIST,
  normalizeSlots,
  normDeg,
  PALETTE_SLOTS,
  PICKER_COLORS,
  quant,
  rotatePoint,
  scaleShape,
  shapeBounds,
  shapePivot,
  translateShape,
  validateBackgroundImage,
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
import {
  emptySvgDocument,
  serializeSvgDocument,
  shapesOf,
  withShapes,
  type SvgDocument,
} from "./svgDocument";


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

/** One editing session over one file. `source` is the parsed document the file
 *  was opened from — its root attributes, prologue and opaque nodes ride along
 *  untouched so `toText()` can put them back exactly where they were. */
export function useSketch(source: SvgDocument = emptySvgDocument()) {
  const caps: SketchCaps = DEFAULT_CAPS;

  /** The envelope. Only `nodes` is replaced on save; everything else is verbatim. */
  const envelope = ref<SvgDocument>(source);
  const doc = ref<SketchDoc>({ v: 1, shapes: shapesOf(source), background: source.background });
  /** Board-cropped data URL, or null. Kept beside the document, not inside it. */
  const backgroundImage = ref<string | null>(null);
  const selfLive = ref<LiveStroke | null>(null);
  const selectedId = ref<string | null>(null);
  const boardFull = ref(false);

  /** The palette key has been read. Deliberately NOT `ready`, which guards the
   *  DOCUMENT key and says nothing about this one: if the palette read failed while
   *  the document read succeeded, gating on `ready` would let the very first swap
   *  write an all-defaults palette over the user's real saved one. Same reasoning
   *  as the separate try blocks in load(). */
  const paletteReady = ref(false);

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
  /** The seven assignable colours behind both the stroke row and the fill row. */
  const slots = ref<string[]>([...DEFAULT_SLOT_COLORS]);

  /** Board size comes from the FILE's own viewBox, not from the container. The
   *  old board was one elastic sheet that filled the window; a document has
   *  intrinsic dimensions that must survive a round trip. */
  const boardW = computed(() => envelope.value.width);
  const boardH = computed(() => envelope.value.height);
  function setBoardWidth(_w: number) {
    /* kept for the canvas's ResizeObserver call site; geometry is the file's now */
  }

  /** Assign a colour to one slot.
   *
   *  NOT undoable, and it must never call snapshot() or restyleSelected(): the
   *  palette is a device preference, and those would push an undo entry, clear the
   *  redo stack and schedule a document write — turning a palette edit into a
   *  drawing edit. (Which is also why `currentColor` must never grow a
   *  `watch(..., restyleSelected)`: the follow rule below would start mutating
   *  shapes.)
   *
   *  The active stroke/fill FOLLOWS the slot it was pinned to, but only when the
   *  old colour has left the row entirely — duplicates are legal, and if another
   *  slot still shows it the highlight belongs there instead. Without this the row
   *  can end up with nothing highlighted and no way back to the active colour.
   *  Note the pre-check on `prev`: the tempting shortcut of testing afterwards
   *  whether currentColor is still on the row is wrong for a currentColor that was
   *  already off-palette, where editing ANY unrelated slot would yank it. */
  function setSlot(i: number, color: string) {
    // The index needs its own guard — the colour check says nothing about it, and
    // an out-of-range write would silently lengthen the row.
    if (!Number.isInteger(i) || i < 0 || i >= PALETTE_SLOTS) return;
    if (!PICKER_COLORS.includes(color)) return;
    const prev = slots.value[i];
    if (prev === color) return;
    const next = slots.value.slice();
    next[i] = color;
    slots.value = next;
    if (currentColor.value === prev && !next.includes(prev)) currentColor.value = color;
    if (currentFill.value === prev && !next.includes(prev)) currentFill.value = color;
    void persistPalette();
  }

  function styleOf() {
    return {
      color: currentColor.value,
      sw: currentWidth.value,
      opacity: currentOpacity.value,
      fill: currentFill.value,
    };
  }

  // ── persistence ────────────────────────────────────────────────────────────

  /** Written on its own, from setSlot only. Not debounced: a swap is one
   *  deliberate click in the picker, not a stream of them like drawing. */
  async function persistPalette() {
    if (!paletteReady.value) return;
    await savePaletteRaw(JSON.stringify(slots.value)).catch(() => {});
  }

  /** Read the saved palette. The document itself arrives through the factory
   *  argument, already parsed — the only thing left to load is this preference.
   *
   *  Storage failure and parse failure get opposite treatment, as before: a
   *  palette we could not READ must not be written over, while one we read but
   *  could not PARSE has nothing left to protect, so defaults are safe and the
   *  next swap repairs the record. */
  async function loadPalette() {
    let raw: string | null = null;
    let storageOk = true;
    try {
      raw = await loadPaletteRaw();
    } catch {
      storageOk = false;
    }
    if (!storageOk) return;
    try {
      slots.value = normalizeSlots(raw ? JSON.parse(raw) : null);
    } catch {
      slots.value = [...DEFAULT_SLOT_COLORS];
    }
    paletteReady.value = true;
  }

  /** The file to write back: our shapes re-rendered into the envelope this
   *  document was opened from, so opaque nodes, <defs> and the root attributes
   *  come back byte-for-byte and only our own elements are regenerated. */
  function toText(): string {
    return serializeSvgDocument({
      ...withShapes(envelope.value, doc.value.shapes),
      background: doc.value.background,
      backgroundImage: backgroundImage.value,
    });
  }

  /** How many elements of the opened file this editor cannot represent. Shown so
   *  the user knows the drawing has parts they can see but not select. */
  const opaqueCount = computed(
    () => envelope.value.nodes.filter((n) => n.kind === "opaque").length,
  );

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
  }

  function applyState(next: DocState) {
    doc.value.background = next.background;
    backgroundImage.value = next.image;
    applyShapes(next.shapes);
    // The image rides in the document now (it is serialized into the file on
    // save), so undoing one needs no separate write.
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
  }

  /** Set or clear the board background image. Expects an already board-cropped,
   *  validated data URL from `backgroundImageFromFile`. Undoable. */
  function setBackgroundImage(dataUrl: string | null) {
    const next = dataUrl === null ? null : validateBackgroundImage(dataUrl);
    if (backgroundImage.value === next) return;
    snapshot();
    backgroundImage.value = next;
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
    envelope,
    opaqueCount,
    boardH,
    // tool settings
    currentColor,
    currentWidth,
    currentOpacity,
    currentFill,
    slots,
    setSlot,
    boardW,
    setBoardWidth,
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
    loadPalette,
    toText,
  };
}

export type Sketch = ReturnType<typeof useSketch>;

/** One instance per open file — created on open, dropped on close. There is no
 *  singleton any more: two editors would otherwise share one undo history. */
export function createSketch(source?: SvgDocument): Sketch {
  return useSketch(source);
}

/** Re-exported for the rotate handle so the canvas doesn't reach into the model. */
export { rotatePoint };
