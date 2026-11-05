import { describe, it, expect } from "vitest";
import { fit, MAX_IMAGE_BYTES, toBase64, type Encoder } from "../../src/friends/shrink";

/** A fake encoder: bytes grow with pixels and quality, like a real one. */
const encoder = (perPixel: number, makes?: string): Encoder & { calls: [number, number, string, number][] } => {
  const calls: [number, number, string, number][] = [];
  const f = (async (w: number, h: number, mime: string, q: number) => {
    calls.push([w, h, mime, q]);
    // Only the size and type matter to the search; nothing is allocated.
    return { size: Math.round(w * h * perPixel * q), type: makes ?? mime } as Blob;
  }) as Encoder & { calls: typeof calls };
  f.calls = calls;
  return f;
};

describe("making a picture small enough to send whole", () => {
  it("keeps a screenshot's size when lowering the quality is enough", async () => {
    const enc = encoder(0.12); // 1920×1080 at q .86 ≈ 214 KB: one step down fits
    const r = await fit(1920, 1080, enc);
    expect(r.blob.size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect([r.width, r.height, r.mime]).toEqual([1920, 1080, "image/webp"]);
  });

  it("shrinks a large picture to at most 1920 on its long side, then smaller until it fits", async () => {
    const enc = encoder(0.5);
    const r = await fit(4000, 3000, enc);
    expect(r.blob.size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(enc.calls[0].slice(0, 2)).toEqual([1920, 1440]);
    expect(r.width).toBeLessThan(1920);
    expect(r.width / r.height).toBeCloseTo(4 / 3, 1);
  });

  it("falls back to JPEG where the webview cannot encode WebP", async () => {
    const enc = encoder(0.05, "image/png");
    const r = await fit(800, 600, async (w, h, mime, q) => (mime === "image/webp" ? enc(w, h, mime, q) : new Blob([new Uint8Array(1000)], { type: mime })));
    expect(r.mime).toBe("image/jpeg");
  });

  it("gives up rather than send a postage stamp", async () => {
    await expect(fit(1000, 1000, encoder(1e6))).rejects.toThrow("too large");
  });

  it("encodes bytes as base64 the way Rust decodes them", async () => {
    expect(await toBase64(new Blob([new Uint8Array([0, 255, 1, 2])]))).toBe("AP8BAg==");
  });
});
