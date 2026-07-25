// Mind map — pure data model (no Vue/Tauri/DOM imports).
//
// One local directed graph of ideas — this device's only: persisted in the
// encrypted kv store, never shared with a peer and never synced to a linked
// device. There is no conflict resolution because there is nothing to resolve
// — one user, one map.
//
// Nodes carry a title (the canvas label) and free-text content; edges carry only
// a label. Edges are directed (source → target): direction is what gives
// "collapse this node's subtree" a meaning. Topic nodes are ordinary nodes with
// `kind: "topic"` — hubs that cross-link ideas and that dump entries convert
// under. The renderer decides how they look; the model only stores the kind.

// ── document ──────────────────────────────────────────────────────────────────

export type MindNodeKind = "note" | "topic";

export interface MindNode {
  id: string;
  kind: MindNodeKind;
  /** Canvas label. Never empty — an untitled node would be an invisible target. */
  title: string;
  /** Rich text as Trix-flavored HTML, edited in the inspector's Trix editor.
   *  Treated as an opaque capped string here. SAFETY: only ever rendered
   *  through Trix's own parser (whose element/attribute whitelist drops
   *  anything active) — never via v-html. Empty is the norm. */
  content: string;
  /** Model-space position. The canvas runs a preset layout from these, so a saved
   *  map reopens exactly as it was arranged. */
  x: number;
  y: number;
  /** Outgoing-descendant subtree hidden. Only the flag is stored — visibility is
   *  derived at render time, so a hand-edited or imported flag can never leave the
   *  document inconsistent. */
  collapsed: boolean;
}

export interface MindEdge {
  id: string;
  source: string;
  target: string;
  /** Optional relation label. Shares the title cap — labels are title-like. */
  label: string;
}

export interface MindDoc {
  v: 1;
  nodes: MindNode[];
  edges: MindEdge[];
}

export function emptyMindDoc(): MindDoc {
  return { v: 1, nodes: [], edges: [] };
}

// ── caps ──────────────────────────────────────────────────────────────────────

/** Caps from the build config, passed in as data so the model stays pure. */
export interface MindCaps {
  maxNodes: number;
  maxEdges: number;
  /** Caps node titles AND edge labels — labels are title-like text. */
  maxTitleLen: number;
  maxContentLen: number;
}

/** Position quantum: integers. Model space is roughly pixels, so sub-pixel
 *  precision is JSON churn with nothing to show for it. */
export function roundPos(v: number): number {
  return Math.round(v);
}

/** Sanity bound on hostile coordinates (NaN/Infinity/1e300 in a hand-edited or
 *  imported file), not a layout constraint — a real map lives within a few
 *  thousand units, so a million is generous and costs nothing. */
export const MIND_COORD_LIMIT = 1_000_000;

// ── validation ────────────────────────────────────────────────────────────────
// Persisted and imported documents are untrusted: a corrupt kv entry or a
// hand-edited export must not poison the renderer or come back out of the store
// bigger than the caps allow. Rebuild every field rather than spreading —
// titles/labels land in cytoscape data and back in the kv store.

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

function coord(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MIND_COORD_LIMIT ? v : null;
}

/** Strip anything from content HTML that could touch the network or execute.
 *  The app ships with no webview CSP, so a `<img src="https://…">` inside a
 *  hand-edited import (or smuggled past the editor) would be FETCHED the
 *  moment Trix parses it — an IP/tracking leak in an app that promises
 *  offline. Attachments (<figure>) and images are removed outright — the
 *  editor refuses them anyway — and href values are allowlisted to
 *  http(s)/mailto so a javascript: link can't ride along. Defense in depth,
 *  not a full sanitizer: content is only ever rendered through Trix's own
 *  parser, never v-html. */
export function scrubContentHtml(html: string): string {
  return html
    .replace(/<(figure|script|style|iframe|object|video|audio|picture)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(img|picture|source|video|audio|iframe|object|embed|script|link|meta)\b[^>]*>/gi, "")
    .replace(/<\/(picture|video|audio|iframe|object|script)>/gi, "")
    .replace(/\s(href|src)\s*=\s*("(?!https?:|mailto:)[^"]*"|'(?!https?:|mailto:)[^']*')/gi, "");
}

/** Overlong titles are SLICED, not dropped: the length cap is a storage bound,
 *  and deleting a node because its title grew past it would be data loss. An
 *  empty/missing title still drops the node — there is nothing to show. */
export function validateMindNode(x: unknown, caps: MindCaps): MindNode | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const id = str(o.id, 64);
  if (!id) return null;
  const title = typeof o.title === "string" && o.title.length > 0 ? o.title.slice(0, caps.maxTitleLen) : null;
  if (!title) return null;
  const x0 = coord(o.x);
  const y0 = coord(o.y);
  if (x0 === null || y0 === null) return null;
  return {
    id,
    kind: o.kind === "topic" ? "topic" : "note",
    title,
    content: typeof o.content === "string" ? scrubContentHtml(o.content).slice(0, caps.maxContentLen) : "",
    x: x0,
    y: y0,
    collapsed: !!o.collapsed,
  };
}

