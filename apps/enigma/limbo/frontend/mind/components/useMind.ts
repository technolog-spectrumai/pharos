// Mind orchestrator — one local mind map.
//
// Not tied to a chat room and not shared with anyone: the map is this device's,
// persisted in the encrypted kv store. It is deliberately absent from
// DEVLINK_SYNC_KV and PEER_SCOPE_KV (negative pinning tests hold that promise),
// and no mind_* message type exists on the wire.
//
// Persistence is debounced because **every kvPut is an fsync** (`kv_put` →
// protasius `put_enc` → `persist`), and canvas editing mutates state on every
// gesture. `flushPersist()` forces a write before unmount and before export.
//
// The map is a module-level singleton (`getMind()`), not view state: the router
// uses createMemoryHistory and unmounts views on navigation, so a per-view ref
// would drop the graph and its undo history every time the user visits another
// tab. It is deliberately NOT a Pinia store — `stores/chat.ts` documents the
// reason, namely that Pinia's reactive() deep-unwraps inner refs, and the
// canvas/inspector components take the whole orchestrator as a prop and read
// `.value` directly.

import { computed, ref } from "vue";
import { getBuildConfig, kvGet, kvPut } from "rakotis";
import { nanoid } from "nanoid";
import {
  emptyMindDoc,
  roundPos,
  scrubContentHtml,
  validateMindDoc,
  type MindCaps,
  type MindDoc,
  type MindEdge,
  type MindNode,
  type MindNodeKind,
} from "./mindModel";

const KV_NS = "mind";
const KV_SCOPE = "default";
/** Single map ⇒ the empty-key convention used by `contacts` / `sketch`.
 *  Not in DEVLINK_SYNC_KV and not a PEER_SCOPE_KV namespace, so the map stays
 *  device-local by construction. */
const KV_KEY = "";

const PERSIST_DEBOUNCE_MS = 800;
/** Bounded so a long session can't grow the history without limit. */
const UNDO_LIMIT = 100;

/** What the canvas selected — one element at a time, mirrored from cytoscape. */
export interface MindSelection {
  kind: "node" | "edge";
  id: string;
}

/** Camera state cached across tab switches (NOT persisted — device/session
 *  state, and putting it in the doc would arm the autosave on every pan). */
export interface MindViewport {
  zoom: number;
  pan: { x: number; y: number };
}

