<script setup lang="ts">
// Mind canvas. The cytoscape instance lives and dies with this component (the
// memory-history router unmounts views on navigation) — the document in the
// useMind singleton is the only source of truth. Everything the user does on
// the canvas becomes an orchestrator mutation; a single diff watcher folds
// every document change (from ANY caller: canvas, inspector, keyboard, dump
// link, undo) back into cytoscape, so no call site needs to patch cy by hand.
//
// Gestures cytoscape core lacks are built from primitives:
// - connect / reconnect: two-click with a rubber band (a ghost node with
//   events:'no' chasing the pointer, plus a dashed ghost edge). Two-click over
//   drag-from-node because dragging is taken by node repositioning.
// - reconnect endpoint handles: DOM buttons over the canvas — cytoscape can't
//   paint interactive sub-element widgets. Note edge source/target are
//   IMMUTABLE data in cytoscape: the sync uses ele.move(), which returns a
//   replacement element.
// - collapse: double-tap a node, Space, or the ⊖/⊕ chip on the selected node.
//   Visibility is class-based display:none — hidden nodes aren't hit-testable,
//   so they can never become connect targets.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import cytoscape from "cytoscape";
import {
  computeHiddenNodes,
  displayLabel,
  docToElements,
  hiddenCounts,
  needsMaterialization,
  nodeClasses,
  pickLayoutRoots,
  validateNewEdge,
} from "./mindGraphModel";
import { buildStylesheet, readPalette } from "./mindGraphStyle";
import type { Mind } from "./useMind";

export type MindTool = "select" | "add-note" | "add-topic" | "connect";

const props = defineProps<{
  mind: Mind;
  tool: MindTool;
  darkMode?: boolean;
}>();

const emit = defineEmits<{ "update:tool": [MindTool] }>();

const { t } = useI18n();

const wrapper = ref<HTMLDivElement | null>(null);
const host = ref<HTMLDivElement | null>(null);

let cy: cytoscape.Core | null = null;
let ro: ResizeObserver | null = null;
let disposed = false;
let didInitialFit = false;

const GHOST_ID = "__mind_ghost";
const GHOST_EDGE_ID = "__mind_ghost_edge";

// ── gesture state (rides on top of the toolbar tool) ────────────────────────

type Gesture =
  | { kind: "idle" }
  | { kind: "connect-source" }
  | { kind: "connect-target"; sourceId: string }
  | { kind: "reconnect"; edgeId: string; end: "source" | "target" };

const gesture = ref<Gesture>({ kind: "idle" });

const hintKey = computed(() => {
  if (gesture.value.kind === "connect-source" || gesture.value.kind === "connect-target") return "mind.connectHint";
  if (gesture.value.kind === "reconnect") return "mind.reconnectHint";
  return null;
});

const cursorClass = computed(() =>
  props.tool !== "select" || gesture.value.kind === "reconnect" ? "cursor-crosshair" : "",
);

/** Lock plain selection/dragging while a pick gesture needs raw taps. */
function setLocked(locked: boolean) {
  cy?.autoungrabify(locked);
  cy?.autounselectify(locked);
}

// ── DOM overlays (reconnect handles + collapse chip) ────────────────────────

const handles = ref<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
const chip = ref<{ x: number; y: number; label: string; nodeId: string } | null>(null);
/** ✎ on the selected node's top-left corner — the per-node door into the edit
 *  modal (cytoscape nodes are canvas pixels; a DOM button per node is this). */
const editChip = ref<{ x: number; y: number; nodeId: string } | null>(null);

