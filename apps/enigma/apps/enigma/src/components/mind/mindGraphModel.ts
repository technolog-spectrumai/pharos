// Mind canvas helpers — pure graph/geometry logic (no Vue/cytoscape imports).
// Everything with actual reasoning lives here so unit tests never need a
// canvas: MindGraph.vue stays a thin event-wiring shell.

import type { MindEdge, MindNode } from "./mindModel";

// ── collapse ──────────────────────────────────────────────────────────────────
// The collapsed flag lives on the node; VISIBILITY is derived, never stored.
//
// Rule: a node is hidden iff it is unreachable except through a collapsed
// frontier — NOT "hidden if any collapsed ancestor". Topic hubs are heavily
// cross-linked; the ancestor rule would punch holes in *other* expanded
// subtrees (a note under collapsed Topic A and expanded Topic B would vanish
// from B, leaving B's edge pointing at nothing). This rule keeps the invariant:
// collapsing X never hides anything you can still reach without X.

/** Outgoing-descendant ids of `rootId` (root excluded). The root is seeded as
 *  visited so a cycle back into it can never mark the root itself — a collapsed
 *  node must stay visible to be expandable. */
function descendants(rootId: string, outgoing: Map<string, string[]>): Set<string> {
  const visited = new Set<string>([rootId]);
  const out = new Set<string>();
  const stack = [...(outgoing.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    out.add(id);
    for (const next of outgoing.get(id) ?? []) stack.push(next);
  }
  return out;
}

function outgoingMap(edges: MindEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    const list = map.get(e.source);
    if (list) list.push(e.target);
    else map.set(e.source, [e.target]);
  }
  return map;
}

/** The set of node ids the canvas must hide. Two O(V+E) passes:
 *  1. candidates — everything below any collapsed node;
 *  2. visibility — flood from every non-candidate, flowing only through
 *     non-collapsed nodes. hidden = all − visible.
 *  Handles cycles (a cycle fully inside a collapsed subtree stays hidden;
 *  a cycle back to the collapsed root never hides the root) and nested
 *  collapses (expanding the outer root reveals the inner one still folded). */
export function computeHiddenNodes(nodes: MindNode[], edges: MindEdge[]): Set<string> {
  const collapsed = nodes.filter((n) => n.collapsed);
  if (!collapsed.length) return new Set();
  const outgoing = outgoingMap(edges);

  const candidates = new Set<string>();
  for (const c of collapsed) {
    for (const id of descendants(c.id, outgoing)) candidates.add(id);
  }

  const collapsedIds = new Set(collapsed.map((n) => n.id));
  const visible = new Set<string>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (!candidates.has(n.id)) {
      visible.add(n.id);
      queue.push(n.id);
    }
  }
  while (queue.length) {
    const id = queue.pop()!;
    if (collapsedIds.has(id)) continue; // a collapsed node's outgoing side is the frontier
    for (const next of outgoing.get(id) ?? []) {
      if (!visible.has(next)) {
        visible.add(next);
        queue.push(next);
      }
    }
  }

  const hidden = new Set<string>();
  for (const n of nodes) if (!visible.has(n.id)) hidden.add(n.id);
  return hidden;
}

/** Per collapsed node: how many of its descendants are actually hidden — the
 *  number on the ⊕ badge. Counts may overlap between two collapsed hubs that
 *  share descendants; that is honest ("N hidden below here"), not a bug. */
export function hiddenCounts(nodes: MindNode[], edges: MindEdge[], hidden: ReadonlySet<string>): Map<string, number> {
  const outgoing = outgoingMap(edges);
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (!n.collapsed) continue;
    let k = 0;
    for (const id of descendants(n.id, outgoing)) if (hidden.has(id)) k++;
    counts.set(n.id, k);
  }
  return counts;
}

// ── cytoscape elements ────────────────────────────────────────────────────────

/** The canvas label: the ⊕ badge is baked into a data field rather than a
 *  function-valued style, so the stylesheet stays static and this stays
 *  unit-testable. */
export function displayLabel(node: MindNode, hiddenCount: number): string {
  return node.collapsed && hiddenCount > 0 ? `${node.title}  ⊕ ${hiddenCount}` : node.title;
}

