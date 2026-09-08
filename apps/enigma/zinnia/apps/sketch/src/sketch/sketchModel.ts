// Sketch board — pure data model + geometry (no Vue/Tauri/DOM imports).
//
// A single local drawing board. The document is a plain ordered list of shapes:
// array order IS paint order, and the last shape drawn is on top. There is no
// conflict resolution because there is nothing to resolve — one user, one board.
//
// (This board was once a per-room collaborative surface backed by an LWW-element-set
// CRDT with a hybrid logical clock, tombstones and a clear register. That machinery
// is parked in `limbo/frontend/sketch-collab/` — see its NOTES.md. Everything here
// that looks conspicuously simple used to be the collaborative version's problem.)
//
// Shapes store raw absolute coordinates per kind, EXCEPT rotation: `rot` is kept as
// an angle and applied at render time. A rotated rect or ellipse cannot be expressed
// in the coordinate schema (`x/y/w/h`, `cx/cy/rx/ry` are axis-aligned by definition),
// so baking rotation into coordinates would silently restrict which shapes can turn.

// ── board space ───────────────────────────────────────────────────────────────
// The board's HEIGHT is fixed and its WIDTH is elastic: the view widens the board
// until it fills its container edge to edge, instead of letterboxing a fixed 16:9
// sheet inside it and wasting the side margins.
//
// Height is what stays fixed because it anchors the unit scale. A stroke width, a
// font size and every coordinate in an already-saved board keep meaning exactly
// what they meant before; a wider window only adds room on the RIGHT, so nothing
// that was drawn before moves or resizes. (Fixing the width instead, and letting
// height float, would rescale every existing drawing on every window.)

/** The board's vertical extent in board units. Fixed — see above. */
export const BOARD_H = 1080;

/** The board's DEFAULT width: a 16:9 board, which is what the board always used to
 *  be. Still the fallback whenever no live width is known — a headless export, a
 *  unit test, or the first frame before the container has been measured. */
export const BOARD_W = 1920;

/** Bounds on the elastic width, so a freak container size cannot produce a board
 *  that is degenerate or absurd. Roughly 1:2 (portrait phone) to 6:1 (a very wide
 *  desktop); COORD_MAX is derived from MAX_BOARD_W so a shape drawn at the right
 *  edge of the widest board still survives validation on the narrowest one. */
export const MIN_BOARD_W = 540;
export const MAX_BOARD_W = 6 * BOARD_H;

/** The board width that fills an element of the given pixel size.
 *
 *  Matching the viewBox aspect to the element's aspect is what removes the
 *  letterbox: `preserveAspectRatio` has nothing left to letterbox once the two
 *  agree. Falls back to the default board for a zero or unmeasured element, which
 *  is what the first frame sees. */
export function boardWidthFor(elW: number, elH: number): number {
  if (!Number.isFinite(elW) || !Number.isFinite(elH) || elW <= 0 || elH <= 0) return BOARD_W;
  const raw = Math.round((BOARD_H * elW) / elH);
  return Math.min(Math.max(raw, MIN_BOARD_W), MAX_BOARD_W);
}

/** Coerce an untrusted or absent width to a usable board width. */
export function boardWidth(w?: number | null): number {
  if (typeof w !== "number" || !Number.isFinite(w)) return BOARD_W;
  return Math.min(Math.max(Math.round(w), MIN_BOARD_W), MAX_BOARD_W);
}

/** Minimum pointer travel (board units) before a freehand sample is kept. Thins a
 *  ~600-sample drag to ~150 with no visible loss. */
export const MIN_POINT_DIST = 1.5;

// ── palette ───────────────────────────────────────────────────────────────────
// The colour row is seven user-assignable SLOTS rather than a fixed list. Slots are
// a per-device tool preference, not part of the document: swapping one must not
// touch the drawing, ride the undo stack, or change what a board looks like when
// it is opened somewhere else. Shape colours are validated by COLOR_RE, never
// against this palette, so a board drawn with colours no longer on the row still
// loads and still exports exactly as it was.
//
// DEFAULT_SLOT_COLORS and EXTRA_COLORS must stay DISJOINT: PICKER_COLORS is the
// concatenation, and a colour appearing in both would render twice in the picker
// (and collide on its v-for key). `palette invariants` in sketchModel.spec.ts
// pins that.