function updateOverlays() {
  if (!cy || gesture.value.kind !== "idle" || props.tool !== "select") {
    handles.value = null;
    chip.value = null;
    editChip.value = null;
    return;
  }
  const selEdge = props.mind.selectedEdge.value;
  if (selEdge) {
    const ele = cy.getElementById(selEdge.id);
    if (ele.length !== 0) {
      const s = ele.renderedSourceEndpoint();
      const e = ele.renderedTargetEndpoint();
      handles.value = { sx: s.x, sy: s.y, tx: e.x, ty: e.y };
    } else {
      handles.value = null;
    }
  } else {
    handles.value = null;
  }

  const selNode = props.mind.selectedNode.value;
  if (selNode) {
    const ele = cy.getElementById(selNode.id);
    const hasOutgoing = props.mind.edges.value.some((e) => e.source === selNode.id);
    if (ele.length !== 0) {
      const bb = ele.renderedBoundingBox();
      editChip.value = { x: bb.x1, y: bb.y1, nodeId: selNode.id };
      if (selNode.collapsed || hasOutgoing) {
        const nodes = props.mind.doc.value.nodes;
        const edges = props.mind.doc.value.edges;
        const hidden = computeHiddenNodes(nodes, edges);
        const count = hiddenCounts(nodes, edges, hidden).get(selNode.id) ?? 0;
        chip.value = {
          x: bb.x2,
          y: bb.y1,
          label: selNode.collapsed ? `⊕ ${count}` : "⊖",
          nodeId: selNode.id,
        };
      } else {
        chip.value = null;
      }
    } else {
      chip.value = null;
      editChip.value = null;
    }
  } else {
    chip.value = null;
    editChip.value = null;
  }
}

// ── ghost rubber band ────────────────────────────────────────────────────────

function removeGhost() {
  if (!cy) return;
  cy.getElementById(GHOST_EDGE_ID).remove();
  cy.getElementById(GHOST_ID).remove();
}

/** One rubber band for both gestures: the ghost holds whichever endpoint the
 *  user is still choosing; the arrowhead stays truthful to edge direction. */
function spawnGhost(anchor: { source?: string; target?: string }, at: { x: number; y: number }) {
  if (!cy) return;
  removeGhost();
  cy.add([
    {
      group: "nodes",
      data: { id: GHOST_ID },
      position: { ...at },
      classes: "ghost",
      grabbable: false,
      selectable: false,
    },
    {
      group: "edges",
      data: {
        id: GHOST_EDGE_ID,
        source: anchor.source ?? GHOST_ID,
        target: anchor.target ?? GHOST_ID,
      },
      classes: "ghost-edge",
    },
  ] as cytoscape.ElementDefinition[]);
}

let ghostRaf: number | null = null;
let ghostPos: { x: number; y: number } | null = null;

/** evt.position is already in model coordinates — flushed once per frame. */
function ghostFollow(pos: { x: number; y: number }) {
  if (gesture.value.kind !== "connect-target" && gesture.value.kind !== "reconnect") return;
  ghostPos = pos;
  if (ghostRaf !== null) return;
  ghostRaf = requestAnimationFrame(() => {
    ghostRaf = null;
    if (cy && ghostPos) {
      const ghost = cy.getElementById(GHOST_ID);
      if (ghost.length !== 0) ghost.position(ghostPos);
    }
  });
}

function clearAffordances() {
  if (!cy) return;
  cy.nodes().removeClass("connect-source connect-hover connect-invalid");
  cy.edges().removeClass("reconnect-dim");
}

function cancelGesture() {
  removeGhost();
  clearAffordances();
  gesture.value = props.tool === "connect" ? { kind: "connect-source" } : { kind: "idle" };
  setLocked(props.tool !== "select");
  updateOverlays();
}

// ── connect ──────────────────────────────────────────────────────────────────

function beginConnectTarget(sourceId: string, at: { x: number; y: number }) {
  if (!cy) return;
  cy.getElementById(sourceId).addClass("connect-source");
  spawnGhost({ source: sourceId }, at);
  gesture.value = { kind: "connect-target", sourceId };
}

function finishConnect(targetId: string) {
  if (gesture.value.kind !== "connect-target") return;
  const sourceId = gesture.value.sourceId;
  if (validateNewEdge(props.mind.edges.value, sourceId, targetId) !== null) return; // invalid — hover overlay already says so
  props.mind.addEdge(sourceId, targetId);
  removeGhost();
  clearAffordances();
  gesture.value = { kind: "connect-source" }; // sticky mode: chain several edges
}

// ── reconnect ────────────────────────────────────────────────────────────────

