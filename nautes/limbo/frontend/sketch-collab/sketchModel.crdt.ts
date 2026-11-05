// Shared sketch board — pure data model + reconcilers (no Vue/Tauri/DOM imports).
//
// One board per chat room (board identity = room slug). Every member draws on the
// same surface; shapes flow over the chat channel's MLS-encrypted sync seam via
// `sketch_*` inner types (see useSketch.ts).
//
// Merge is an LWW-element-set, which is a CRDT: idempotent, commutative and
// associative, so ops and snapshots can be applied in any order, any number of
// times, and every peer converges. That is what makes the transport survivable —
// iroh gossip is unordered and silently drops frames when a receiver falls behind
// (`Event::Lagged => {}` in p2p_iroh.rs), and nothing in the app acks or retries.
//
//   shapes      keyed by id, last-write-wins on `updatedAt` (author breaks ties)
//   tombstones  id -> deletedAt, max-merged; a delete wins a same-clock tie
//   clearedAt   max (grow-only register)
//
// Add and delete are BOTH last-write-wins rather than remove-wins, because undo
// has to be able to resurrect an erased shape: an upsert stamped later than the
// tombstone takes the shape back. (An earlier revision made shapes immutable and
// used pure remove-wins; transforms and undo made that untenable.)
//
// Ordering needs timestamps for three things — paint order (`createdAt`), LWW
// (`updatedAt`) and the clear cutoff — so they come from a hybrid logical clock
// rather than the wall clock: a peer with a slow clock would otherwise have its
// post-clear work silently voided and always lose LWW. See `makeClock`.
//
// Trust model: cooperative — `author` / `fromDevice` are self-asserted inside the
// ciphertext, authenticating MLS-group membership, not authorship. A malicious
// member could forge them, erase, or clear. Same posture as kanbanModel.ts.

export const SKETCH_WIRE_V = 1 as const;

/** Fixed logical board space. Peers have different window sizes; coordinates are
 *  always in these units and the view letterboxes to fit. */
export const BOARD_W = 1920;
export const BOARD_H = 1080;

/** Minimum pointer travel (board units) before a freehand sample is kept. Thins a
 *  ~600-sample drag down to ~150 without visible loss. */
export const MIN_POINT_DIST = 1.5;
/** A peer's in-progress stroke is dropped this long after its last delta, so a lost
 *  commit can't leave a ghost overlay forever. */
export const LIVE_STROKE_TTL_MS = 5000;

export const SKETCH_COLORS = [
  "#111827",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ffffff",
] as const;
export const STROKE_SIZES = [2, 4, 8, 16] as const;
export const TEXT_SIZES = [16, 24, 36, 56] as const;
export const OPACITY_STEPS = [0.25, 0.5, 0.75, 1] as const;

/** Shared by the SVG output and the canvas rasterizer so the two can't drift. */
export const SVG_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ── shapes ────────────────────────────────────────────────────────────────────

export type ShapeKind = "path" | "rect" | "ellipse" | "triangle" | "arrow" | "text";

export interface ShapeBase {
  /** uuid. For freehand this is also the streaming stroke id. */
  id: string;
  kind: ShapeKind;
  /** Creator's MLS leaf id — paint-order and LWW tie-break, plus attribution. */
  author: string;
  /** Hybrid-logical-clock ms: paint order AND the clear cutoff. Never changes. */
  createdAt: number;
  /** Hybrid-logical-clock ms of the last edit. The LWW key. */
  updatedAt: number;
  /** Outline colour (and fill colour for text). */
  color: string;
  /** Stroke width in board units. Named `sw` because `rect` already uses `w`. */
  sw: number;
  /** 0..1. Applies to the whole shape. */
  opacity: number;
  /** Interior fill, or null for an outline-only shape. Ignored by path/arrow/text. */
  fill: string | null;
}

export interface PathShape extends ShapeBase {
  kind: "path";
  /** Flat [x0,y0,x1,y1,…] — half the JSON of an array of pairs. */
  pts: number[];
}
/** Rect, ellipse and triangle are all box-defined, so create-by-drag and the
 *  transform helpers treat them identically. */
