// Cyprian's document format (XML v3), in TypeScript.
//
// This is a PORT, not a reimplementation: the reference is
// portal/vendor/toto_libs/packages/toto-works/src/toto/cyprian/document_format.py,
// and the golden tests in tests/unit/documentFormat.test.ts compare this
// module's output against files that module produced. When the two disagree,
// Python is right — it is the server that stores and re-sanitises these bytes.
//
// Two rules carry the whole format and must not be softened:
//
//   * The payload is CDATA-wrapped, including a literal "]]>" (split across two
//     sections so it round-trips). Noisier to read; the only rule that cannot
//     lose a byte.
//   * Nothing unknown is discarded. Unknown root attributes and unknown child
//     elements ride through `dumps` untouched, in `attrs` and `extra`.
//
// What this module deliberately does NOT do is sanitise. Cyprian sanitises on
// both save and open, server-side, because a document can arrive from anywhere.
// Zinnia is a client: it must not pretend its own allowlist is the authority,
// and it must expect the server to hand back bytes it did not send verbatim.

export const FORMAT_VERSION = "3";

export const MARGINS = ["normal", "narrow", "wide"] as const;
export const FONTS = ["sans", "serif", "mono", "rounded", "condensed"] as const;
export const TONES = ["note", "warn", "tip", "quote"] as const;

export type Margin = (typeof MARGINS)[number];
export type Font = (typeof FONTS)[number];
export type Tone = (typeof TONES)[number];

export const DEFAULT_MARGINS: Margin = "normal";
export const DEFAULT_FONT: Font = "serif";
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_LEVEL = 3;

/** Root attributes the format owns; anything else is carried in `attrs`. */
const ROOT_OWN_ATTRS = new Set([
  "version", "title", "font", "page", "margins", "toc", "cover", "numbering",
]);

export class DocumentParseError extends Error {}

export interface CyDocument {
  title: string;
  content: string;
  meta: Record<string, string>;
  version: string;
  font: string;
  margins: string;
  toc: boolean;
  cover: boolean;
  /** Unknown root attributes, preserved verbatim. */
  attrs: Record<string, string>;
  /** Unknown child elements, preserved verbatim as serialised XML. */
  extra: string[];
}

export function newDocument(title = ""): CyDocument {
  // Matches the Python default exactly: an H1 when named, no toc, no cover —
  // the ordinary cyprian document is a one-page handout.
  const body = title ? `<h1>${escText(title)}</h1><p></p>` : "<p></p>";
  return {
    title, content: body, meta: {}, version: FORMAT_VERSION,
    font: DEFAULT_FONT, margins: DEFAULT_MARGINS,
    toc: false, cover: false, attrs: {}, extra: [],
  };
}

// ── escaping ────────────────────────────────────────────────────────────────
// Deliberately the same partial escapes Python uses: escAttr covers & < > ",
// escText covers only & and < . Matching it exactly is what makes the golden
// byte-comparison possible.