function beginReconnect(edgeId: string, end: "source" | "target") {
  if (!cy) return;
  const ele = cy.getElementById(edgeId);
  if (ele.length === 0) return;
  cancelGesture();
  ele.addClass("reconnect-dim");
  const src = ele.data("source") as string;
  const tgt = ele.data("target") as string;
  const anchorNode = cy.getElementById(end === "target" ? src : tgt);
  const looseNode = cy.getElementById(end === "target" ? tgt : src);
  const at = looseNode.length !== 0 ? looseNode.position() : anchorNode.position();
  spawnGhost(end === "target" ? { source: src } : { target: tgt }, at);
  gesture.value = { kind: "reconnect", edgeId, end };
  setLocked(true);
  updateOverlays();
}

function finishReconnect(nodeId: string) {
  if (gesture.value.kind !== "reconnect") return;
  const { edgeId, end } = gesture.value;
  const edge = props.mind.doc.value.edges.find((e) => e.id === edgeId);
  if (!edge) return cancelGesture();
  const sourceId = end === "source" ? nodeId : edge.source;
  const targetId = end === "target" ? nodeId : edge.target;
  if (validateNewEdge(props.mind.edges.value, sourceId, targetId, edgeId) !== null) return;
  removeGhost();
  clearAffordances();
  props.mind.reconnectEdge(edgeId, end, nodeId);
  gesture.value = { kind: "idle" };
  setLocked(props.tool !== "select");
  updateOverlays();
}

// ── create ───────────────────────────────────────────────────────────────────

async function createNodeAt(kind: "note" | "topic", pos: { x: number; y: number }) {
  const node = props.mind.addNode(kind, t("mind.untitled"), "", pos.x, pos.y);
  if (!node) return;
  emit("update:tool", "select");
  // The diff watcher adds the element on this tick's flush; select after it.
  await Promise.resolve();
  cy?.getElementById(node.id).select();
  // Straight into the edit modal — a fresh node exists to be named.
  props.mind.editNodeId.value = node.id;
}

// ── event wiring ─────────────────────────────────────────────────────────────

function hoverTarget(ele: cytoscape.NodeSingular, over: boolean) {
  const g = gesture.value;
  if (g.kind !== "connect-target" && g.kind !== "reconnect") return;
  if (ele.id() === GHOST_ID) return;
  ele.removeClass("connect-hover connect-invalid");
  if (!over) return;
  let rejection = null;
  if (g.kind === "connect-target") {
    rejection = validateNewEdge(props.mind.edges.value, g.sourceId, ele.id());
  } else {
    const edge = props.mind.doc.value.edges.find((e) => e.id === g.edgeId);
    if (!edge) return;
    const s = g.end === "source" ? ele.id() : edge.source;
    const tt = g.end === "target" ? ele.id() : edge.target;
    rejection = validateNewEdge(props.mind.edges.value, s, tt, g.edgeId);
  }
  ele.addClass(rejection === null ? "connect-hover" : "connect-invalid");
}

function onNodeTap(ele: cytoscape.NodeSingular, pos: { x: number; y: number }) {
  if (ele.id() === GHOST_ID) return;
  const g = gesture.value;
  if (props.tool === "add-note" || props.tool === "add-topic") return; // no accidental nodes on top of nodes
  if (g.kind === "connect-source") beginConnectTarget(ele.id(), pos);
  else if (g.kind === "connect-target") finishConnect(ele.id());
  else if (g.kind === "reconnect") finishReconnect(ele.id());
  // idle: cytoscape's own select handles it
}

function onBackgroundTap(pos: { x: number; y: number }) {
  const g = gesture.value;
  if (props.tool === "add-note" || props.tool === "add-topic") {
    void createNodeAt(props.tool === "add-topic" ? "topic" : "note", pos);
  } else if (g.kind === "connect-target") {
    removeGhost();
    clearAffordances();
    gesture.value = { kind: "connect-source" };
  } else if (g.kind === "reconnect") {
    cancelGesture();
  }
}