export interface RectShape extends ShapeBase {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface EllipseShape extends ShapeBase {
  kind: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}
/** Isoceles, inscribed in its box: apex at top-centre, base along the bottom. */
export interface TriangleShape extends ShapeBase {
  kind: "triangle";
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ArrowShape extends ShapeBase {
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface TextShape extends ShapeBase {
  kind: "text";
  /** Baseline start. */
  x: number;
  y: number;
  text: string;
  size: number;
  /** Advance width / line height, measured once at creation. Stored so hit-testing
   *  stays pure — no font metrics needed at merge or erase time. */
  tw: number;
  th: number;
}

export type Shape =
  | PathShape
  | RectShape
  | EllipseShape
  | TriangleShape
  | ArrowShape
  | TextShape;

/** Kinds whose interior can be filled. */
export function canFill(kind: ShapeKind): boolean {
  return kind === "rect" || kind === "ellipse" || kind === "triangle";
}

export interface SketchDoc {
  v: 1;
  /** Live shapes only, kept sorted by `compareShapes`. */
  shapes: Shape[];
  /** shapeId → deletedAt. Max-merged; an upsert stamped later resurrects. */
  tombstones: Record<string, number>;
  clearedAt: number;
}

export function emptyDoc(): SketchDoc {
  return { v: 1, shapes: [], tombstones: {}, clearedAt: 0 };
}

/** Caps come from build config; the model takes them as data so it stays pure. */
export interface SketchCaps {
  maxShapes: number;
  maxPointsPerStroke: number;
  maxTextLen: number;
}

// ── hybrid logical clock ──────────────────────────────────────────────────────

export interface SketchClock {
  now(): number;
  observe(t: number): void;
}

/** Monotonic clock that never falls behind anything a peer has told us about.
 *  Without this, a peer whose wall clock is slow would stamp new shapes below a
 *  clear it has already seen, and would lose every LWW race. */
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

// ── ordering ──────────────────────────────────────────────────────────────────

/** Total order, identical on every peer: creation time, then author, then id.
 *  No fractional index — there is no reorder feature to support. */
export function compareShapes(a: Shape, b: Shape): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function liveShapes(doc: SketchDoc): Shape[] {
  return doc.shapes;
}

// ── merge ─────────────────────────────────────────────────────────────────────

/** True when `next` should replace `prev` under LWW. Ties break on author so every
 *  peer resolves a simultaneous edit the same way. */
function wins(next: Shape, prev: Shape): boolean {
  if (next.updatedAt !== prev.updatedAt) return next.updatedAt > prev.updatedAt;
  return next.author > prev.author;
}

/** Insert or replace a shape. Returns false when it is void or stale: predating a
 *  clear, older than the tombstone that erased it, or losing LWW to what we hold.
 *  An upsert stamped after the tombstone RESURRECTS the shape — that is how undo
 *  of an erase works, and why deletion is LWW rather than remove-wins. */
export function upsertShape(doc: SketchDoc, s: Shape): boolean {
  if (s.createdAt <= doc.clearedAt) return false;
  const tomb = doc.tombstones[s.id];
  // A delete wins a same-clock tie.
  if (tomb !== undefined && s.updatedAt <= tomb) return false;
  if (tomb !== undefined) delete doc.tombstones[s.id];

  const i = doc.shapes.findIndex((x) => x.id === s.id);
  if (i === -1) {
    doc.shapes.push(s);
    doc.shapes.sort(compareShapes);
    return true;
  }
  if (!wins(s, doc.shapes[i])) return false;
  // createdAt is immutable — keep ours so paint order can't be rewritten remotely.
  doc.shapes[i] = { ...s, createdAt: doc.shapes[i].createdAt };
  return true;
}

/** Tombstone ids, max-merging `deletedAt`. Recording a tombstone for a shape we
 *  have never seen is intentional — that is what makes delete-before-add work over
 *  unordered gossip. Returns the number of records actually changed. */
export function deleteShapes(doc: SketchDoc, ids: string[], at: number): number {
  let changed = 0;
  for (const id of ids) {
    const prev = doc.tombstones[id];
    if (prev === undefined || at > prev) {
      doc.tombstones[id] = at;
      changed++;
    }
  }
  const before = doc.shapes.length;
  doc.shapes = doc.shapes.filter((s) => {
    const tomb = doc.tombstones[s.id];
    return tomb === undefined || s.updatedAt > tomb;
  });
  return changed + (before - doc.shapes.length);
}

/** Raise the clear cutoff. Every tombstoned shape predates the clear, so the
 *  tombstone map can be dropped wholesale — free garbage collection. */
export function clearAll(doc: SketchDoc, at: number): boolean {
  if (at <= doc.clearedAt) return false;
  doc.clearedAt = at;
  doc.shapes = doc.shapes.filter((s) => s.createdAt > at);
  doc.tombstones = {};
  return true;
}

export interface SnapshotWire {
  roomSlug: string;
  v: 1;
  shapes: Shape[];
  /** [id, deletedAt] pairs — compact next to an object. */
  tombs: [string, number][];
  clearedAt: number;
  truncated: boolean;
  fromName: string;
  fromDevice: string;
}

/** Join a peer's snapshot into ours. STRICTLY ADDITIVE: never removes a shape just
 *  because the snapshot omits it. That is what makes a truncated snapshot safe, and
 *  what stops a peer that just joined (empty doc) from wiping everybody. */
export function mergeSnapshot(doc: SketchDoc, wire: SnapshotWire): number {
  let changed = 0;
  if (clearAll(doc, wire.clearedAt)) changed++;
  for (const [id, at] of wire.tombs) changed += deleteShapes(doc, [id], at);
  for (const s of wire.shapes) if (upsertShape(doc, s)) changed++;
  return changed;
}

/** Keep the `max` most recently deleted tombstones. Not time-based: an expiry would
 *  resurrect shapes for a peer that was offline when they were erased. */
export function gcTombstones(doc: SketchDoc, max = 5000): number {
  const entries = Object.entries(doc.tombstones);
  if (entries.length <= max) return 0;
  entries.sort((a, b) => b[1] - a[1]);
  doc.tombstones = Object.fromEntries(entries.slice(0, max));
  return entries.length - max;
}

/** Drop oldest shapes until the serialized snapshot fits `maxBytes`. Oldest-first
 *  because the newest shapes are what a joiner most needs. Extracted from the
 *  composable so it is testable. */
export function truncateSnapshot(
  shapes: Shape[],
  tombs: [string, number][],
  clearedAt: number,
  maxBytes: number,
): { shapes: Shape[]; tombs: [string, number][]; truncated: boolean } {
  let kept = shapes;
  let truncated = false;
  const size = () => JSON.stringify({ shapes: kept, tombs, clearedAt }).length;
  while (kept.length > 1 && size() > maxBytes) {
    kept = kept.slice(Math.ceil(kept.length * 0.15));
    truncated = true;
  }
  return { shapes: kept, tombs, truncated };
}

// ── geometry ──────────────────────────────────────────────────────────────────

/** Quantize to 0.1 board units — meaningful precision at a fraction of the JSON. */
export function quant(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Freehand path data, quadratic-midpoint smoothed: raw samples become control
 *  points and the on-curve points are the midpoints between them. C1-continuous in
 *  one pass with no lookahead — which also makes it APPEND-SAFE, so re-serializing
 *  a live stroke as deltas arrive never shifts geometry already drawn. */
export function pathD(pts: number[]): string {
  const n = pts.length >> 1;
  if (n === 0) return "";
  // A lone sample is a dot: a near-zero segment painted by stroke-linecap="round".
  if (n === 1) return `M${pts[0]} ${pts[1]}l0.01 0`;
  if (n === 2) return `M${pts[0]} ${pts[1]}L${pts[2]} ${pts[3]}`;
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 1; i < n - 1; i++) {
    const cx = pts[i * 2];
    const cy = pts[i * 2 + 1];
    const mx = (cx + pts[i * 2 + 2]) / 2;
    const my = (cy + pts[i * 2 + 3]) / 2;
    d += `Q${cx} ${cy} ${mx} ${my}`;
  }
  return `${d}L${pts[(n - 1) * 2]} ${pts[(n - 1) * 2 + 1]}`;
}

/** The three corners of a triangle inscribed in its box. */
export function trianglePoints(s: TriangleShape): [number, number][] {
  return [
    [s.x + s.w / 2, s.y],
    [s.x + s.w, s.y + s.h],
    [s.x, s.y + s.h],
  ];
}

/** Arrow head as a filled triangle at (x2,y2). Head size scales with stroke width
 *  but is capped to the shaft length so a short arrow stays legible. */
export function arrowHead(s: ArrowShape): [number, number][] {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy) || 1;
  const size = Math.min(Math.max(s.sw * 3, 8), len);
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular, half-width of the head.
  const px = -uy * size * 0.4;
  const py = ux * size * 0.4;
  const bx = s.x2 - ux * size;
  const by = s.y2 - uy * size;
  return [
    [s.x2, s.y2],
    [bx + px, by + py],
    [bx - px, by - py],
  ];
}

/** Axis-aligned bounds, used by the selection box and the transform helpers. */
export function shapeBounds(s: Shape): { x: number; y: number; w: number; h: number } {
  switch (s.kind) {
    case "path": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < s.pts.length; i += 2) {
        minX = Math.min(minX, s.pts[i]);
        maxX = Math.max(maxX, s.pts[i]);
        minY = Math.min(minY, s.pts[i + 1]);
        maxY = Math.max(maxY, s.pts[i + 1]);
      }
      if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case "rect":
    case "triangle":
      return { x: s.x, y: s.y, w: s.w, h: s.h };
    case "ellipse":
      return { x: s.cx - s.rx, y: s.cy - s.ry, w: s.rx * 2, h: s.ry * 2 };
    case "arrow":
      return {
        x: Math.min(s.x1, s.x2),
        y: Math.min(s.y1, s.y2),
        w: Math.abs(s.x2 - s.x1),
        h: Math.abs(s.y2 - s.y1),
      };
    case "text":
      return { x: s.x, y: s.y - s.th * 0.8, w: s.tw, h: s.th };
  }
}

/** Move a shape by (dx,dy). Returns a new shape; never mutates. */
export function translateShape<T extends Shape>(s: T, dx: number, dy: number): T {
  switch (s.kind) {
    case "path":
      return { ...s, pts: s.pts.map((v, i) => quant(i % 2 === 0 ? v + dx : v + dy)) };
    case "rect":
    case "triangle":
      return { ...s, x: quant(s.x + dx), y: quant(s.y + dy) };
    case "ellipse":
      return { ...s, cx: quant(s.cx + dx), cy: quant(s.cy + dy) };
    case "arrow":
      return {
        ...s,
        x1: quant(s.x1 + dx),
        y1: quant(s.y1 + dy),
        x2: quant(s.x2 + dx),
        y2: quant(s.y2 + dy),
      };
    case "text":
      return { ...s, x: quant(s.x + dx), y: quant(s.y + dy) };
  }
}

/** Scale a shape about (ox,oy). Text scales its font size by the mean factor,
 *  keeping its measured box in step so hit-testing stays right. */
export function scaleShape<T extends Shape>(s: T, ox: number, oy: number, fx: number, fy: number): T {
  const sx = (v: number) => quant(ox + (v - ox) * fx);
  const sy = (v: number) => quant(oy + (v - oy) * fy);
  switch (s.kind) {
    case "path":
      return { ...s, pts: s.pts.map((v, i) => (i % 2 === 0 ? sx(v) : sy(v))) };
    case "rect":
    case "triangle":
      return { ...s, x: sx(s.x), y: sy(s.y), w: quant(s.w * fx), h: quant(s.h * fy) };
    case "ellipse":
      return { ...s, cx: sx(s.cx), cy: sy(s.cy), rx: quant(s.rx * fx), ry: quant(s.ry * fy) };
    case "arrow":
      return { ...s, x1: sx(s.x1), y1: sy(s.y1), x2: sx(s.x2), y2: sy(s.y2) };
    case "text": {
      const f = (fx + fy) / 2;
      return {
        ...s,
        x: sx(s.x),
        y: sy(s.y),
        size: quant(Math.max(4, s.size * f)),
        tw: quant(s.tw * f),
        th: quant(s.th * f),
      };
    }
  }
}

function distToSeg(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function pointInPoly(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPoly(px: number, py: number, poly: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, distToSeg(px, py, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  }
  return best;
}

/** Distance from a point to a shape's painted area: 0 anywhere inside a filled
 *  shape or a text box, otherwise the distance to the outline. */
export function distToShape(s: Shape, px: number, py: number): number {
  // Truthy, not `!== null`: a shape from an older peer (or a partial object) has
  // `fill` undefined, which must read as unfilled rather than as a solid hit box.
  const filled = canFill(s.kind) && !!s.fill;
  switch (s.kind) {
    case "path": {
      const n = s.pts.length >> 1;
      if (n === 0) return Infinity;
      if (n === 1) return Math.hypot(px - s.pts[0], py - s.pts[1]);
      let best = Infinity;
      for (let i = 0; i < n - 1; i++) {
        const d = distToSeg(px, py, s.pts[i * 2], s.pts[i * 2 + 1], s.pts[i * 2 + 2], s.pts[i * 2 + 3]);
        if (d < best) {
          best = d;
          if (best === 0) break;
        }
      }
      return best;
    }
    case "rect": {
      const x1 = s.x;
      const y1 = s.y;
      const x2 = s.x + s.w;
      const y2 = s.y + s.h;
      if (filled && px >= x1 && px <= x2 && py >= y1 && py <= y2) return 0;
      return Math.min(
        distToSeg(px, py, x1, y1, x2, y1),
        distToSeg(px, py, x2, y1, x2, y2),
        distToSeg(px, py, x2, y2, x1, y2),
        distToSeg(px, py, x1, y2, x1, y1),
      );
    }
    case "triangle": {
      const poly = trianglePoints(s);
      if (filled && pointInPoly(px, py, poly)) return 0;
      return distToPoly(px, py, poly);
    }
    case "ellipse": {
      // Radial approximation. The exact nearest point on an ellipse needs Newton
      // iteration, which is not worth it against an eraser tolerance of sw/2 + radius.
      const dx = (px - s.cx) / (s.rx || 1e-6);
      const dy = (py - s.cy) / (s.ry || 1e-6);
      const k = Math.hypot(dx, dy);
      if (filled && k <= 1) return 0;
      if (k === 0) return Math.min(s.rx, s.ry);
      return Math.abs(k - 1) * Math.min(s.rx, s.ry);
    }
    case "arrow":
      return Math.min(
        distToSeg(px, py, s.x1, s.y1, s.x2, s.y2),
        distToPoly(px, py, arrowHead(s)),
      );
    case "text": {
      const x1 = s.x;
      const y1 = s.y - s.th * 0.8;
      const x2 = s.x + s.tw;
      const y2 = s.y + s.th * 0.25;
      const ox = Math.max(x1 - px, 0, px - x2);
      const oy = Math.max(y1 - py, 0, py - y2);
      return Math.hypot(ox, oy);
    }
  }
}

/** Topmost shape within `radius` of (x,y), or null. `shapes` must be z-sorted
 *  ascending — we walk backwards so the visually topmost wins.
 *
 *  Deliberately not `document.elementFromPoint`: that returns whatever is topmost
 *  including overlays, can't express an eraser radius (thin strokes become nearly
 *  unhittable), forces a layout flush per pointermove, and isn't testable. */
export function hitTest(shapes: Shape[], x: number, y: number, radius: number): string | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    const tol = (s.kind === "text" ? 0 : s.sw / 2) + radius;
    if (distToShape(s, x, y) <= tol) return s.id;
  }
  return null;
}

// ── validation (untrusted wire + untrusted stored doc) ────────────────────────
// Every inbound payload is rebuilt field by field, never spread: `pts` goes
// straight into an SVG `d` attribute and `text` into an SVG text node, so a
// non-finite number or an unescaped string is a real correctness/injection issue.

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Allow modest overdraw outside the board, reject NaN/Infinity/1e300. */
const COORD_MIN = -BOARD_W;
const COORD_MAX = 2 * BOARD_W;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= COORD_MIN && v <= COORD_MAX ? v : null;
}
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function color(v: unknown): string | null {
  return typeof v === "string" && COLOR_RE.test(v) ? v : null;
}