/** Edges are validated against the surviving node ids: a dangling endpoint is
 *  meaningless, and a self-loop is both meaningless in a mind map and a hole in
 *  the collapse algorithm, so both are dropped. Parallel edges between the same
 *  pair are legal — the renderer separates them. */
export function validateMindEdge(x: unknown, nodeIds: ReadonlySet<string>, caps: MindCaps): MindEdge | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const id = str(o.id, 64);
  const source = str(o.source, 64);
  const target = str(o.target, 64);
  if (!id || !source || !target) return null;
  if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) return null;
  return {
    id,
    source,
    target,
    label: typeof o.label === "string" ? o.label.slice(0, caps.maxTitleLen) : "",
  };
}

/** Re-validate a document loaded from the store or an import file, preserving
 *  order and dropping anything malformed. Nodes go first so edges can be checked
 *  against the ids that actually survived; duplicate ids keep the first
 *  occurrence, so a crafted file cannot smuggle two elements under one id. */
export function validateMindDoc(x: unknown, caps: MindCaps): MindDoc | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.nodes) || !Array.isArray(o.edges)) return null;
  const doc = emptyMindDoc();
  const nodeIds = new Set<string>();
  for (const n of o.nodes) {
    if (doc.nodes.length >= caps.maxNodes) break;
    const v = validateMindNode(n, caps);
    if (v && !nodeIds.has(v.id)) {
      nodeIds.add(v.id);
      doc.nodes.push(v);
    }
  }
  const edgeIds = new Set<string>();
  for (const e of o.edges) {
    if (doc.edges.length >= caps.maxEdges) break;
    const v = validateMindEdge(e, nodeIds, caps);
    if (v && !edgeIds.has(v.id)) {
      edgeIds.add(v.id);
      doc.edges.push(v);
    }
  }
  return doc;
}

// ── export / import ───────────────────────────────────────────────────────────
// Self-describing interchange file: a `format` discriminator so foreign JSON is
// refused before any field is read, a `version` so a future schema can migrate,
// and counts so a human can sanity-check what a file claims to hold. The counts
// are informational only — import trusts the validated arrays, never the claim.

export const MIND_EXPORT_FORMAT = "enigma-mind";
export const MIND_EXPORT_VERSION = 1;

export interface MindExportFile {
  format: typeof MIND_EXPORT_FORMAT;
  version: typeof MIND_EXPORT_VERSION;
  exportedAt: string;
  metadata: { nodeCount: number; edgeCount: number };
  nodes: MindNode[];
  edges: MindEdge[];
}

export function toExportFile(doc: MindDoc): MindExportFile {
  return {
    format: MIND_EXPORT_FORMAT,
    version: MIND_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    metadata: { nodeCount: doc.nodes.length, edgeCount: doc.edges.length },
    nodes: doc.nodes,
    edges: doc.edges,
  };
}

/** Parse an import file: refuse anything that does not declare itself as ours at
 *  the current version, then run the same validation as a kv load. Returns the
 *  validated document, or null when the file is not importable at all. */
export function parseImportFile(x: unknown, caps: MindCaps): MindDoc | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (o.format !== MIND_EXPORT_FORMAT || o.version !== MIND_EXPORT_VERSION) return null;
  return validateMindDoc({ nodes: o.nodes, edges: o.edges }, caps);
}

// ── plain ⇄ rich conversion (the edit modal's plain-text mode) ────────────────

/** Escape plain text into minimal HTML for the Trix-backed content field:
 *  entities escaped, newlines become <br>. Node content is HTML (see
 *  MindNode.content); feeding raw typed text into it unescaped would let a
 *  jotted "<b>" turn into formatting — or worse survive a round-trip as
 *  markup. */
export function plainTextToHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

/** Trix HTML → plain text, for the edit modal's plain mode. Blocks and <br>
 *  become newlines, tags drop, the basic entities decode (&amp; last, so a
 *  literal "&amp;lt;" comes out as "&lt;" and not "<"). Lossy by design —
 *  flipping rich → plain is the user choosing to shed formatting. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|h[1-6]|blockquote|pre|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