export function useMind() {
  const cfg = getBuildConfig();
  const caps: MindCaps = {
    maxNodes: cfg.mind_max_nodes,
    maxEdges: cfg.mind_max_edges,
    maxTitleLen: cfg.mind_max_title_len,
    maxContentLen: cfg.mind_max_content_len,
  };

  const doc = ref<MindDoc>(emptyMindDoc());
  const selected = ref<MindSelection | null>(null);
  /** Bumped whenever the document is replaced wholesale (undo/redo/load/import).
   *  The canvas rebuilds its cytoscape elements on this and patches imperatively
   *  for everything else — a deep watch on the doc would rebuild on every edit. */
  const revision = ref(0);

  /** A load has been started (dedupes concurrent load() calls). */
  const loading = ref(false);
  /** The DOC load has FINISHED. Persisting before this would write the initial
   *  empty document over the user's saved map — see persist(). */
  const ready = ref(false);
  /** Doc storage could not be read, so graph persistence is disabled to avoid
   *  overwriting a map we never managed to see. Surfaced in the UI. */
  const loadFailed = ref(false);

  const nodes = computed(() => doc.value.nodes);
  const edges = computed(() => doc.value.edges);
  const topicNodes = computed(() => doc.value.nodes.filter((n) => n.kind === "topic"));
  const selectedNode = computed(() =>
    selected.value?.kind === "node" ? (doc.value.nodes.find((n) => n.id === selected.value!.id) ?? null) : null,
  );
  const selectedEdge = computed(() =>
    selected.value?.kind === "edge" ? (doc.value.edges.find((e) => e.id === selected.value!.id) ?? null) : null,
  );
  const mapFull = computed(() => doc.value.nodes.length >= caps.maxNodes);
  const edgesFull = computed(() => doc.value.edges.length >= caps.maxEdges);

  // ── UI request seams ───────────────────────────────────────────────────────
  // Cross-component nudges that are not document state: the view/inspector bumps
  // them, the component that owns the DOM reacts. Kept here because the singleton
  // is the only thing both sides can see.

  /** Non-null = the node edit modal is open for this node. Set by the canvas
   *  ✎ chip, the inspector's Edit button, F2, and node creation; cleared by
   *  the modal's Save/Discard. Doubles as the "modal open" flag the view's
   *  keyboard handler checks before destructive shortcuts. */
  const editNodeId = ref<string | null>(null);
  /** Set by the inspector's "change source/target" buttons; the canvas enters
   *  its reconnect state and clears it. */
  const reconnectRequest = ref<{ edgeId: string; end: "source" | "target" } | null>(null);

  /** Camera cache — plain field on purpose (nothing renders from it). */
  let viewport: MindViewport | null = null;

  // ── persistence ────────────────────────────────────────────────────────────

  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function persist() {
    // Never write before the load has come back. `load()` awaits an IPC read, and
    // the view fires it without awaiting; a flush in that window (tab switch, or
    // an export) would otherwise save the initial empty document over a map the
    // user has not even seen yet.
    if (!ready.value) return;
    await kvPut(KV_NS, KV_SCOPE, KV_KEY, JSON.stringify(doc.value)).catch(() => {});
  }

  /** Persist the graph now — before unmount or export. */
  async function flushPersist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persist();
  }

  /** Load the saved map. Safe to call repeatedly; only the first load applies.
   *
   *  Storage read and content parse are handled separately because they call
   *  for opposite responses: unreadable STORAGE means we must not write (we
   *  would be overwriting something we failed to see), while
   *  readable-but-corrupt CONTENT means there is nothing left to protect and
   *  starting fresh is right. */
  async function load() {
    if (loading.value) return;
    loading.value = true;

    let raw: string | null = null;
    let storageOk = true;
    try {
      raw = await kvGet(KV_NS, KV_SCOPE, KV_KEY);
    } catch {
      storageOk = false;
    }
    if (storageOk) {
      try {
        const parsed = raw ? validateMindDoc(JSON.parse(raw), caps) : null;
        if (parsed) doc.value = parsed;
      } catch {
        doc.value = emptyMindDoc();
      }
      ready.value = true;
    } else {
      // Refuse to persist for the rest of the session rather than clobber the
      // map, and say so — silently not saving would be its own kind of loss.
      loadFailed.value = true;
    }

    revision.value++;
  }

  /** Re-read everything from scratch (profile switch). */
  async function reload() {
    loading.value = false;
    ready.value = false;
    loadFailed.value = false;
    doc.value = emptyMindDoc();
    selected.value = null;
    editNodeId.value = null;
    viewport = null;
    undoStack.value = [];
    redoStack.value = [];
    await load();
  }

  // ── undo / redo ────────────────────────────────────────────────────────────
  // Whole-document snapshots. With one user and immutable-by-convention node and
  // edge objects this is both simpler and harder to get wrong than inverse
  // operations — and the map is small enough (capped) that copies are cheap.

  interface DocState {
    nodes: MindNode[];
    edges: MindEdge[];
  }

  const undoStack = ref<DocState[]>([]);
  const redoStack = ref<DocState[]>([]);

  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);

  function currentState(): DocState {
    return {
      nodes: doc.value.nodes.slice(),
      edges: doc.value.edges.slice(),
    };
  }

  /** Call BEFORE mutating the document. */
  function snapshot() {
    undoStack.value.push(currentState());
    if (undoStack.value.length > UNDO_LIMIT) undoStack.value.shift();
    redoStack.value = []; // a fresh action forks the timeline
  }

  /** Drop a selection that no longer points at anything. */
  function fixSelection() {
    const sel = selected.value;
    if (!sel) return;
    const alive =
      sel.kind === "node"
        ? doc.value.nodes.some((n) => n.id === sel.id)
        : doc.value.edges.some((e) => e.id === sel.id);
    if (!alive) selected.value = null;
  }

  function applyState(next: DocState) {
    doc.value.nodes = next.nodes;
    doc.value.edges = next.edges;
    fixSelection();
    schedulePersist();
    revision.value++;
  }

  function undo() {
    const prev = undoStack.value.pop();
    if (!prev) return;
    redoStack.value.push(currentState());
    applyState(prev);
  }

  function redo() {
    const next = redoStack.value.pop();
    if (!next) return;
    undoStack.value.push(currentState());
    applyState(next);
  }

  // ── selection + editing sessions ───────────────────────────────────────────
  // Inspector typing takes ONE undo point per editing session, not per keystroke
  // — otherwise renaming a node costs a dozen Ctrl+Z and can evict real history
  // at UNDO_LIMIT. The snapshot is taken lazily at the first field change after
  // the selection moved (the eraser-sweep pattern from useSketch).

  let editSnapshotTaken = false;

  function select(sel: MindSelection | null) {
    if (selected.value?.kind === sel?.kind && selected.value?.id === sel?.id) return;
    selected.value = sel;
    editSnapshotTaken = false;
  }

  function editSnapshot() {
    if (editSnapshotTaken) return;
    snapshot();
    editSnapshotTaken = true;
  }

  // ── graph mutations ────────────────────────────────────────────────────────

  function nodeById(id: string): MindNode | null {
    return doc.value.nodes.find((n) => n.id === id) ?? null;
  }

  /** Replace one node with a new object (never mutate — snapshots share them). */
  function replaceNode(next: MindNode) {
    doc.value.nodes = doc.value.nodes.map((n) => (n.id === next.id ? next : n));
    schedulePersist();
  }

  function addNode(kind: MindNodeKind, title: string, content: string, x: number, y: number): MindNode | null {
    const t = title.trim().slice(0, caps.maxTitleLen);
    if (!t || mapFull.value) return null;
    snapshot();
    const node: MindNode = {
      id: nanoid(),
      kind,
      title: t,
      content: content.slice(0, caps.maxContentLen),
      x: roundPos(x),
      y: roundPos(y),
      collapsed: false,
    };
    doc.value.nodes = [...doc.value.nodes, node];
    schedulePersist();
    return node;
  }

  /** Inspector field edits — one undo point per editing session (see above).
   *  An empty title is ignored rather than applied: the validator drops
   *  untitled nodes on load, so letting one into the doc would delete the node
   *  on the next restart. The field re-syncs on blur. */
  function updateNodeFields(id: string, patch: { title?: string; content?: string }) {
    const n = nodeById(id);
    if (!n) return;
    const title = patch.title !== undefined && patch.title.trim() ? patch.title.trim().slice(0, caps.maxTitleLen) : n.title;
    const content = patch.content !== undefined ? patch.content.slice(0, caps.maxContentLen) : n.content;
    if (title === n.title && content === n.content) return;
    editSnapshot();
    replaceNode({ ...n, title, content });
  }

  function setNodeKind(id: string, kind: MindNodeKind) {
    const n = nodeById(id);
    if (!n || n.kind === kind) return;
    snapshot();
    replaceNode({ ...n, kind });
  }

  /** The edit modal's Save: title, kind and content land in ONE undo step
   *  (the modal buffers drafts; nothing touches the doc until submit). Content
   *  arrives as Trix HTML — plain-mode drafts are converted by the modal — and
   *  is scrubbed here so no path into the doc skips it. Empty titles keep the
   *  old title (the validator would drop an untitled node on the next load). */
  function commitNodeEdit(id: string, patch: { title: string; kind: MindNodeKind; content: string }) {
    const n = nodeById(id);
    if (!n) return;
    const title = patch.title.trim().slice(0, caps.maxTitleLen) || n.title;
    const content = scrubContentHtml(patch.content).slice(0, caps.maxContentLen);
    if (title === n.title && content === n.content && patch.kind === n.kind) return;
    snapshot();
    replaceNode({ ...n, title, kind: patch.kind, content });
  }

  function toggleCollapsed(id: string) {
    const n = nodeById(id);
    if (!n) return;
    snapshot();
    replaceNode({ ...n, collapsed: !n.collapsed });
  }

  /** Deletes the node and every incident edge in one undo step. The node's
   *  hidden subtree (if collapsed) is deliberately NOT deleted — no surprise
   *  mass loss; whatever becomes unreachable simply turns visible again. */
  function deleteNode(id: string) {
    if (!nodeById(id)) return;
    snapshot();
    doc.value.nodes = doc.value.nodes.filter((n) => n.id !== id);
    doc.value.edges = doc.value.edges.filter((e) => e.source !== id && e.target !== id);
    fixSelection();
    schedulePersist();
  }

  function addEdge(sourceId: string, targetId: string, label = ""): MindEdge | null {
    if (edgesFull.value || sourceId === targetId) return null;
    if (!nodeById(sourceId) || !nodeById(targetId)) return null;
    snapshot();
    const edge: MindEdge = { id: nanoid(), source: sourceId, target: targetId, label: label.slice(0, caps.maxTitleLen) };
    doc.value.edges = [...doc.value.edges, edge];
    schedulePersist();
    return edge;
  }

  function edgeById(id: string): MindEdge | null {
    return doc.value.edges.find((e) => e.id === id) ?? null;
  }

  function replaceEdge(next: MindEdge) {
    doc.value.edges = doc.value.edges.map((e) => (e.id === next.id ? next : e));
    schedulePersist();
  }

  /** Edge-label edits share the session-snapshot rule with node fields. */
  function updateEdgeLabel(id: string, label: string) {
    const e = edgeById(id);
    if (!e) return;
    const next = label.slice(0, caps.maxTitleLen);
    if (next === e.label) return;
    editSnapshot();
    replaceEdge({ ...e, label: next });
  }

  /** Move one endpoint to a different node. The edge KEEPS its id and label —
   *  this is the model half of "reconnect"; the canvas patches cytoscape with
   *  ele.move(). Refused when it would create a self-loop or dangle. */
  function reconnectEdge(id: string, end: "source" | "target", nodeId: string): MindEdge | null {
    const e = edgeById(id);
    if (!e || !nodeById(nodeId)) return null;
    const next: MindEdge = end === "source" ? { ...e, source: nodeId } : { ...e, target: nodeId };
    if (next.source === next.target) return null;
    if (next.source === e.source && next.target === e.target) return e;
    snapshot();
    replaceEdge(next);
    return next;
  }

  /** Swap direction = both endpoints move at once, one undo step. */
  function swapEdgeDirection(id: string) {
    const e = edgeById(id);
    if (!e) return;
    snapshot();
    replaceEdge({ ...e, source: e.target, target: e.source });
  }

  function deleteEdge(id: string) {
    if (!edgeById(id)) return;
    snapshot();
    doc.value.edges = doc.value.edges.filter((e) => e.id !== id);
    fixSelection();
    schedulePersist();
  }

  // ── node dragging ──────────────────────────────────────────────────────────
  // Cytoscape renders the drag itself; the model only hears about the final
  // position. One gesture = one undo entry and one persist, and a click that
  // never moved the node costs neither.

  /** Snapshot taken at grab so the whole gesture is ONE undo step. */
  let dragBefore: MindNode[] | null = null;

  function beginNodeDrag() {
    dragBefore = doc.value.nodes.slice();
  }

  /** Live position write — no snapshot, no persist (endNodeDrag commits). */
  function moveNode(id: string, x: number, y: number) {
    const n = nodeById(id);
    if (!n) return;
    doc.value.nodes = doc.value.nodes.map((m) => (m.id === id ? { ...m, x: roundPos(x), y: roundPos(y) } : m));
  }

  function endNodeDrag() {
    const before = dragBefore;
    dragBefore = null;
    if (!before) return;
    if (JSON.stringify(before) === JSON.stringify(doc.value.nodes)) return; // no-op drag
    const after = doc.value.nodes;
    doc.value.nodes = before;
    snapshot();
    doc.value.nodes = after;
    schedulePersist();
  }

  /** Write a whole layout run's positions back. The implicit first layout of a
   *  position-less (imported) doc is a materialization, not a user edit — the
   *  canvas passes takeSnapshot: false for it. */
  function applyLayout(positions: Record<string, { x: number; y: number }>, takeSnapshot = true) {
    const moved = doc.value.nodes.some((n) => {
      const p = positions[n.id];
      return p && (roundPos(p.x) !== n.x || roundPos(p.y) !== n.y);
    });
    if (!moved) return;
    if (takeSnapshot) snapshot();
    doc.value.nodes = doc.value.nodes.map((n) => {
      const p = positions[n.id];
      return p ? { ...n, x: roundPos(p.x), y: roundPos(p.y) } : n;
    });
    schedulePersist();
  }

  // ── topics ─────────────────────────────────────────────────────────────────

  /** The Topics tab's "add note": a fresh note wired to the topic in ONE undo
   *  step. Edge direction is note → topic (the design decision for
   *  topic-attached notes; the caller opens the edit modal on the result).
   *  Fanned out beside the topic, spaced by how many notes already point at
   *  it. */
  function addNoteToTopic(topicId: string, title: string): MindNode | null {
    const topic = nodeById(topicId);
    if (!topic || topic.kind !== "topic") return null;
    if (mapFull.value || edgesFull.value) return null;
    const t = title.trim().slice(0, caps.maxTitleLen);
    if (!t) return null;
    const k = doc.value.edges.filter((e) => e.target === topicId).length;
    snapshot();
    const node: MindNode = {
      id: nanoid(),
      kind: "note",
      title: t,
      content: "",
      x: roundPos(topic.x + 240),
      y: roundPos(topic.y - 30 + 70 * k),
      collapsed: false,
    };
    doc.value.nodes = [...doc.value.nodes, node];
    doc.value.edges = [...doc.value.edges, { id: nanoid(), source: node.id, target: topicId, label: "" }];
    schedulePersist();
    return node;
  }

  // ── import ─────────────────────────────────────────────────────────────────

  /** Replace the whole map with an already-validated document (import). One
   *  snapshot first, so a bad import is one Ctrl+Z away from undone; one flush
   *  after, so a deliberate action never sits in the debounce window. */
  async function replaceDoc(next: MindDoc) {
    snapshot();
    doc.value.nodes = next.nodes;
    doc.value.edges = next.edges;
    selected.value = null;
    editNodeId.value = null;
    viewport = null;
    revision.value++;
    await flushPersist();
  }

  return {
    // state
    doc,
    nodes,
    edges,
    topicNodes,
    revision,
    ready,
    loadFailed,
    mapFull,
    edgesFull,
    // caps
    caps,
    // selection
    selected,
    selectedNode,
    selectedEdge,
    select,
    // UI seams
    editNodeId,
    reconnectRequest,
    getViewport: () => viewport,
    setViewport: (v: MindViewport | null) => {
      viewport = v;
    },
    // graph
    addNode,
    updateNodeFields,
    setNodeKind,
    commitNodeEdit,
    toggleCollapsed,
    deleteNode,
    addEdge,
    updateEdgeLabel,
    reconnectEdge,
    swapEdgeDirection,
    deleteEdge,
    beginNodeDrag,
    moveNode,
    endNodeDrag,
    applyLayout,
    // topics
    addNoteToTopic,
    // import
    replaceDoc,
    // history
    canUndo,
    canRedo,
    undo,
    redo,
    // lifecycle
    load,
    reload,
    flushPersist,
  };
}

export type Mind = ReturnType<typeof useMind>;

// Lazy module singleton: created on first use (so nothing touches the kv store
// at import time) and shared by every view, which is what keeps the map and its
// undo history alive across tab navigation.
let instance: Mind | null = null;

export function getMind(): Mind {
  if (!instance) instance = useMind();
  return instance;
}

/** Test seam — drops the singleton so a fresh one is built next call. */
export function resetMind(): void {
  instance = null;
}