export function validateShape(x: unknown, caps: SketchCaps): Shape | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const id = str(o.id, 64);
  const author = typeof o.author === "string" ? o.author.slice(0, 64) : "";
  const createdAt = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : null;
  const c = color(o.color);
  const sw = typeof o.sw === "number" && Number.isFinite(o.sw) && o.sw >= 0.5 && o.sw <= 64 ? o.sw : null;
  if (!id || createdAt === null || !c || sw === null) return null;
  // Tolerate older peers that predate updatedAt/opacity/fill.
  const updatedAt =
    typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : createdAt;
  const opacity =
    typeof o.opacity === "number" && Number.isFinite(o.opacity) && o.opacity > 0 && o.opacity <= 1
      ? o.opacity
      : 1;
  const fill = color(o.fill);
  const base = { id, author, createdAt, updatedAt, color: c, sw, opacity, fill };

  switch (o.kind) {
    case "path": {
      if (!Array.isArray(o.pts)) return null;
      const pts = o.pts as unknown[];
      if (pts.length < 2 || pts.length % 2 !== 0) return null;
      if (pts.length > 2 * caps.maxPointsPerStroke) return null;
      const out: number[] = [];
      for (const p of pts) {
        const n = num(p);
        if (n === null) return null;
        out.push(n);
      }
      return { ...base, kind: "path", pts: out };
    }
    case "rect":
    case "triangle": {
      const x0 = num(o.x);
      const y0 = num(o.y);
      const w = num(o.w);
      const h = num(o.h);
      if (x0 === null || y0 === null || w === null || h === null || w < 0 || h < 0) return null;
      return { ...base, kind: o.kind, x: x0, y: y0, w, h } as Shape;
    }
    case "ellipse": {
      const cx = num(o.cx);
      const cy = num(o.cy);
      const rx = num(o.rx);
      const ry = num(o.ry);
      if (cx === null || cy === null || rx === null || ry === null || rx < 0 || ry < 0) return null;
      return { ...base, kind: "ellipse", cx, cy, rx, ry };
    }
    case "arrow": {
      const x1 = num(o.x1);
      const y1 = num(o.y1);
      const x2 = num(o.x2);
      const y2 = num(o.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return { ...base, kind: "arrow", x1, y1, x2, y2 };
    }
    case "text": {
      const x0 = num(o.x);
      const y0 = num(o.y);
      const size = num(o.size);
      const tw = num(o.tw);
      const th = num(o.th);
      if (x0 === null || y0 === null || size === null || tw === null || th === null) return null;
      if (typeof o.text !== "string" || o.text.length === 0) return null;
      return {
        ...base,
        kind: "text",
        x: x0,
        y: y0,
        text: o.text.slice(0, caps.maxTextLen),
        size,
        tw,
        th,
      };
    }
    default:
      return null;
  }
}

