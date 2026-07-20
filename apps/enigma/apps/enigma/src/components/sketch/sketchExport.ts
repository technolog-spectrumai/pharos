// Sketch export — a standalone .svg or .png on disk. Kept out of sketchModel.ts
// because this half touches the DOM and Tauri.

import { writeBase64FileToDisk, writeTextFileToDisk } from "rakotis";
import {
  arrowHead,
  BOARD_H,
  BOARD_W,
  canFill,
  pathD,
  shapePivot,
  SVG_FONT_STACK,
  toSvg,
  trianglePoints,
  type SketchDoc,
} from "./sketchModel";

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Browser fallback for both formats: a blob download, since there is no dialog. */
function browserDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** `data:image/png;base64,AAAA…` → `AAAA…` */
function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** Save the board as an .svg. Returns false if the user cancelled the dialog. */
export async function exportSvg(doc: SketchDoc, defaultName: string): Promise<boolean> {
  const svg = toSvg(doc);
  if (!isTauri()) {
    browserDownload(new Blob([svg], { type: "image/svg+xml" }), defaultName);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: defaultName, filters: [{ name: "SVG", extensions: ["svg"] }] });
  if (!path) return false;
  await writeTextFileToDisk(path, svg);
  return true;
}

/** Save the board as a .png. Returns false if the user cancelled the dialog. */
export async function exportPng(doc: SketchDoc, defaultName: string): Promise<boolean> {
  const dataUrl = rasterize(doc);
  if (!isTauri()) {
    const bin = atob(stripDataUrl(dataUrl));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    browserDownload(new Blob([bytes], { type: "image/png" }), defaultName);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: defaultName, filters: [{ name: "PNG", extensions: ["png"] }] });
  if (!path) return false;
  await writeBase64FileToDisk(path, stripDataUrl(dataUrl));
  return true;
}

/** Lazily-made scratch layer the size of the output, used to composite a
 *  translucent filled shape in one pass. Reused across shapes; cleared each time. */
let scratch: CanvasRenderingContext2D | null = null;

function scratchCtx(w: number, h: number, scale: number): CanvasRenderingContext2D {
  if (!scratch || scratch.canvas.width !== w || scratch.canvas.height !== h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) throw new Error("Canvas is unavailable.");
    scratch = g;
  }
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.clearRect(0, 0, w, h);
  scratch.scale(scale, scale);
  scratch.lineCap = "round";
  scratch.lineJoin = "round";
  return scratch;
}

/** Rasterize the board to a PNG data URL at full board resolution.
 *
 *  Drawn directly with Canvas2D from the model rather than by loading the SVG into
 *  an <img>: in a WebKit webview a dimensionless SVG image rasterizes at 0x0, fonts
 *  inside an SVG <img> resolve against a separate context so text can silently
 *  vanish, and canvas-taint rules around SVG images vary enough that toDataURL can
 *  throw. Path geometry comes from the very same `pathD` the SVG uses, and rotation
 *  from the same `shapePivot`, so the two renderers cannot drift. */
export function rasterize(doc: SketchDoc, scale = 1): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(BOARD_W * scale);
  canvas.height = Math.round(BOARD_H * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");

  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const s of doc.shapes) {
    const filled = canFill(s.kind) && !!s.fill;
    // SVG's `opacity` composites the whole element once; Canvas2D would apply
    // globalAlpha to the fill and again to the stroke, darkening the band where a
    // thick stroke overlaps its own fill. Paint translucent filled shapes opaquely
    // into a scratch layer and blit that once, which reproduces SVG exactly.
    const layered = s.opacity < 1 && filled;
    const target = layered ? scratchCtx(canvas.width, canvas.height, scale) : ctx;

    target.save();
    // Mirror of the SVG `rotate(deg cx cy)` transform.
    if (s.rot) {
      const { cx, cy } = shapePivot(s);
      target.translate(cx, cy);
      target.rotate((s.rot * Math.PI) / 180);
      target.translate(-cx, -cy);
    }
    target.globalAlpha = layered ? 1 : s.opacity;
    target.strokeStyle = s.color;
    target.lineWidth = s.sw;
    if (filled) target.fillStyle = s.fill as string;

    switch (s.kind) {
      case "path":
        target.stroke(new Path2D(pathD(s.pts)));
        break;
      case "rect":
        // <rect> carries no stroke-linejoin in either other renderer, so its
        // corners are SVG's default miter — don't inherit the global round join.
        target.lineJoin = "miter";
        if (filled) target.fillRect(s.x, s.y, s.w, s.h);
        target.strokeRect(s.x, s.y, s.w, s.h);
        break;
      case "ellipse":
        target.beginPath();
        target.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
        if (filled) target.fill();
        target.stroke();
        break;
      case "triangle": {
        const pts = trianglePoints(s);
        target.beginPath();
        target.moveTo(pts[0][0], pts[0][1]);
        target.lineTo(pts[1][0], pts[1][1]);
        target.lineTo(pts[2][0], pts[2][1]);
        target.closePath();
        if (filled) target.fill();
        target.stroke();
        break;
      }
      case "arrow": {
        target.beginPath();
        target.moveTo(s.x1, s.y1);
        target.lineTo(s.x2, s.y2);
        target.stroke();
        const head = arrowHead(s);
        target.beginPath();
        target.moveTo(head[0][0], head[0][1]);
        target.lineTo(head[1][0], head[1][1]);
        target.lineTo(head[2][0], head[2][1]);
        target.closePath();
        target.fillStyle = s.color;
        target.fill();
        break;
      }
      case "text":
        target.fillStyle = s.color;
        target.font = `${s.size}px ${SVG_FONT_STACK}`;
        target.fillText(s.text, s.x, s.y);
        break;
    }
    target.restore();
    if (layered) {
      // One composite for the whole shape, matching SVG element opacity.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = s.opacity;
      ctx.drawImage(target.canvas, 0, 0);
      ctx.restore();
    }
  }

  return canvas.toDataURL("image/png");
}