function wireEvents() {
  if (!cy) return;
  cy.on("select", "node, edge", (evt) => {
    const ele = evt.target as cytoscape.SingularElementArgument;
    props.mind.select({ kind: ele.isNode() ? "node" : "edge", id: ele.id() });
    updateOverlays();
  });
  cy.on("unselect", "node, edge", (evt) => {
    const sel = props.mind.selected.value;
    if (sel && sel.id === (evt.target as cytoscape.SingularElementArgument).id()) props.mind.select(null);
    updateOverlays();
  });
  cy.on("tap", (evt) => {
    if (evt.target === cy) onBackgroundTap(evt.position);
  });
  cy.on("tap", "node", (evt) => onNodeTap(evt.target as cytoscape.NodeSingular, evt.position));
  cy.on("dbltap", (evt) => {
    if (evt.target === cy && props.tool === "select" && gesture.value.kind === "idle") {
      void createNodeAt("note", evt.position);
    }
  });
  cy.on("dbltap", "node", (evt) => {
    if (props.tool === "select" && gesture.value.kind === "idle") {
      const id = (evt.target as cytoscape.NodeSingular).id();
      if (id !== GHOST_ID) props.mind.toggleCollapsed(id);
    }
  });
  cy.on("grab", "node", () => props.mind.beginNodeDrag());
  cy.on("dragfree", "node", (evt) => {
    const ele = evt.target as cytoscape.NodeSingular;
    if (ele.id() === GHOST_ID) return;
    const p = ele.position();
    props.mind.moveNode(ele.id(), p.x, p.y);
    props.mind.endNodeDrag();
    updateOverlays();
  });
  cy.on("mousemove", (evt) => ghostFollow(evt.position));
  cy.on("tapdrag", (evt) => ghostFollow(evt.position));
  cy.on("mouseover", "node", (evt) => hoverTarget(evt.target as cytoscape.NodeSingular, true));
  cy.on("mouseout", "node", (evt) => hoverTarget(evt.target as cytoscape.NodeSingular, false));
  cy.on("pan zoom resize", () => updateOverlays());
  cy.on("position", "node", () => updateOverlays());
}

// ── doc → cy diff sync ───────────────────────────────────────────────────────
// One watcher folds every document change into cytoscape, whoever caused it.
// O(V+E) per mutation; the caps keep that trivial. The ghost pair is excluded
// — it exists only in cy, never in the doc.

function syncFromDoc() {
  if (!cy) return;
  const nodes = props.mind.doc.value.nodes;
  const edges = props.mind.doc.value.edges;
  const hidden = computeHiddenNodes(nodes, edges);
  const counts = hiddenCounts(nodes, edges, hidden);

  cy.batch(() => {
    if (!cy) return;
    const keepNodes = new Set<string>();
    for (const n of nodes) {
      keepNodes.add(n.id);
      const ele = cy.getElementById(n.id);
      if (ele.length === 0) {
        cy.add({
          group: "nodes",
          data: { id: n.id, kind: n.kind, title: n.title, displayLabel: displayLabel(n, counts.get(n.id) ?? 0) },
          position: { x: n.x, y: n.y },
          classes: nodeClasses(n, hidden),
        });
        continue;
      }
      ele.data({ kind: n.kind, title: n.title, displayLabel: displayLabel(n, counts.get(n.id) ?? 0) });
      ele.toggleClass("topic", n.kind === "topic");
      ele.toggleClass("collapsed", n.collapsed);
      ele.toggleClass("hidden-collapsed", hidden.has(n.id));
      const p = ele.position();
      if (p.x !== n.x || p.y !== n.y) ele.position({ x: n.x, y: n.y });
    }
    cy.nodes().forEach((ele) => {
      if (!keepNodes.has(ele.id()) && ele.id() !== GHOST_ID) ele.remove();
    });

    const keepEdges = new Set<string>();
    for (const e of edges) {
      keepEdges.add(e.id);
      let ele = cy.getElementById(e.id);
      if (ele.length === 0) {
        cy.add({ group: "edges", data: { id: e.id, source: e.source, target: e.target, label: e.label } });
        continue;
      }
      if (ele.data("source") !== e.source || ele.data("target") !== e.target) {
        // Endpoints are immutable data — move() replaces the element.
        ele = ele.move({ source: e.source, target: e.target }) as cytoscape.CollectionReturnValue;
      }
      if (ele.data("label") !== e.label) ele.data("label", e.label);
    }
    cy.edges().forEach((ele) => {
      if (!keepEdges.has(ele.id()) && ele.id() !== GHOST_EDGE_ID) ele.remove();
    });
  });
  updateOverlays();
}

// ── layout / camera ──────────────────────────────────────────────────────────