export interface CyElementDef {
  group: "nodes" | "edges";
  data: Record<string, unknown>;
  position?: { x: number; y: number };
  classes?: string;
}

export function nodeClasses(node: MindNode, hidden: ReadonlySet<string>): string {
  const cls: string[] = [];
  if (node.kind === "topic") cls.push("topic");
  if (node.collapsed) cls.push("collapsed");
  if (hidden.has(node.id)) cls.push("hidden-collapsed");
  return cls.join(" ");
}

/** Build the full element list for a cytoscape init/rebuild, positions baked in
 *  (preset layout). Edges need no visibility classes: cytoscape only renders an
 *  edge when both endpoints are visible, so boundary edges vanish for free. */
export function docToElements(nodes: MindNode[], edges: MindEdge[]): CyElementDef[] {
  const hidden = computeHiddenNodes(nodes, edges);
  const counts = hiddenCounts(nodes, edges, hidden);
  const defs: CyElementDef[] = nodes.map((n) => ({
    group: "nodes",
    data: {
      id: n.id,
      kind: n.kind,
      title: n.title,
      displayLabel: displayLabel(n, counts.get(n.id) ?? 0),
    },
    position: { x: n.x, y: n.y },
    classes: nodeClasses(n, hidden),
  }));
  for (const e of edges) {
    defs.push({ group: "edges", data: { id: e.id, source: e.source, target: e.target, label: e.label } });
  }
  return defs;
}

// ── interactive edge validation ───────────────────────────────────────────────
// The model validator allows parallel edges (an import may carry them); the
// EDITOR is stricter: a second same-direction edge between one pair is almost
// certainly a slip, so connect/reconnect refuse it. The reverse direction is
// legal — bezier bundling separates the two visually.

export type EdgeRejection = "self" | "duplicate" | null;

export function validateNewEdge(
  edges: MindEdge[],
  sourceId: string,
  targetId: string,
  ignoreEdgeId?: string,
): EdgeRejection {
  if (sourceId === targetId) return "self";
  for (const e of edges) {
    if (e.id === ignoreEdgeId) continue;
    if (e.source === sourceId && e.target === targetId) return "duplicate";
  }
  return null;
}

// ── layout helpers ────────────────────────────────────────────────────────────

/** Roots for the breadthfirst auto-layout: every in-degree-0 node; if the graph
 *  is fully cyclic, the single highest-out-degree node anchors it. */
export function pickLayoutRoots(nodes: MindNode[], edges: MindEdge[]): string[] {
  if (!nodes.length) return [];
  const inDeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const outDeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
  }
  const roots = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (roots.length) return roots;
  let best = nodes[0].id;
  for (const n of nodes) if ((outDeg.get(n.id) ?? 0) > (outDeg.get(best) ?? 0)) best = n.id;
  return [best];
}

/** A doc whose every node sits at the origin has never been arranged (typical
 *  of a hand-written import) — the canvas runs one auto-layout to materialize
 *  it, without an undo snapshot: that run is a rendering necessity, not an
 *  edit. */
export function needsMaterialization(nodes: MindNode[]): boolean {
  return nodes.length > 1 && nodes.every((n) => n.x === 0 && n.y === 0);
}

/** A free spot for a node created without a canvas position (dump links use
 *  their topic-relative slot instead): the viewport centre, nudged outward in
 *  a ring walk until nothing sits within `spacing`. */
export function nextNodePosition(
  center: { x: number; y: number },
  taken: { x: number; y: number }[],
  spacing = 60,
): { x: number; y: number } {
  const free = (x: number, y: number) => taken.every((p) => Math.hypot(p.x - x, p.y - y) >= spacing);
  if (free(center.x, center.y)) return { x: center.x, y: center.y };
  for (let ring = 1; ring < 40; ring++) {
    const r = ring * spacing;
    const steps = 8 * ring;
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      const x = center.x + r * Math.cos(a);
      const y = center.y + r * Math.sin(a);
      if (free(x, y)) return { x, y };
    }
  }
  return { x: center.x, y: center.y };
}
