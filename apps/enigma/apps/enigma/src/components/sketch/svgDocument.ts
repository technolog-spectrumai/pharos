// A .svg file as the editor sees it: a MIXED document.
//
// The editor understands six shape kinds. A real .svg from Inkscape, Illustrator
// or a design tool contains far more — gradients, filters, groups, nested
// transforms, text on a path. Rewriting such a file from our model would silently
// throw all of that away, so an opened document keeps two kinds of node in ONE
// ordered list:
//
//   { kind: "shape"  } — recognised, editable, re-emitted from the model
//   { kind: "opaque" } — anything else, re-emitted EXACTLY as it came in
//
// The list is the paint order, so z-order survives a round trip even when an
// editable rect sits between two things we cannot touch. Root attributes,
// namespace declarations and <defs> are copied verbatim and never regenerated.
//
// SECURITY: this is the app's first untrusted-file reader. `parseSvgDocument`
// REFUSES a file carrying active content rather than stripping it — stripping
// would mean the user sees one thing, saves another, and destroys markup they
// never agreed to lose. The caller offers the plain XML editor instead. Opaque
// nodes are handed back as parsed DOM, never as strings, so nothing downstream
// is tempted to reach for innerHTML.

import {
  BOARD_H,
  BOARD_W,
  DEFAULT_CAPS,
  HINT_BG,
  HINT_KIND,
  HINT_PTS,
  MAX_BOARD_W,
  shapeToSvg,
  validateShape,
  type Shape,
  type SketchCaps,
} from "./sketchModel";

export type SvgNode =
  | { kind: "shape"; shape: Shape }
  | { kind: "opaque"; el: Element };

export interface SvgDocument {
  /** Verbatim root attributes — viewBox, xmlns, width/height, and anything else
   *  the authoring tool put there. Copied, never regenerated. */
  rootAttrs: Record<string, string>;
  /** Non-drawable prologue (<defs>, <style>, <title>, <metadata>, comments). */
  prologue: Element[];
  /** Document order IS paint order. */
  nodes: SvgNode[];
  width: number;
  height: number;
  /** Our own background rect, when the file has one. */
  background: string | null;
}

/** Why a file was refused. The caller turns this into a message + the XML offer. */
export type ParseRefusal =
  | "not-svg"
  | "active-content"
  | "external-reference"
  | "doctype";

export type ParseResult =
  | { ok: true; doc: SvgDocument; opaqueCount: number }
  | { ok: false; reason: ParseRefusal; detail: string };

/** Measures a string at a font size, in board units. `text` shapes store their
 *  box (`tw`/`th`) because hit-testing and export must not need font metrics —
 *  an imported <text> has none, so the caller injects a measurer. */
export type MeasureText = (text: string, size: number) => { w: number; h: number };

// ── refusal rules ────────────────────────────────────────────────────────────