export interface StrokeDeltaWire {
  roomSlug: string;
  v: 1;
  strokeId: string;
  /** Index of the first point in this batch, counted in POINTS not floats. */
  from: number;
  pts: number[];
  color: string;
  sw: number;
  opacity: number;
  fromName: string;
  fromDevice: string;
}

export function validateStrokeDelta(x: unknown, caps: SketchCaps): StrokeDeltaWire | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const strokeId = str(o.strokeId, 64);
  const roomSlug = str(o.roomSlug, 128);
  const c = color(o.color);
  const sw = typeof o.sw === "number" && Number.isFinite(o.sw) && o.sw >= 0.5 && o.sw <= 64 ? o.sw : null;
  const from =
    typeof o.from === "number" && Number.isInteger(o.from) && o.from >= 0 && o.from <= caps.maxPointsPerStroke
      ? o.from
      : null;
  if (!strokeId || !roomSlug || !c || sw === null || from === null) return null;
  if (!Array.isArray(o.pts)) return null;
  const raw = o.pts as unknown[];
  if (raw.length === 0 || raw.length % 2 !== 0 || raw.length > 2 * caps.maxPointsPerStroke) return null;
  const pts: number[] = [];
  for (const p of raw) {
    const n = num(p);
    if (n === null) return null;
    pts.push(n);
  }
  return {
    roomSlug,
    v: SKETCH_WIRE_V,
    strokeId,
    from,
    pts,
    color: c,
    sw,
    opacity:
      typeof o.opacity === "number" && Number.isFinite(o.opacity) && o.opacity > 0 && o.opacity <= 1
        ? o.opacity
        : 1,
    fromName: typeof o.fromName === "string" ? o.fromName.slice(0, 128) : "",
    fromDevice: typeof o.fromDevice === "string" ? o.fromDevice.slice(0, 64) : "",
  };
}

