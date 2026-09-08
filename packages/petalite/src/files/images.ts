// Which files are pictures, and how their bytes become something an <img> can
// show.
//
// Extracted from PresentationEditor, which had the only copy. Two opinions
// about what counts as an image is how a deck ends up accepting a `.bmp` that
// the file panel refuses to preview — the same argument openWith.ts makes about
// there being one router.
//
// `.svg` is deliberately ABSENT. It is a picture, but it is also markup the
// sketch editor opens and edits, and it is the one image type that can carry a
// script. It has an editor; it does not need a preview.

/** The types an <img> can be trusted to render, and the MIME each needs. */
export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether a name is one this app should SHOW rather than read as text. */
export function isImageName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME, extensionOf(name));
}

/**
 * Bytes as a `data:` URI.
 *
 * Chunked, and that is not a micro-optimisation:
 * `btoa(String.fromCharCode(...bytes))` spreads every byte into an argument
 * list and blows the call limit on anything larger than a thumbnail.
 */
export function toDataUri(name: string, bytes: Uint8Array): string {
  const mime = IMAGE_MIME[extensionOf(name)] ?? "application/octet-stream";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
