// Sketch export: a standalone .svg on disk, or a raster posted into the room chat.
// Kept out of sketchModel.ts because this half touches the DOM and Tauri.

import { writeTextFileToDisk } from "rakotis";
import {
  arrowHead,
  BOARD_H,
  BOARD_W,
  canFill,
  liveShapes,
  pathD,
  SVG_FONT_STACK,
  toSvg,
  trianglePoints,
  type SketchDoc,
} from "./sketchModel";

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Save the board as an .svg the user picks in the native dialog. Returns false if
 *  they cancelled. Outside Tauri it falls back to a browser download. */
export async function exportSvg(doc: SketchDoc, defaultName: string): Promise<boolean> {
  const svg = toSvg(doc);
  if (!isTauri()) {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: defaultName, filters: [{ name: "SVG", extensions: ["svg"] }] });
  if (!path) return false;
  await writeTextFileToDisk(path, svg);
  return true;
}

/** Rasterize the board to a PNG data URL.
 *
 *  Drawn directly with Canvas2D from the model rather than by loading the SVG into
 *  an <img>: in a WebKit webview a dimensionless SVG image rasterizes at 0x0, fonts
 *  inside an SVG <img> resolve against a separate context so text can silently
 *  vanish, and canvas-taint rules around SVG images vary enough that toDataURL can
 *  throw. Path geometry comes from the very same `pathD` the SVG uses, so the two
 *  renderers cannot drift on the part that matters. */
export function rasterize(doc: SketchDoc, maxDim = 1600): string {
  const scale = Math.min(1, maxDim / BOARD_W);
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

  for (const s of liveShapes(doc)) {
    ctx.globalAlpha = s.opacity;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.sw;
    const filled = canFill(s.kind) && !!s.fill;
    if (filled) ctx.fillStyle = s.fill as string;

    switch (s.kind) {
      case "path":
        ctx.stroke(new Path2D(pathD(s.pts)));
        break;
      case "rect":
        if (filled) ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.strokeRect(s.x, s.y, s.w, s.h);
        break;
      case "ellipse":
        ctx.beginPath();
        ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
        if (filled) ctx.fill();
        ctx.stroke();
        break;
      case "triangle": {
        const pts = trianglePoints(s);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.lineTo(pts[2][0], pts[2][1]);
        ctx.closePath();
        if (filled) ctx.fill();
        ctx.stroke();
        break;
      }
      case "arrow": {
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        const head = arrowHead(s);
        ctx.beginPath();
        ctx.moveTo(head[0][0], head[0][1]);
        ctx.lineTo(head[1][0], head[1][1]);
        ctx.lineTo(head[2][0], head[2][1]);
        ctx.closePath();
        ctx.fillStyle = s.color;
        ctx.fill();
        break;
      }
      case "text":
        ctx.fillStyle = s.color;
        ctx.font = `${s.size}px ${SVG_FONT_STACK}`;
        ctx.fillText(s.text, s.x, s.y);
        break;
    }
  }
  ctx.globalAlpha = 1;

  let url = canvas.toDataURL("image/png");
  // A dense board can outgrow a comfortable message size; on a white background
  // JPEG loses nothing that matters for a sketch.
  if (url.length > 3_000_000) url = canvas.toDataURL("image/jpeg", 0.85);
  return url;
}