/** The platform's three semantic inks — accent (blue), success (green),
 *  warn (red) — in the same per-mode shades the writer's cy-ink-* classes use.
 *  Two sets because a drawing stores CONCRETE colours: the picker offers the
 *  shade that reads on the CURRENT paper, and the file keeps whichever was
 *  picked. (A theme-relative colour inside an .svg would render differently on
 *  every viewer, which is not what a drawing is.) */
/** Plain ink: black on light paper, white on dark — the writer's rule. */

// Deduplicated: INK_DARK is plain white, which EXTRA_COLORS already offers,
// and the invariant that no colour appears twice is worth keeping — a doubled
// swatch reads as a broken picker.
//
// NOTE this is the FIXED part of the catalogue. Since the system roles became
// user-settable in Settings, the semantic shades a picker offers are whatever
// the user chose, which cannot be known here — see systemShades() in the
// toolbar. This list stays the built-in floor and the defaults' home.

/** The plain inks, offered beside whichever system shades are configured. */

/** Everything in the catalogue that is not a default system shade — the plain
 *  colours. Derived from PICKER_COLORS rather than listed again, so the two
 *  cannot drift. */

/** Hex → i18n leaf key under `sketch.colorNames`. Swatches are bare colour chips
 *  with no text, so this is the only thing that makes them speakable: without it a
 *  screen reader announces the hex, and "#ef4444" reads as "number E F four four
 *  four four" rather than "red". Must cover every PICKER_COLORS entry. */

/** Coerce a stored palette to exactly PALETTE_SLOTS pickable colours.
 *
 *  Falls back PER SLOT rather than discarding the whole array, so a palette that
 *  is short, over-long, or has one unrecognised entry keeps every slot that did
 *  survive instead of resetting the user's other six.
 *
 *  Duplicates are deliberately legal — nothing stops two slots holding the same
 *  colour, and `setSlot` in useSketch.ts depends on that being allowed. The
 *  membership test is case-sensitive: the only writer is `setSlot`, which can only
 *  emit PICKER_COLORS values, so a differently-cased entry can only have come from
 *  a hand-edited kv record and falling back is the safe reading of it. */
/** `#rgb` / `#rrggbb`. Since Settings lets the user define the system roles,
 *  an assignable colour can no longer be checked against a fixed list — a
 *  whitelist would silently refuse the very colours the picker just offered.
 *  The guard that still matters is the one against junk reaching a persisted
 *  palette, and a shape check does that without knowing the catalogue. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isAssignableColor(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}

/** One spelling per colour: lowercase, and shorthand expanded.
 *
 *  Colours are compared as STRINGS all over the picker — the selected ring is
 *  `currentColor === c` — so "#EF4444" and "#ef4444" would be two different
 *  colours that look identical, one of which never highlights its own chip.
 *  The old whitelist got this for free by refusing the odd spelling outright;
 *  that is no longer available now that a colour may be one the user defined,
 *  so the spelling is normalised instead of rejected. */

/** How close the board looks. Display only — see SketchCanvas: zoom resizes the
 *  <svg> element, never the viewBox, so nothing about the saved file changes. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
export const STROKE_SIZES = [2, 4, 8, 16] as const;
export const TEXT_SIZES = [16, 24, 36, 56] as const;
export const OPACITY_STEPS = [0.25, 0.5, 0.75, 1] as const;
/** Shift-drag on the rotate handle snaps to this increment. */
export const ROTATE_SNAP_DEG = 15;

/** Shared by the SVG output and the canvas rasterizer so the two can't drift. */
export const SVG_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ── shapes ────────────────────────────────────────────────────────────────────

export type ShapeKind = "path" | "rect" | "ellipse" | "triangle" | "arrow" | "text";

export interface ShapeBase {
  id: string;
  kind: ShapeKind;
  /** Outline colour (and fill colour for text). */
  color: string;
  /** Stroke width in board units. Named `sw` because `rect` already uses `w`. */
  sw: number;
  /** 0..1, applied to the whole shape. */
  opacity: number;
  /** Interior fill, or null for outline-only. Ignored by path/arrow/text. */
  fill: string | null;
  /** Clockwise degrees about the centre of the shape's unrotated bounds. */
  rot: number;
}