function escAttr(text: string): string {
  return (text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escText(text: string): string {
  return (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function wrapCdata(body: string): string {
  // A CDATA section cannot contain "]]>"; split it across two sections so the
  // byte sequence survives.
  const safe = (body || "").replace(/]]>/g, "]]]]><![CDATA[>");
  return `<![CDATA[${safe}]]>`;
}

function attrString(
  own: Array<[string, string]>, extra: Record<string, string>,
): string {
  // Known attributes in declared order, then unknown ones sorted. Deterministic
  // output is what lets the round-trip test compare strings, and what keeps a
  // save from producing a spurious diff.
  const parts = own
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`);
  for (const k of Object.keys(extra).sort()) {
    parts.push(` ${k}="${escAttr(extra[k])}"`);
  }
  return parts.join("");
}

// ── serialise ───────────────────────────────────────────────────────────────

export function dumps(doc: CyDocument): string {
  const rootExtra: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.attrs || {})) {
    if (!ROOT_OWN_ATTRS.has(k)) rootExtra[k] = v;
  }

  const lines = ['<?xml version="1.0" encoding="utf-8"?>'];
  lines.push("<document" + attrString([
    ["version", FORMAT_VERSION],
    ["title", doc.title],
    ["font", doc.font || DEFAULT_FONT],
    ["margins", doc.margins || DEFAULT_MARGINS],
    ["toc", doc.toc ? "true" : "false"],
    ["cover", doc.cover ? "true" : "false"],
  ], rootExtra) + ">");

  const metaKeys = Object.keys(doc.meta || {});
  if (metaKeys.length) {
    lines.push("  <meta>");
    for (const name of metaKeys.sort()) {
      lines.push(`    <field name="${escAttr(name)}">${wrapCdata(doc.meta[name])}</field>`);
    }
    lines.push("  </meta>");
  }

  lines.push(`  <content>${wrapCdata(doc.content)}</content>`);

  for (const raw of doc.extra || []) lines.push("  " + raw.trim());
  lines.push("</document>");
  return lines.join("\n") + "\n";
}

// ── parse ───────────────────────────────────────────────────────────────────

/** Reads v1, v2 and v3 — the same one-way conversion Python does on open.
 *  Only v3 is ever written. */
export function loads(text: string): CyDocument {
  const trimmed = (text || "").trim();
  if (!trimmed) return newDocument();

  const parsed = new DOMParser().parseFromString(trimmed, "application/xml");
  const failure = parsed.querySelector("parsererror");
  if (failure) throw new DocumentParseError(`Invalid document: ${failure.textContent ?? ""}`);

  const root = parsed.documentElement;
  if (!root || root.tagName !== "document") {
    throw new DocumentParseError(`Expected root <document>, found <${root?.tagName ?? "?"}>`);
  }

  const attrs: Record<string, string> = {};
  for (const a of Array.from(root.attributes)) {
    if (!ROOT_OWN_ATTRS.has(a.name)) attrs[a.name] = a.value;
  }

  const doc: CyDocument = {
    title: root.getAttribute("title") || "",
    content: "",
    meta: {},
    version: FORMAT_VERSION,
    font: root.getAttribute("font") || DEFAULT_FONT,
    margins: root.getAttribute("margins") || DEFAULT_MARGINS,
    toc: (root.getAttribute("toc") || "true") !== "false",
    cover: (root.getAttribute("cover") || "false") === "true",
    attrs,
    extra: [],
  };

  const parts: string[] = [];
  for (const child of Array.from(root.children)) {
    if (child.tagName === "meta") {
      for (const fieldEl of Array.from(child.children)) {
        if (fieldEl.tagName !== "field") continue;
        const name = fieldEl.getAttribute("name");
        if (name) doc.meta[name] = fieldEl.textContent || "";
      }
    } else if (child.tagName === "content") {
      parts.push((child.textContent || "").slice(0, MAX_PAYLOAD_BYTES));
    } else if (child.tagName === "section") {
      parts.push(sectionToHtml(child));
    } else {
      // Unknown element: keep the bytes, exactly as Python does.
      doc.extra.push(new XMLSerializer().serializeToString(child).trim());
    }
  }

  doc.content = parts.join("").slice(0, MAX_PAYLOAD_BYTES);
  clamp(doc);
  return doc;
}

/** Clamp enumerations to the schema — the non-sanitising half of Python's
 *  `_validate`. The body is left alone on purpose (see the header). */
function clamp(doc: CyDocument): void {
  if (!(FONTS as readonly string[]).includes(doc.font)) doc.font = DEFAULT_FONT;
  if (!(MARGINS as readonly string[]).includes(doc.margins)) doc.margins = DEFAULT_MARGINS;
  doc.title = (doc.title || "").slice(0, 400);
}

/** A v1/v2 `<section>` as HTML: its heading becomes a real heading in the body,
 *  which is what it always was on every rendered surface. v1 `<block>` children
 *  are folded through `blocksToHtml`. */
function sectionToHtml(el: Element): string {
  let level = parseInt(el.getAttribute("level") || "1", 10);
  if (!Number.isFinite(level)) level = 1;
  level = Math.max(1, Math.min(MAX_LEVEL, level));

  let heading = "";
  const body: string[] = [];
  const legacy: V1Block[] = [];

  for (const child of Array.from(el.children)) {
    if (child.tagName === "heading") heading = (child.textContent || "").trim();
    else if (child.tagName === "content") body.push(child.textContent || "");
    else if (child.tagName === "block") legacy.push(parseBlock(child));
  }

  if (legacy.length) body.push(blocksToHtml(legacy));

  const head = heading ? `<h${level}>${escText(heading)}</h${level}>` : "";
  return head + body.join("");
}

// ── version 1 blocks ────────────────────────────────────────────────────────
// Nothing writes these any more; they exist so a v1 file still opens. The
// markup below is exactly what Python's `_blocks_to_html` produces, so a
// converted document reads identically in the reader, the thumbnail and the
// PDF — the golden `legacy_v1` case pins that.

interface V1Block {
  type: string;
  payload: string;
  items: string[];
  rows: string[][];
  render: string;
  attrs: Record<string, string>;
}

function parseBlock(el: Element): V1Block {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (a.name !== "id" && a.name !== "type") attrs[a.name] = a.value;
  }
  const block: V1Block = {
    type: el.getAttribute("type") || "text",
    payload: "", items: [], rows: [], render: "", attrs,
  };

  if (block.type === "list") {
    for (const item of Array.from(el.children)) {
      if (item.tagName === "item") block.items.push(item.textContent || "");
    }
  } else if (block.type === "table") {
    for (const rowEl of Array.from(el.children)) {
      if (rowEl.tagName !== "row") continue;
      block.rows.push(Array.from(rowEl.children)
        .filter((c) => c.tagName === "cell")
        .map((c) => c.textContent || ""));
    }
  } else {
    // `<source>` when present, element text otherwise — so a hand-written
    // `<block type="formula">x^2</block>` still opens.
    const source = Array.from(el.children).find((c) => c.tagName === "source");
    block.payload = (source ? source.textContent : el.textContent) || "";
    const rendered = Array.from(el.children).find((c) => c.tagName === "render");
    if (rendered) block.render = rendered.textContent || "";
  }
  return block;
}

function blocksToHtml(blocks: V1Block[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    const attrs = block.attrs;
    const tint = attrs.highlight === "true" ? ' class="cy-highlight"' : "";
    switch (block.type) {
      case "text":
      case "html":
        out.push(tint ? `<div${tint}>${block.payload}</div>` : block.payload);
        break;
      case "callout":
        out.push(`<div class="cy-callout" data-tone="${escAttr(attrs.tone || "note")}">${block.payload}</div>`);
        break;
      case "quote": {
        let inner = block.payload;
        if (attrs.cite) inner += `<p class="cy-cite">${escText(attrs.cite)}</p>`;
        out.push(`<blockquote${tint}>${inner}</blockquote>`);
        break;
      }
      case "list": {
        const tag = attrs.ordered === "true" ? "ol" : "ul";
        out.push(`<${tag}${tint}>${block.items.map((i) => `<li>${i}</li>`).join("")}</${tag}>`);
        break;
      }
      case "table": {
        const head = attrs.header === "true";
        const rows = block.rows.map((row, index) => {
          const cell = head && index === 0 ? "th" : "td";
          return "<tr>" + row.map((c) => `<${cell}>${c}</${cell}>`).join("") + "</tr>";
        });
        out.push(`<table${tint}>${rows.join("")}</table>`);
        break;
      }
      case "image": {
        let extra = "";
        if (attrs.width) extra += ` data-width="${escAttr(attrs.width)}"`;
        if (attrs.align) extra += ` data-align="${escAttr(attrs.align)}"`;
        out.push(`<img src="${escAttr(block.payload)}" alt="${escAttr(attrs.alt || "")}"${extra}>`);
        break;
      }
      case "code": {
        const lang = attrs.language ? ` data-language="${escAttr(attrs.language)}"` : "";
        // Escaped, never raw — a code block is literal text.
        out.push(`<pre${lang}${tint}><code>${escText(block.payload)}</code></pre>`);
        break;
      }
      case "formula": {
        const inner = block.render
          || `<code class="cy-formula-source">${escText(block.payload)}</code>`;
        out.push(`<div class="cy-formula" data-latex="${escAttr(block.payload)}">${inner}</div>`);
        break;
      }
      case "divider":
        out.push("<hr>");
        break;
      case "pagebreak":
        out.push('<div class="cy-pagebreak"></div>');
        break;
      default:
        // A type this build has never heard of has no markup to become. Python
        // keeps the element verbatim in `extra`; zinnia drops it rather than
        // risk re-emitting something it did not parse — the server's copy is
        // authoritative, and a v1 file with an unknown block is a museum piece.
        break;
    }
  }
  return out.join("");
}

// ── identity ────────────────────────────────────────────────────────────────

const SNIFF_SKIP = /<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g;
const SNIFF_RE = /^<\s*document\s*[/>]|^<\s*document\s/i;

/** Cheap identity check over the first bytes — for listings, where a full parse
 *  would mean decoding every embedded image just to look at one tag. */
export function sniffIsDocument(head: string): boolean {
  return SNIFF_RE.test((head || "").slice(0, 2048).replace(SNIFF_SKIP, "").trimStart());
}

// ── headings, derived rather than stored ────────────────────────────────────

const HEADING_RE = /<h([1-3])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
const ID_ATTR_RE = /\bid="([^"]*)"/i;

export interface Heading { id: string; level: number; text: string }

export function outline(content: string): Heading[] {
  const out: Heading[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(HEADING_RE.source, "gi");
  let index = 0;
  while ((match = re.exec(content || "")) !== null) {
    index++;
    const [, level, rawAttrs, inner] = match;
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue; // an empty heading is not a destination
    const existing = ID_ATTR_RE.exec(rawAttrs || "");
    out.push({ id: existing ? existing[1] : `h-${index}`, level: Number(level), text });
  }
  return out;
}