function fitInitial() {
  if (!cy) return;
  if (cy.nodes().length === 0) {
    didInitialFit = true;
    return;
  }
  const w = wrapper.value;
  if (!w || !w.clientWidth || !w.clientHeight) return; // retried from the ResizeObserver
  cy.fit(cy.$(":visible"), 50);
  // A two-node map must not fill the screen with billboards.
  if (cy.zoom() > 1.25) {
    cy.zoom(1.25);
    cy.center();
  }
  didInitialFit = true;
}

function runAutoLayout(takeSnapshot: boolean) {
  if (!cy) return;
  const nodes = props.mind.doc.value.nodes;
  const edges = props.mind.doc.value.edges;
  if (!nodes.length) return;
  const hidden = computeHiddenNodes(nodes, edges);
  const rootIds = pickLayoutRoots(nodes, edges);

  // display:none nodes may be skipped by layouts: unhide inside a batch, run
  // the (synchronous, animate:false) layout, rehide — hidden descendants get
  // real positions and nothing intermediate ever paints.
  cy.startBatch();
  cy.nodes(".hidden-collapsed").removeClass("hidden-collapsed");
  cy.layout({
    name: "breadthfirst",
    directed: true,
    roots: rootIds,
    spacingFactor: 1.2,
    padding: 40,
    animate: false,
    fit: false,
  }).run();
  cy.nodes().forEach((ele) => {
    if (hidden.has(ele.id())) ele.addClass("hidden-collapsed");
  });
  cy.endBatch();

  const positions: Record<string, { x: number; y: number }> = {};
  cy.nodes().forEach((ele) => {
    if (ele.id() !== GHOST_ID) positions[ele.id()] = ele.position();
  });
  props.mind.applyLayout(positions, takeSnapshot);
  cy.fit(cy.$(":visible"), 40);
}

function autoLayout() {
  runAutoLayout(true);
}

function zoomFit() {
  cy?.fit(cy.$(":visible"), 40);
}

defineExpose({ autoLayout, zoomFit });

// ── keyboard (canvas-owned keys; the view owns undo/delete/Space/F2) ─────────

function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target && (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
  if (e.key === "Escape") {
    const g = gesture.value;
    if (g.kind === "connect-target") {
      e.preventDefault();
      removeGhost();
      clearAffordances();
      gesture.value = { kind: "connect-source" };
    } else if (g.kind === "reconnect") {
      e.preventDefault();
      cancelGesture();
    } else if (g.kind === "connect-source") {
      e.preventDefault();
      emit("update:tool", "select");
    } else if (props.mind.selected.value) {
      cy?.elements(":selected").unselect();
      props.mind.select(null);
      updateOverlays();
    }
  } else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    zoomFit();
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  if (!host.value) return;
  const nodes = props.mind.doc.value.nodes;
  cy = cytoscape({
    container: host.value,
    elements: docToElements(nodes, props.mind.doc.value.edges) as cytoscape.ElementDefinition[],
    style: buildStylesheet(readPalette(!!props.darkMode)),
    layout: { name: "preset" },
    wheelSensitivity: 0.2,
    minZoom: 0.1,
    maxZoom: 3,
    boxSelectionEnabled: false,
    selectionType: "single",
  });
  wireEvents();
  setLocked(props.tool !== "select");
  if (props.tool === "connect") gesture.value = { kind: "connect-source" };

  const vp = props.mind.getViewport();
  if (vp) {
    cy.viewport(vp);
    didInitialFit = true;
  } else {
    fitInitial();
  }
  if (needsMaterialization(nodes)) runAutoLayout(false);

  // The container can be 0-sized for a frame on tab switch — cytoscape renders
  // nothing into a 0-height div, silently. Resize + late first-fit cover it.
  // (jsdom has no ResizeObserver; tests exercise the sync path only.)
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      if (disposed || !cy) return;
      cy.resize();
      if (!didInitialFit) fitInitial();
    });
    if (wrapper.value) ro.observe(wrapper.value);
  }

  // Canvas labels are measured with whatever font is loaded at first paint;
  // remeasure once the app font arrives. (jsdom has no document.fonts.)
  document.fonts?.ready?.then(() => {
    if (!disposed) cy?.style().update();
  });

  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", onKey);
  if (ghostRaf !== null) cancelAnimationFrame(ghostRaf);
  ro?.disconnect();
  if (cy) {
    props.mind.setViewport({ zoom: cy.zoom(), pan: cy.pan() });
    cy.destroy();
    cy = null;
  }
});