/** Elements that execute or embed a foreign document. */
const ACTIVE_TAGS = new Set(["script", "foreignobject", "use", "animate", "set"]);
/** A reference we are willing to resolve: same-document, or an inline raster. */
const SAFE_HREF = /^(#|data:image\/(png|jpeg|webp);base64,)/i;

function findActive(root: Element): { reason: ParseRefusal; detail: string } | null {
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (ACTIVE_TAGS.has(tag)) {
      return { reason: "active-content", detail: `<${tag}>` };
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      // Event handlers run as soon as the node is live in the document.
      if (name.startsWith("on")) {
        return { reason: "active-content", detail: `${tag}[${attr.name}]` };
      }
      // url() in a style can pull a remote resource — an "offline" app must not.
      if (name === "style" && /url\s*\(/i.test(attr.value)) {
        return { reason: "external-reference", detail: `${tag}[style=url()]` };
      }
      if ((name === "href" || name === "xlink:href") && !SAFE_HREF.test(attr.value.trim())) {
        return { reason: "external-reference", detail: `${tag}[${attr.name}]` };
      }
    }
  }
  return null;
}

// ── attribute helpers ────────────────────────────────────────────────────────

/** A finite user-space number. Rejects percentages and physical units outright —
 *  the model has no way to represent them, so such a node stays opaque. */
function n(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null) return null;
  const t = raw.trim();
  if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function str(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  return v === null ? null : v.trim();
}

/** Exactly one `rotate(a cx cy)` — the only transform the model can express.
 *  Anything else (translate/scale/matrix/skew, or a list) leaves the node opaque. */
function rotationOf(el: Element): number | null | "unsupported" {
  const t = str(el, "transform");
  if (!t) return null;
  const m = /^rotate\(\s*([-+.\deE]+)[\s,]+([-+.\deE]+)[\s,]+([-+.\deE]+)\s*\)$/.exec(t);
  if (!m) return "unsupported";
  const deg = Number(m[1]);
  return Number.isFinite(deg) ? deg : "unsupported";
}

function commonAttrs(el: Element): { color: string; sw: number; opacity: number; fill: string | null } | null {
  // A `style` attribute would override the presentation attributes we read, so a
  // node carrying one is not faithfully representable — the caller keeps it opaque.
  if (el.hasAttribute("style")) return null;
  const color = str(el, "stroke") ?? "#000000";
  const sw = n(el, "stroke-width") ?? 1;
  const opacity = n(el, "opacity") ?? 1;
  const rawFill = str(el, "fill");
  const fill = !rawFill || rawFill === "none" ? null : rawFill;
  return { color, sw, opacity, fill };
}

function numberList(raw: string): number[] {
  return raw
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
}

// ── element → shape ──────────────────────────────────────────────────────────

/** Try to read one element as an editable shape. `null` ⇒ keep it opaque.
 *  Everything returned here still goes through `validateShape`, because an
 *  opened file is untrusted input just like a stored document. */
function toShape(el: Element, caps: SketchCaps, measure: MeasureText): Shape | null {
  const tag = el.tagName.toLowerCase();
  const rot = rotationOf(el);
  if (rot === "unsupported") return null;
  const base = commonAttrs(el);
  if (!base) return null;
  const common = { id: crypto.randomUUID(), rot: rot ?? 0, ...base };

  const draft = (() => {
    switch (tag) {
      case "rect": {
        // Our own background rect is a document property, not a shape.
        if (el.hasAttribute(HINT_BG)) return null;
        const x = n(el, "x") ?? 0, y = n(el, "y") ?? 0;
        const w = n(el, "width"), h = n(el, "height");
        if (w === null || h === null) return null;
        // Rounded rects are a different primitive; the model has no rx/ry.
        if (el.hasAttribute("rx") || el.hasAttribute("ry")) return null;
        return { ...common, kind: "rect", x, y, w, h };
      }
      case "ellipse": {
        const cx = n(el, "cx") ?? 0, cy = n(el, "cy") ?? 0;
        const rx = n(el, "rx"), ry = n(el, "ry");
        if (rx === null || ry === null) return null;
        return { ...common, kind: "ellipse", cx, cy, rx, ry };
      }
      case "circle": {
        const cx = n(el, "cx") ?? 0, cy = n(el, "cy") ?? 0;
        const r = n(el, "r");
        if (r === null) return null;
        return { ...common, kind: "ellipse", cx, cy, rx: r, ry: r };
      }
      case "line": {
        // No `line` kind exists — an arrow whose head is degenerate is the
        // closest faithful representation, and it stays editable.
        const x1 = n(el, "x1") ?? 0, y1 = n(el, "y1") ?? 0;
        const x2 = n(el, "x2"), y2 = n(el, "y2");
        if (x2 === null || y2 === null) return null;
        return { ...common, kind: "arrow", x1, y1, x2, y2 };
      }
      case "polygon": {
        // Only OUR triangles: an arbitrary 3-point polygon is not necessarily
        // the isoceles-inscribed shape the model would render back.
        if (el.getAttribute(HINT_KIND) !== "triangle") return null;
        const pts = numberList((str(el, "points") ?? "").replace(/,/g, " "));
        if (pts.length !== 6 || pts.some((v) => !Number.isFinite(v))) return null;
        // apex-top-centre, base along the bottom → x/y/w/h
        const xs = [pts[0], pts[2], pts[4]], ys = [pts[1], pts[3], pts[5]];
        const x = Math.min(...xs), y = Math.min(...ys);
        return { ...common, kind: "triangle", x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
      case "path": {
        // The `d` we write is a SMOOTHED quadratic with no inverse, so a path is
        // only editable when it carries the samples we stored alongside it.
        const raw = str(el, HINT_PTS);
        if (!raw) return null;
        const pts = numberList(raw);
        if (pts.length < 2 || pts.length % 2 !== 0 || pts.some((v) => !Number.isFinite(v))) return null;
        return { ...common, kind: "path", pts };
      }
      case "text": {
        if (el.children.length > 0) return null; // <tspan> etc.
        const x = n(el, "x") ?? 0, y = n(el, "y") ?? 0;
        const size = n(el, "font-size");
        const text = el.textContent ?? "";
        if (size === null || !text) return null;
        // `fill` is the text colour; stroke is not how the model draws text.
        const color = str(el, "fill") ?? "#000000";
        const box = measure(text, size);
        return { ...common, color, fill: null, kind: "text", x, y, text, size, tw: box.w, th: box.h };
      }
      case "g": {
        // The only group we emit is an arrow (shaft + head, one composite).
        if (el.getAttribute(HINT_KIND) !== "arrow") return null;
        const line = el.querySelector("line");
        if (!line) return null;
        const x1 = n(line, "x1") ?? 0, y1 = n(line, "y1") ?? 0;
        const x2 = n(line, "x2"), y2 = n(line, "y2");
        if (x2 === null || y2 === null) return null;
        return {
          ...common,
          kind: "arrow",
          color: str(line, "stroke") ?? common.color,
          sw: n(line, "stroke-width") ?? common.sw,
          x1, y1, x2, y2,
        };
      }
      default:
        return null;
    }
  })();

  return draft ? validateShape(draft, caps) : null;
}

// ── parse ────────────────────────────────────────────────────────────────────

const DRAWABLE = new Set(["rect", "ellipse", "circle", "line", "polygon", "polyline", "path", "text", "g", "image"]);

export function parseSvgDocument(
  text: string,
  measure: MeasureText,
  caps: SketchCaps = DEFAULT_CAPS,
): ParseResult {
  // Entity expansion (billion laughs) is a parser-level denial of service, and a
  // DOCTYPE has no legitimate place in a file this editor writes.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    return { ok: false, reason: "doctype", detail: "<!DOCTYPE>" };
  }

  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) {
    return { ok: false, reason: "not-svg", detail: "not a valid SVG document" };
  }

  const active = findActive(root);
  if (active) return { ok: false, reason: active.reason, detail: active.detail };

  const rootAttrs: Record<string, string> = {};
  for (const a of Array.from(root.attributes)) rootAttrs[a.name] = a.value;

  const { width, height } = geometryOf(rootAttrs);

  const prologue: Element[] = [];
  const nodes: SvgNode[] = [];
  let background: string | null = null;
  let opaqueCount = 0;

  for (const el of Array.from(root.children)) {
    const tag = el.tagName.toLowerCase();
    if (!DRAWABLE.has(tag)) {
      // <defs>, <style>, <title>, <metadata>… — kept, never touched.
      prologue.push(el);
      continue;
    }
    if (tag === "rect" && el.hasAttribute(HINT_BG)) {
      background = str(el, "fill");
      continue;
    }
    const shape = toShape(el, caps, measure);
    if (shape) {
      nodes.push({ kind: "shape", shape });
    } else {
      nodes.push({ kind: "opaque", el });
      opaqueCount++;
    }
  }

  return { ok: true, doc: { rootAttrs, prologue, nodes, width, height, background }, opaqueCount };
}

/** Board size: the viewBox wins, then width/height, then the classic board.
 *  Clamped like any untrusted coordinate — a file claiming a 10-million-unit
 *  canvas must not be able to wedge the renderer. */
function geometryOf(attrs: Record<string, string>): { width: number; height: number } {
  const vb = attrs.viewBox?.trim();
  if (vb) {
    const p = numberList(vb);
    if (p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0) {
      return { width: clampDim(p[2]), height: clampDim(p[3]) };
    }
  }
  const w = Number(attrs.width), h = Number(attrs.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: clampDim(w), height: clampDim(h) };
  }
  return { width: BOARD_W, height: BOARD_H };
}