export interface PathShape extends ShapeBase {
  kind: "path";
  /** Flat [x0,y0,x1,y1,…] — half the JSON of an array of pairs. */
  pts: number[];
}
/** Rect, triangle and ellipse are box-defined, so create-by-drag and the transform
 *  helpers treat them alike. */
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
  /** Head width as a multiple of `sw`. Absent means DEFAULT_HEAD_WIDTH. */
  headWidth?: number;
  /** Whether to draw the head. A plain line is an arrow without one.
   *
   *  Optional, and absent MEANS TRUE: every arrow written before this existed
   *  has no such field, and they were all headed. A required flag would have
   *  made every one of those documents invalid.
   *
   *  This is why SVG `<line>` survives a round trip. It used to import as an
   *  arrow and export as `<g><line/><polygon/></g>` — so a triangle drawn from
   *  three lines came back as three arrows, permanently, in both editors. */
  head?: boolean;
}
export interface TextShape extends ShapeBase {
  kind: "text";
  /** Baseline start. */
  x: number;
  y: number;
  text: string;
  size: number;
  /** Advance width / line height, measured once at creation. Stored so hit-testing
   *  stays pure — no font metrics needed at erase or export time. */
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

/** The whole board. Array order is paint order. */
export interface SketchDoc {
  v: 1;
  shapes: Shape[];
  /** Board background, or null for transparent — the default. Transparent means
   *  the SVG omits its background rect entirely and the PNG keeps its alpha
   *  channel, so an export drops straight onto whatever it is placed over. */
  background: string | null;
}

export function emptyDoc(): SketchDoc {
  return { v: 1, shapes: [], background: null };
}

/** Offered as board backgrounds: white or near-black, which is what an export
 *  wants when it is not transparent. The other two choices are not colours and so
 *  are not listed here — `null` (transparent, the default) and a background image
 *  both come from their own controls in the toolbar.
 *
 *  Trimming this list does NOT invalidate existing boards: `background` is checked
 *  by COLOR_RE in validateDoc, never against this array, so a board saved with a
 *  colour that used to be offered still loads and exports in that colour. It just
 *  has no swatch highlighted until the user picks a different one. */
export const BACKGROUND_COLORS = ["#ffffff", "#111827"] as const;

/** Upper bound on a stored background image, as data-URL characters (~9 MB of
 *  base64 ≈ 6.7 MB of bytes). Import already crops and re-encodes to board size, so
 *  anything past this is a corrupt or hand-edited entry, not a real photo. */
export const MAX_BG_IMAGE_CHARS = 9_000_000;

/** A background image is a base64 data URL, cropped to the board at import.
 *  Validated on every load because it is written straight into an SVG `href` and a
 *  file on the user's disk: only these raster types, only base64, nothing else. */
const BG_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export function validateBackgroundImage(x: unknown): string | null {
  if (typeof x !== "string" || x.length === 0 || x.length > MAX_BG_IMAGE_CHARS) return null;
  return BG_IMAGE_RE.test(x) ? x : null;
}

/** Caps on an untrusted document. The model takes them as data so it stays pure.
 *
 *  These used to come from a Pro-only `sketch:` build-config section. The editor
 *  now lives inside Files → Local, which ships in EVERY edition, so gating it
 *  would be incoherent — they are plain constants and `DEFAULT_CAPS` is what
 *  every caller passes. They still matter: an opened .svg is untrusted input. */
export interface SketchCaps {
  maxShapes: number;
  maxTextLen: number;
}

export const MAX_SHAPES = 1000;
export const MAX_TEXT_LEN = 200;
export const DEFAULT_CAPS: SketchCaps = { maxShapes: MAX_SHAPES, maxTextLen: MAX_TEXT_LEN };

// ── geometry ──────────────────────────────────────────────────────────────────

/** Quantize to 0.1 board units — meaningful precision at a fraction of the JSON. */
export function quant(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Normalize degrees into [0, 360). */
export function normDeg(deg: number): number {
  const d = deg % 360;
  return quant(d < 0 ? d + 360 : d);
}

/** Freehand path data, quadratic-midpoint smoothed: raw samples become control
 *  points and the on-curve points are the midpoints between them. C1-continuous in
 *  one pass with no lookahead, which also makes it append-safe — extending a stroke
 *  never shifts geometry already drawn. */
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

/** The three corners of a triangle inscribed in its box (unrotated). */
export function trianglePoints(s: TriangleShape): [number, number][] {
  return [
    [s.x + s.w / 2, s.y],
    [s.x + s.w, s.y + s.h],
    [s.x, s.y + s.h],
  ];
}

/** Arrow head as a filled triangle at (x2,y2), unrotated. Head size scales with
 *  stroke width but is capped to the shaft length so a short arrow stays legible. */
export function arrowHead(s: ArrowShape): [number, number][] {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy) || 1;
  const size = Math.min(Math.max(s.sw * 3, 8), len);
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular, half-width of the head. Derived from the STROKE, not from
  // `size`: the width is what the setting controls, and tying it to the length
  // would make the head grow sideways every time it was clamped short on a
  // stubby arrow.
  const half = (s.sw * (s.headWidth ?? DEFAULT_HEAD_WIDTH)) / 2;
  const px = -uy * half;
  const py = ux * half;
  const bx = s.x2 - ux * size;
  const by = s.y2 - uy * size;
  return [
    [s.x2, s.y2],
    [bx + px, by + py],
    [bx - px, by - py],
  ];
}

/** Axis-aligned bounds of the shape's UNROTATED geometry. Also the rotation pivot
 *  (its centre) and the frame the selection box is drawn in — the box is rendered
 *  inside the same rotation transform, so it turns with the shape. */
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

/** Centre of the unrotated bounds — the rotation pivot, shared by every renderer
 *  and by hit-testing so they cannot disagree about where a shape turns. */
export function shapePivot(s: Shape): { cx: number; cy: number } {
  const b = shapeBounds(s);
  return { cx: quant(b.x + b.w / 2), cy: quant(b.y + b.h / 2) };
}

/** An arrow head's full width, as a multiple of the line's thickness.
 *
 *  Was effectively 2.4 (a head 3× the stroke long, 0.4 of that as half-width);
 *  3.6 is that 50% wider, which reads better at the stroke widths people
 *  actually draw with. Width only — the head's LENGTH along the shaft is
 *  unchanged, so an arrow keeps its reach and just gains a broader point. */
export const DEFAULT_HEAD_WIDTH = 3.6;

/** How near the pointer has to be, in board units, for a snap to take. */
export const SNAP_RADIUS = 12;

/** The points a shape offers to snap to: its VERTICES and the CENTRE OF EACH
 *  EDGE, and nothing else.
 *
 *  A finite, nameable set is the whole idea — it is what makes a drawing come
 *  out clean. Snapping to the nearest point anywhere along an edge would be
 *  more powerful and much less predictable, and there would be nothing discrete
 *  to draw as a ring.
 *
 *  Returned in board coordinates with the shape's own rotation already applied,
 *  because a rotated rect's corners are not its unrotated corners and snapping
 *  to where a shape ISN'T is worse than not snapping at all.
 *
 *  Text is deliberately absent: a label has a box but no geometry anyone means
 *  to align to. A freehand path offers only its two ends — every sample point
 *  would be hundreds of targets a millimetre apart. */
export function snapPointsOf(s: Shape): [number, number][] {
  const raw: [number, number][] = (() => {
    switch (s.kind) {
      case "rect": {
        const { x, y, w, h } = s;
        const mx = x + w / 2, my = y + h / 2;
        return [
          [x, y], [x + w, y], [x + w, y + h], [x, y + h],   // corners
          [mx, y], [x + w, my], [mx, y + h], [x, my],       // edge centres
        ];
      }
      case "triangle": {
        const pts = trianglePoints(s);
        const mid: [number, number][] = pts.map((p, i) => {
          const q = pts[(i + 1) % pts.length];
          return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        });
        return [...pts, ...mid];
      }
      case "ellipse":
        // The four quadrant points. A circle has no corners and no edges to
        // halve, so these are the only landmarks on it worth aiming at.
        return [
          [s.cx - s.rx, s.cy], [s.cx + s.rx, s.cy],
          [s.cx, s.cy - s.ry], [s.cx, s.cy + s.ry],
        ];
      case "arrow":
        // Both ends and the middle — the same rule as any other edge, applied
        // to a shape that is one edge. Covers plain lines too (head: false).
        return [
          [s.x1, s.y1], [s.x2, s.y2],
          [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2],
        ];
      case "path": {
        const n = s.pts.length;
        if (n < 2) return [];
        return [[s.pts[0], s.pts[1]], [s.pts[n - 2], s.pts[n - 1]]];
      }
      default:
        return [];
    }
  })();

  if (!s.rot || !raw.length) return raw;
  const { cx, cy } = shapePivot(s);
  return raw.map(([x, y]) => {
    const r = rotatePoint(x, y, cx, cy, s.rot);
    return [r.x, r.y] as [number, number];
  });
}

/** Every snap point on the board. */
export function snapPoints(shapes: Shape[]): [number, number][] {
  return shapes.flatMap(snapPointsOf);
}

/** The nearest snap point within `radius`, or null.
 *
 *  Ties go to the earlier point, which is stable: the caller passes shapes in
 *  document order, so the same cursor position always snaps to the same place
 *  rather than flickering between two coincident corners. */
export function nearestSnap(
  px: number,
  py: number,
  points: [number, number][],
  radius: number = SNAP_RADIUS,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDist = radius;
  for (const [x, y] of points) {
    const d = Math.hypot(x - px, y - py);
    if (d < bestDist) {
      bestDist = d;
      best = { x, y };
    }
  }
  return best;
}

/** Rotate a point about (cx,cy) by `deg` clockwise (SVG's positive direction). */
export function rotatePoint(
  px: number,
  py: number,
  cx: number,
  cy: number,
  deg: number,
): { x: number; y: number } {
  if (!deg) return { x: px, y: py };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** Move a shape by (dx,dy). Returns a new shape; never mutates. Rotation is
 *  unaffected — the pivot travels with the geometry. */
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

/** Scale a shape about (ox,oy) in its UNROTATED frame. Text scales its font size by
 *  the mean factor, keeping its measured box in step so hit-testing stays right. */
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

/** Set a shape's absolute rotation, in degrees. */
export function rotateShape<T extends Shape>(s: T, deg: number): T {
  return { ...s, rot: normDeg(deg) };
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

/** Distance from a point to a shape's painted area, IGNORING rotation — callers go
 *  through `distToShapeRotated`/`hitTest`, which map the point into the shape's
 *  unrotated frame first. Splitting it this way means every kind's geometry math
 *  stays rotation-unaware. */
export function distToShape(s: Shape, px: number, py: number): number {
  // Truthy, not `!== null`: a shape from an older document (or a partial object) has
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
      // iteration, not worth it against an eraser tolerance of sw/2 + radius.
      const dx = (px - s.cx) / (s.rx || 1e-6);
      const dy = (py - s.cy) / (s.ry || 1e-6);
      const k = Math.hypot(dx, dy);
      if (filled && k <= 1) return 0;
      if (k === 0) return Math.min(s.rx, s.ry);
      return Math.abs(k - 1) * Math.min(s.rx, s.ry);
    }
    case "arrow":
      // A headless arrow is just its shaft — measuring to a head that is not
      // drawn would let the eraser and the click test grab empty space.
      if (s.head === false) return distToSeg(px, py, s.x1, s.y1, s.x2, s.y2);
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

/** Distance to a shape as actually painted, rotation included. The point is rotated
 *  by `-rot` about the pivot, which is exactly the inverse of the render transform,
 *  so selection and the eraser agree with what the user sees. */
export function distToShapeRotated(s: Shape, px: number, py: number): number {
  if (!s.rot) return distToShape(s, px, py);
  const { cx, cy } = shapePivot(s);
  const p = rotatePoint(px, py, cx, cy, -s.rot);
  return distToShape(s, p.x, p.y);
}

/** Topmost shape within `radius` of (x,y), or null. Walks backwards because later
 *  array entries paint on top.
 *
 *  Deliberately not `document.elementFromPoint`: that returns whatever is topmost
 *  including overlays, can't express an eraser radius (thin strokes become nearly
 *  unhittable), forces a layout flush per pointermove, and isn't testable. */
export function hitTest(shapes: Shape[], x: number, y: number, radius: number): string | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    const tol = (s.kind === "text" ? 0 : s.sw / 2) + radius;
    if (distToShapeRotated(s, x, y) <= tol) return s.id;
  }
  return null;
}

// ── validation ────────────────────────────────────────────────────────────────
// Only the persisted document is untrusted now (a corrupt or hand-edited kv entry
// must not poison the renderer). Rebuild every field rather than spreading: `pts`
// goes straight into an SVG `d` attribute and `text` into an SVG text node, so a
// non-finite number or an unescaped string is a real correctness/injection issue.

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Allow modest overdraw outside the board, reject NaN/Infinity/1e300.
 *
 *  Keyed to MAX_BOARD_W rather than to the default board: the board is elastic, so
 *  a shape drawn near the right edge on a very wide window must still validate when
 *  the same document is opened on a narrow one. Bounding to the old 2×1920 would
 *  silently DELETE such shapes on load. This is a sanity bound on hostile input,
 *  not a layout constraint, so being generous costs nothing. */
const COORD_MIN = -MAX_BOARD_W;
const COORD_MAX = 2 * MAX_BOARD_W;

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
  const c = color(o.color);
  const sw = typeof o.sw === "number" && Number.isFinite(o.sw) && o.sw >= 0.5 && o.sw <= 64 ? o.sw : null;
  if (!id || !c || sw === null) return null;
  const opacity =
    typeof o.opacity === "number" && Number.isFinite(o.opacity) && o.opacity > 0 && o.opacity <= 1
      ? o.opacity
      : 1;
  const rot = typeof o.rot === "number" && Number.isFinite(o.rot) ? normDeg(o.rot) : 0;
  const base = { id, color: c, sw, opacity, fill: color(o.fill), rot };

