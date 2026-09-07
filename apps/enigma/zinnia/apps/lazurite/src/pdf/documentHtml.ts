// A document as one printable HTML page.
//
// The same markup cyprian's `_body.html` renders, in the same order — cover,
// contents, content — under the same stylesheet the writer draws with
// (`document.css`), so the PDF is a third view of one definition of the
// document rather than a fourth thing that resembles the other three. The
// pagination contract stated in that stylesheet is what makes the page markers
// you see while writing the pages you get.
//
// Self-contained on purpose: the stylesheet is inlined, formulas bring KaTeX
// with them, and images are already `data:` — the renderer fetches nothing.
import documentCss from "../document.css?raw";
import { outline, type CyDocument, type Margin } from "../formats/document";
import { inlineKatexCss, needsKatex } from "./katex";

export const PAGE_SIZES = ["A4", "Letter", "A5"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export type Orientation = "portrait" | "landscape";

export interface PageOptions {
  size: PageSize;
  orientation: Orientation;
  margins: Margin;
}

/** The writer's three margin presets, in the units a printer speaks. The
 *  `normal` pair is cyprian's own (25mm 20mm); the others are proportional. */
const MARGIN_MM: Record<Margin, string> = {
  normal: "25mm 20mm",
  narrow: "15mm 12mm",
  wide: "32mm 30mm",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Headings become link targets, so the contents page can point at them and
 *  the renderer can resolve page numbers after layout with target-counter. */
function anchored(content: string, ids: string[]): string {
  let i = 0;
  return content.replace(/<h([1-3])(\s[^>]*)?>/g, (m, level, attrs = "") => {
    if (/\sid=/.test(attrs)) return m;
    const id = ids[i++];
    return id ? `<h${level}${attrs} id="${esc(id)}">` : m;
  });
}

/** The `@page` block this export asks for. Everything else about how a page
 *  looks stays in document.css, whose own `@page` these rules override by
 *  coming later. */
function pageCss(o: PageOptions): string {
  return `
@page {
  size: ${o.size} ${o.orientation};
  margin: ${MARGIN_MM[o.margins]};
}
/* The screen wrapper is a sheet with a shadow; on paper @page owns the box. */
.cy-page { width: auto; min-height: 0; padding: 0; margin: 0; box-shadow: none; background: transparent; }
.cy-page::after { content: none; }
.cy-page + .cy-page { break-before: page; }
.cy-toc .cy-toc-page::after { content: target-counter(attr(href url), page); }
`;
}

/**
 * Build the print document. `contentsLabel` is the heading the contents page
 * carries, passed in because this module has no i18n and the word is one.
 */
export async function documentToHtml(
  doc: CyDocument,
  options: PageOptions,
  contentsLabel: string,
): Promise<string> {
  const headings = outline(doc.content);
  const ids = headings.map((h) => h.id);
  const body = anchored(doc.content, ids);

  const parts: string[] = [];
  if (doc.cover && doc.title) {
    parts.push(`<section class="cy-page cy-cover"><h1 class="cy-title">${esc(doc.title)}</h1></section>`);
  }
  if (doc.toc && headings.length) {
    const items = headings.map((h) =>
      `<li data-level="${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}<span class="cy-toc-page"></span></a></li>`);
    parts.push(`<section class="cy-page cy-toc"><h2>${esc(contentsLabel)}</h2><ol>${items.join("")}</ol></section>`);
  }
  parts.push(`<section class="cy-page"><div class="cy-content">${body}</div></section>`);

  const katex = needsKatex(body) ? `<style>${await inlineKatexCss()}</style>` : "";

  return `<!doctype html>
<html lang="${esc(doc.attrs?.lang ?? "")}">
<head>
<meta charset="utf-8">
<title>${esc(doc.title)}</title>
${katex}
<style>${documentCss}</style>
<style>${pageCss(options)}</style>
</head>
<body>
<div class="cy-doc cy-font-${esc(doc.font)}" data-margins="${esc(doc.margins)}">
${parts.join("\n")}
</div>
</body>
</html>`;
}
