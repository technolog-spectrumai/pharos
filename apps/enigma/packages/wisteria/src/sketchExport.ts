// Sketch export and image import — everything that needs a canvas, the DOM, or
// Tauri. Kept out of sketchModel.ts so that stays a pure, testable module.

// How a file reaches the disk is the APP's business, not this engine's, and
// the two consumers genuinely differ: zinnia has `@tauri-apps/plugin-fs`,
// enigma has no such plugin and writes through its own Rust command. Injected
// rather than imported, the same way `petalite/files` takes a seal probe.
export type WriteFile = (path: string, bytes: Uint8Array) => Promise<void>;

let writeFileImpl: WriteFile | null = null;

/** Install the app's file writer. Called once, at startup. */
export function setWriteFile(fn: WriteFile | null) {
  writeFileImpl = fn;
}
import {
  arrowHead,
  BOARD_H,
  BOARD_W,
  boardWidth,
  canFill,
  pathD,
  shapePivot,
  SVG_FONT_STACK,
  trianglePoints,
  validateBackgroundImage,
  type SketchDoc,
} from "./sketchModel";

/** Decode a data URL into an <img> that is ready to draw. */
async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = dataUrl;
  // decode() rejects on a malformed payload instead of leaving a 0x0 image, which
  // would otherwise rasterize as a silent no-op. Its DOMException text is
  // browser-specific English, so normalise it to a code the UI can translate.
  try {
    await img.decode();
  } catch {
    throw new Error("not-an-image");
  }
  return img;
}

/** Past this many data-URL characters a photographic PNG is worth re-encoding —
 *  but only when it has no transparency to lose. */
const PNG_SIZE_LIMIT = 1_500_000;

/** True when any pixel is not fully opaque. One pass over the alpha bytes of a
 *  board-sized bitmap, run once per import. */
function hasTransparency(ctx: CanvasRenderingContext2D): boolean {
  const { data } = ctx.getImageData(0, 0, BOARD_W, BOARD_H);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

/** Crop-to-fill an arbitrary image onto the board and re-encode it.
 *
 *  The crop is baked in at import rather than expressed as a fit mode, so the three
 *  renderers (canvas, SVG, PNG) all just draw the result at the full board rect and
 *  cannot disagree about framing. Also bounds what gets stored: whatever the user
 *  picked, what we keep is one board-sized frame. */
export async function prepareBackgroundImage(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = BOARD_W;
  canvas.height = BOARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-unavailable");

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) throw new Error("not-an-image");
  // "cover": scale until both axes are filled, centre, let the overflow fall off.
  const scale = Math.max(BOARD_W / iw, BOARD_H / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(img, (BOARD_W - w) / 2, (BOARD_H - h) / 2, w, h);

  // PNG keeps alpha; JPEG is far smaller but has none, and per the HTML spec a
  // canvas with transparency is composited onto BLACK when serialized to a format
  // without an alpha channel. So the fallback is gated on whether this image
  // actually uses transparency — not on size alone, which was exactly backwards:
  // an alpha channel makes the PNG bigger, so a size-only rule flattened the very
  // images that needed alpha, silently turning transparent regions black.
  const png = canvas.toDataURL("image/png");
  if (png.length <= PNG_SIZE_LIMIT || hasTransparency(ctx)) return png;
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Read a user-picked File into a validated, board-cropped background image. */
export async function backgroundImageFromFile(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsDataURL(file);
  });
  if (!raw.startsWith("data:image/")) throw new Error("not-an-image");
  const prepared = await prepareBackgroundImage(raw);
  if (!validateBackgroundImage(prepared)) throw new Error("prepare-failed");
  return prepared;
}

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

/** Save the board as a .png. Returns false if the user cancelled the dialog. */
export async function exportPng(
  doc: SketchDoc,
  defaultName: string,
  image?: string | null,
  width?: number | null,
  height?: number | null,
): Promise<boolean> {
  const dataUrl = await rasterize(doc, image, 1, width, height);
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
  if (!writeFileImpl) throw new Error("no writer installed — call setWriteFile at startup");
  const b64 = stripDataUrl(dataUrl);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await writeFileImpl(path, bytes);
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
export async function rasterize(
  doc: SketchDoc,
  image?: string | null,
  scale = 1,
  width?: number | null,
  height?: number | null,
): Promise<string> {
  // The open FILE's dimensions. The old board was a fixed-1080-tall sheet sized
  // to the window; a document carries its own viewBox, so both axes come in.
  const boardW = boardWidth(width);
  const boardH = height && height > 0 ? height : BOARD_H;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(boardW * scale);
  canvas.height = Math.round(boardH * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");

  ctx.scale(scale, scale);
  // A fresh canvas is already transparent, so a null background means painting
  // nothing here — PNG keeps its alpha channel and matches the SVG, which omits
  // its background rect in the same case.
  if (doc.background) {
    ctx.fillStyle = doc.background;
    ctx.fillRect(0, 0, boardW, boardH);
  }
  // Cropped to the DEFAULT board at import, so on an elastic board its aspect no
  // longer matches the rect. Cover-crop it here — the same thing the SVG's
  // preserveAspectRatio="xMidYMid slice" does — so the two renderers still agree
  // and neither stretches it. Over the colour, under every shape.
  const bgImage = validateBackgroundImage(image);
  if (bgImage) {
    const img = await loadImage(bgImage);
    const iw = img.naturalWidth || boardW;
    const ih = img.naturalHeight || boardH;
    const cover = Math.max(boardW / iw, boardH / ih);
    const dw = iw * cover;
    const dh = ih * cover;
    ctx.drawImage(img, (boardW - dw) / 2, (boardH - dh) / 2, dw, dh);
  }
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
        if (s.head === false) break;   // a line has no head to fill
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