  switch (o.kind) {
    case "path": {
      if (!Array.isArray(o.pts)) return null;
      const pts = o.pts as unknown[];
      if (pts.length < 2 || pts.length % 2 !== 0) return null;
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
      // Only ever written when false: absent means headed, which keeps the
      // shape of every document that predates the flag.
      const hw =
        typeof o.headWidth === "number" && Number.isFinite(o.headWidth)
          && o.headWidth >= 0.5 && o.headWidth <= 12
          ? { headWidth: o.headWidth }
          : {};
      return o.head === false
        ? { ...base, kind: "arrow", x1, y1, x2, y2, head: false }
        : { ...base, kind: "arrow", x1, y1, x2, y2, ...hw };
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

/** Re-validate a document loaded from the encrypted store, preserving paint order
 *  and dropping anything malformed. */
export function validateDoc(x: unknown, caps: SketchCaps): SketchDoc | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.shapes)) return null;
  const doc = emptyDoc();
  // Absent or malformed ⇒ transparent, which is also what a pre-background
  // document (saved before this field existed) should become.
  doc.background = color(o.background);
  for (const s of o.shapes) {
    if (doc.shapes.length >= caps.maxShapes) break;
    const v = validateShape(s, caps);
    if (v) doc.shapes.push(v);
  }
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

/** The rotation transform for a shape, or "" when it isn't rotated. Shared by the
 *  exporter and (in spirit) the canvas template. */
export function rotAttr(s: Shape): string {
  if (!s.rot) return "";
  const { cx, cy } = shapePivot(s);
  return ` transform="rotate(${s.rot} ${cx} ${cy})"`;
}

/** Round-trip hints. `toSvg` is otherwise NOT invertible: `pathD` smooths the
 *  samples into a quadratic `d` that cannot be inverted, and a `triangle` looks
 *  exactly like any other 3-point `<polygon>` coming back. Re-parsing without
 *  these would drift a little more on every open/save cycle.
 *
 *  They are plain `data-*` attributes — valid SVG that every other renderer
 *  ignores — so a file we wrote still opens correctly in Inkscape or a browser.
 *  Shapes NOT listed here (`rect`, `ellipse`, `text`) need no hint: every field
 *  is already recoverable from their standard attributes. */
export const HINT_KIND = "data-en-kind";
export const HINT_PTS = "data-en-pts";
export const HINT_BG = "data-en-bg";
export const HINT_BGIMG = "data-en-bgimg";
/** An arrow's head width, as a multiple of its stroke width. Written only when
 *  it differs from the default, so ordinary arrows stay unadorned — but written
 *  when it does, because the head polygon is REGENERATED from the shaft on
 *  open. Without the hint, reopening a drawing would silently re-cut every
 *  arrowhead to whatever the current setting happens to be. */
export const HINT_HEADW = "data-en-headw";

/** One shape as an SVG fragment. */
export function shapeToSvg(s: Shape): string {
  const fill = canFill(s.kind) && s.fill ? esc(s.fill) : "none";
  const common = `stroke="${esc(s.color)}" stroke-width="${s.sw}" opacity="${s.opacity}"`;
  const rot = rotAttr(s);
  switch (s.kind) {
    case "path":
      return `<path d="${pathD(s.pts)}" ${HINT_PTS}="${s.pts.join(" ")}" fill="none" ${common} stroke-linecap="round" stroke-linejoin="round"${rot}/>`;
    case "rect":
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${fill}" ${common}${rot}/>`;
    case "ellipse":
      return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" fill="${fill}" ${common}${rot}/>`;
    case "triangle":
      return `<polygon points="${polyPoints(trianglePoints(s))}" ${HINT_KIND}="triangle" fill="${fill}" ${common} stroke-linejoin="round"${rot}/>`;
    case "arrow":
      // A headless arrow IS a line, and it goes out as one — no group, no
      // hint attribute, nothing to identify it as ours. That is the point:
      // it re-imports as a line anywhere, including in delta's editor and in
      // whatever drew it in the first place.
      if (s.head === false) {
        return (
          `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" ` +
          `stroke="${esc(s.color)}" stroke-width="${s.sw}" ` +
          `stroke-linecap="round" opacity="${s.opacity}"${rot}/>`
        );
      }
      // One group carries both the transform and the opacity, so the shaft and the
      // head turn together AND composite once — putting opacity on each child would
      // darken their overlap, which is not what the board shows.
      return (
        `<g ${HINT_KIND}="arrow"${
          s.headWidth !== undefined && s.headWidth !== DEFAULT_HEAD_WIDTH
            ? ` ${HINT_HEADW}="${s.headWidth}"`
            : ""
        } opacity="${s.opacity}"${rot}>` +
        `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${esc(s.color)}" stroke-width="${s.sw}" stroke-linecap="round"/>` +
        `<polygon points="${polyPoints(arrowHead(s))}" fill="${esc(s.color)}"/>` +
        `</g>`
      );
    case "text":
      return `<text x="${s.x}" y="${s.y}" fill="${esc(s.color)}" opacity="${s.opacity}" font-size="${s.size}" font-family="${esc(SVG_FONT_STACK)}"${rot}>${esc(s.text)}</text>`;
  }
}

/** Serialize the document to a standalone SVG.
 *
 *  From the model, not the live DOM: the DOM also holds the in-progress shape
 *  preview, selection handles, the eraser cursor, Vue's scoping attributes and
 *  Tailwind classes — and export has to work regardless of what is on screen. */
export function toSvg(
  doc: SketchDoc,
  opts: {
    background?: string | null;
    image?: string | null;
    width?: number | null;
    /** Board height. Defaults to BOARD_H — a file-backed document passes its own. */
    height?: number | null;
  } = {},
): string {
  // Defaults to the 16:9 board, so a caller that does not know the live width
  // (a test, a headless export) gets exactly what this function always produced.
  const w = boardWidth(opts.width);
  const h = opts.height && opts.height > 0 ? opts.height : BOARD_H;
  const bg = opts.background !== undefined ? opts.background : doc.background;
  // Transparent means NO background rect at all — an empty or white-filled rect
  // would defeat the point by making the export opaque.
  // The hint separates OUR background from a user-drawn full-bleed rect, which
  // would otherwise be indistinguishable on the way back in.
  const bgRect = bg ? `  <rect ${HINT_BG}="1" width="${w}" height="${h}" fill="${esc(bg)}"/>\n` : "";
  // The image is embedded, not linked, so the .svg stays portable. It is cropped to
  // the DEFAULT board at import, so on an elastic board it no longer matches the
  // rect's aspect — `slice` scales it to cover and crops the overflow, which keeps
  // it undistorted. Stretching it to the rect instead would visibly squash it on
  // any window that is not 16:9.
  const img = validateBackgroundImage(opts.image);
  const bgImage = img
    ? `  <image ${HINT_BGIMG}="1" href="${esc(img)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>\n`
    : "";
  const body = doc.shapes.map(shapeToSvg).join("\n  ");
  // width/height are required, not decorative: an SVG with no intrinsic size
  // renders at 0x0 when loaded as an image in WebKit.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${bgRect}${bgImage}  ${body}
</svg>`;
}
