// Make a picture (a screenshot) small enough to send whole: at most
// MAX_IMAGE_BYTES (pharos-wire's cap). WebP where the webview can encode it,
// else JPEG; quality steps down first, then the size, until it fits. A picture
// that is already a small PNG, JPEG or WebP goes as it is.

export const MAX_IMAGE_BYTES = 192 * 1024;
export const SEND_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;
const LONG_SIDE = 1920;
const QUALITIES = [0.86, 0.76, 0.66, 0.56, 0.46];
const MIN_SIDE = 160;

export interface Fitted {
  mime: string;
  blob: Blob;
  width: number;
  height: number;
}

/** Encode `w`×`h` as `mime` at quality `q`; returns what was actually made
 *  (a webview that cannot encode WebP returns a PNG). */
export type Encoder = (w: number, h: number, mime: string, q: number) => Promise<Blob>;

/** The search, apart from any canvas so it can be tested. */
export async function fit(width: number, height: number, encode: Encoder, max = MAX_IMAGE_BYTES): Promise<Fitted> {
  let scale = Math.min(1, LONG_SIDE / Math.max(width, height));
  let mime = "image/webp";
  for (;;) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    let restart = false;
    for (const q of QUALITIES) {
      const blob = await encode(w, h, mime, q);
      if (blob.type !== mime && mime === "image/webp") {
        // This webview cannot encode WebP: JPEG instead, at the same size.
        mime = "image/jpeg";
        restart = true;
        break;
      }
      if (blob.size <= max) return { mime, blob, width: w, height: h };
    }
    if (restart) continue;
    scale *= 0.75;
    if (Math.max(width, height) * scale < MIN_SIDE) throw new Error("too large");
  }
}

/** A picture file or a pasted image, made sendable. */
export async function shrink(file: Blob): Promise<Fitted> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  if (file.size <= MAX_IMAGE_BYTES && (SEND_TYPES as readonly string[]).includes(file.type)) {
    bitmap.close?.();
    return { mime: file.type, blob: file, width, height };
  }
  const canvas = document.createElement("canvas");
  const encode: Encoder = (w, h, mime, q) =>
    new Promise((resolve, reject) => {
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas"));
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, w, h);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), mime, q);
    });
  try {
    return await fit(width, height, encode);
  } finally {
    bitmap.close?.();
  }
}

export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
