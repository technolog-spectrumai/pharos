// KaTeX, made portable.
//
// A rendered formula is static HTML that only looks like a formula once
// `katex.min.css` and its fonts are present. On screen Vite serves both. In a
// PDF the renderer fetches NOTHING — its url_fetcher allows `data:` and refuses
// everything else, which is the property that keeps a document from phoning
// home — so the stylesheet and every font it names have to travel inside the
// HTML as data: URIs.
//
// memo's `render_pdf.py` staged the woff2 files beside the document instead
// and pointed base_url at them. That needs a filesystem the renderer may read,
// which is exactly the door this app keeps shut. Inlining costs ~300 KB per
// export that has a formula, and nothing at all otherwise.

/** Only when there is a formula to dress; an export without one pays nothing. */
export function needsKatex(html: string): boolean {
  return /class="katex/.test(html);
}

/** Every woff2 KaTeX ships, each as the hashed URL Vite gave it. Globbed so
 *  the bundler sees the list and includes only what is named — a template
 *  literal in `import()` would not be resolvable at build time. */
const FONT_URLS = import.meta.glob("/node_modules/katex/dist/fonts/*.woff2", {
  query: "?url", import: "default", eager: true,
}) as Record<string, string>;

let cached: Promise<string> | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * `katex.min.css` with every `url(fonts/…woff2)` replaced by the font itself.
 *
 * Fetched from the app's own bundle — same origin, which the policy allows —
 * and cached for the session: the bytes do not change, and a second export
 * should not pay for them again. Only woff2, as memo chose: KaTeX ships three
 * formats of every face and a renderer takes the first it can read.
 */
export async function inlineKatexCss(): Promise<string> {
  cached ??= (async () => {
    const cssMod = await import("katex/dist/katex.min.css?raw");
    let css = cssMod.default as string;
    for (const [path, url] of Object.entries(FONT_URLS)) {
      const name = path.split("/").pop()!;
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const data = `data:font/woff2;base64,${toBase64(bytes)}`;
      css = css.split(`url(fonts/${name})`).join(`url(${data})`);
    }
    // Whatever formats remain (ttf, woff) point at paths the renderer will
    // refuse; strip those sources so it never even tries.
    css = css.replace(/,\s*url\(fonts\/[^)]+\)\s*format\("(?:woff|truetype)"\)/g, "");
    return css;
  })();
  return cached;
}