function clampDim(v: number): number {
  return Math.min(Math.max(Math.round(v), 1), MAX_BOARD_W);
}

// ── serialize ────────────────────────────────────────────────────────────────

/** Rebuild the file. The root keeps the attributes it arrived with, the prologue
 *  and every opaque node are re-emitted exactly, and only our own shapes are
 *  regenerated — so editing one rect in a 400-element drawing rewrites one line. */
export function serializeSvgDocument(doc: SvgDocument): string {
  const attrs = Object.entries(doc.rootAttrs)
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(" ");
  const head = doc.prologue.map((el) => "  " + serializeElement(el)).join("\n");
  const bg = doc.background
    ? `  <rect ${HINT_BG}="1" width="${doc.width}" height="${doc.height}" fill="${escapeAttr(doc.background)}"/>`
    : "";
  const body = doc.nodes.map((node) =>
    "  " + (node.kind === "shape" ? shapeToSvg(node.shape) : serializeElement(node.el)),
  );
  const lines = [head, bg, ...body].filter((l) => l !== "");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg ${attrs}>\n${lines.join("\n")}\n</svg>`;
}

function serializeElement(el: Element): string {
  return new XMLSerializer().serializeToString(el);
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The seed for a brand-new drawing. */
export function emptySvgDocument(width = BOARD_W, height = BOARD_H): SvgDocument {
  return {
    rootAttrs: {
      xmlns: "http://www.w3.org/2000/svg",
      width: String(width),
      height: String(height),
      viewBox: `0 0 ${width} ${height}`,
    },
    prologue: [],
    nodes: [],
    width,
    height,
    background: null,
  };
}

/** The editable shapes, in paint order — what the canvas and the model act on. */
export function shapesOf(doc: SvgDocument): Shape[] {
  return doc.nodes.flatMap((n2) => (n2.kind === "shape" ? [n2.shape] : []));
}

/** Replace the editable shapes, keeping every opaque node where it was.
 *  Shapes that survive land in their original slots; extras append at the end
 *  (on top), which is where a newly drawn shape belongs. */
export function withShapes(doc: SvgDocument, shapes: Shape[]): SvgDocument {
  const next: SvgNode[] = [];
  let i = 0;
  for (const node of doc.nodes) {
    if (node.kind === "opaque") {
      next.push(node);
      continue;
    }
    if (i < shapes.length) next.push({ kind: "shape", shape: shapes[i++] });
    // A removed shape simply drops out; opaque neighbours keep their order.
  }
  for (; i < shapes.length; i++) next.push({ kind: "shape", shape: shapes[i] });
  return { ...doc, nodes: next };
}