export function validateSnapshot(x: unknown, caps: SketchCaps): SnapshotWire | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const roomSlug = str(o.roomSlug, 128);
  if (!roomSlug) return null;
  if (!Array.isArray(o.shapes) || !Array.isArray(o.tombs)) return null;
  if (o.shapes.length > caps.maxShapes) return null;

  const shapes: Shape[] = [];
  for (const s of o.shapes) {
    const v = validateShape(s, caps);
    if (v) shapes.push(v); // skip bad entries rather than dropping the whole snapshot
  }
  const tombs: [string, number][] = [];
  for (const t of o.tombs as unknown[]) {
    if (!Array.isArray(t) || t.length !== 2) continue;
    const id = str(t[0], 64);
    const at = typeof t[1] === "number" && Number.isFinite(t[1]) ? t[1] : null;
    if (id && at !== null) tombs.push([id, at]);
  }
  const clearedAt = typeof o.clearedAt === "number" && Number.isFinite(o.clearedAt) ? o.clearedAt : 0;
  return {
    roomSlug,
    v: SKETCH_WIRE_V,
    shapes,
    tombs,
    clearedAt,
    truncated: o.truncated === true,
    fromName: typeof o.fromName === "string" ? o.fromName.slice(0, 128) : "",
    fromDevice: typeof o.fromDevice === "string" ? o.fromDevice.slice(0, 64) : "",
  };
}