watch(
  () => [props.mind.doc.value.nodes, props.mind.doc.value.edges] as const,
  () => syncFromDoc(),
);

watch(
  () => props.tool,
  (tool) => {
    removeGhost();
    clearAffordances();
    gesture.value = tool === "connect" ? { kind: "connect-source" } : { kind: "idle" };
    setLocked(tool !== "select");
    updateOverlays();
  },
);

watch(
  () => props.darkMode,
  (dark) => {
    cy?.style(buildStylesheet(readPalette(!!dark)));
  },
);

watch(
  () => props.mind.selected.value,
  () => updateOverlays(),
);

// The inspector's "move start / move end" buttons funnel through the singleton.
watch(
  () => props.mind.reconnectRequest.value,
  (req) => {
    if (!req) return;
    props.mind.reconnectRequest.value = null;
    emit("update:tool", "select");
    beginReconnect(req.edgeId, req.end);
  },
);
</script>

<template>
  <!-- min-h guards the canvas against flex collapse; the host is absolutely
       positioned so cytoscape always measures a real box (MapPanel pattern). -->
  <div
    ref="wrapper"
    :class="cursorClass"
    class="relative min-h-[24rem] flex-1 overflow-hidden rounded-xl bg-sunken-light dark:bg-sunken-dark"
  >
    <div ref="host" data-testid="mind-canvas" class="absolute inset-0 h-full w-full" />

    <!-- gesture hint -->
    <div
      v-if="hintKey"
      class="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-accent-2 bg-primary-bg-light px-3 py-1 text-xs opacity-90 dark:border-accent-1 dark:bg-primary-bg-dark"
    >
      {{ $t(hintKey) }}
    </div>

    <!-- reconnect endpoint handles on the selected edge -->
    <template v-if="handles">
      <button
        type="button"
        data-testid="mind-handle-source"
        :style="{ left: handles.sx + 'px', top: handles.sy + 'px' }"
        :title="$t('mind.changeSource')"
        class="absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent-2 bg-highlight transition hover:scale-125 dark:border-accent-1"
        @click="props.mind.selectedEdge.value && beginReconnect(props.mind.selectedEdge.value.id, 'source')"
      />
      <button
        type="button"
        data-testid="mind-handle-target"
        :style="{ left: handles.tx + 'px', top: handles.ty + 'px' }"
        :title="$t('mind.changeTarget')"
        class="absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent-2 bg-highlight transition hover:scale-125 dark:border-accent-1"
        @click="props.mind.selectedEdge.value && beginReconnect(props.mind.selectedEdge.value.id, 'target')"
      />
    </template>

    <!-- edit chip on the selected node -->
    <button
      v-if="editChip"
      type="button"
      data-testid="mind-edit-chip"
      :style="{ left: editChip.x + 'px', top: editChip.y + 'px' }"
      :title="$t('mind.editNode')"
      class="absolute z-10 -translate-y-full rounded-full border border-accent-2 bg-primary-bg-light px-2 py-0.5 text-xs font-bold transition hover:opacity-70 dark:border-accent-1 dark:bg-primary-bg-dark"
      @click="props.mind.editNodeId.value = editChip.nodeId"
    >
      <font-awesome-icon icon="pen" />
    </button>

    <!-- collapse chip on the selected node -->
    <button
      v-if="chip"
      type="button"
      data-testid="mind-collapse-chip"
      :style="{ left: chip.x + 'px', top: chip.y + 'px' }"
      :title="$t(chip.label === '⊖' ? 'mind.collapse' : 'mind.expand', { n: chip.label.replace(/\D/g, '') })"
      class="absolute z-10 -translate-y-full rounded-full border border-accent-2 bg-primary-bg-light px-2 py-0.5 text-xs font-bold transition hover:opacity-70 dark:border-accent-1 dark:bg-primary-bg-dark"
      @click="props.mind.toggleCollapsed(chip.nodeId)"
    >
      {{ chip.label }}
    </button>
  </div>
</template>