/** Re-validate a doc loaded from the encrypted store. A corrupted or tampered kv
 *  entry must not poison the renderer any more than a wire message may. */
export function validateDoc(x: unknown, caps: SketchCaps): SketchDoc | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.shapes)) return null;
  const doc = emptyDoc();
  doc.clearedAt = typeof o.clearedAt === "number" && Number.isFinite(o.clearedAt) ? o.clearedAt : 0;
  if (o.tombstones && typeof o.tombstones === "object") {
    for (const [id, at] of Object.entries(o.tombstones as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) doc.tombstones[id] = at;
    }
  }
  for (const s of o.shapes) {
    const v = validateShape(s, caps);
    if (!v || v.createdAt <= doc.clearedAt) continue;
    const tomb = doc.tombstones[v.id];
    if (tomb !== undefined && v.updatedAt <= tomb) continue;
    doc.shapes.push(v);
  }
  doc.shapes.sort(compareShapes);
  return doc;
}

// ── SVG export ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function polyPoints(pts: [number, number][]): string {
  return pts.map(([x, y]) => `${x},${y}`).join(" ");
}

/** One shape as an SVG fragment. Shared by the exporter; the live canvas renders
 *  the same geometry through Vue so the two can't drift on shape maths. */
export function shapeToSvg(s: Shape): string {
  const fill = canFill(s.kind) && s.fill ? esc(s.fill) : "none";
  const common = `stroke="${esc(s.color)}" stroke-width="${s.sw}" opacity="${s.opacity}"`;
  switch (s.kind) {
    case "path":
      return `<path d="${pathD(s.pts)}" fill="none" ${common} stroke-linecap="round" stroke-linejoin="round"/>`;
    case "rect":
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${fill}" ${common}/>`;
    case "ellipse":
      return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" fill="${fill}" ${common}/>`;
    case "triangle":
      return `<polygon points="${polyPoints(trianglePoints(s))}" fill="${fill}" ${common} stroke-linejoin="round"/>`;
    case "arrow":
      return (
        `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" ${common} stroke-linecap="round"/>` +
        `<polygon points="${polyPoints(arrowHead(s))}" fill="${esc(s.color)}" opacity="${s.opacity}"/>`
      );
    case "text":
      return `<text x="${s.x}" y="${s.y}" fill="${esc(s.color)}" opacity="${s.opacity}" font-size="${s.size}" font-family="${esc(SVG_FONT_STACK)}">${esc(s.text)}</text>`;
  }
}

/** Serialize the document to a standalone SVG.
 *
 *  From the model, not the live DOM: the DOM also holds in-progress stroke
 *  overlays, selection handles, the eraser cursor, Vue's scoping attributes and
 *  Tailwind classes — and export has to work regardless of whether the canvas is
 *  mounted. */
export function toSvg(doc: SketchDoc, opts: { background?: string } = {}): string {
  const bg = opts.background ?? "#ffffff";
  const body = liveShapes(doc).map(shapeToSvg).join("\n  ");
  // width/height are required, not decorative: an SVG with no intrinsic size
  // renders at 0x0 when loaded as an image in WebKit.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_W}" height="${BOARD_H}" viewBox="0 0 ${BOARD_W} ${BOARD_H}">
  <rect width="${BOARD_W}" height="${BOARD_H}" fill="${esc(bg)}"/>
  ${body}
</svg>`;
}
