import { describe, expect, it } from "vitest";
import {
  computeHiddenNodes,
  displayLabel,
  docToElements,
  hiddenCounts,
  needsMaterialization,
  nextNodePosition,
  nodeClasses,
  pickLayoutRoots,
  validateNewEdge,
} from "../../src/components/mind/mindGraphModel";
import type { MindEdge, MindNode } from "../../src/components/mind/mindModel";

// The collapse rule is the one piece of real graph theory in the feature:
// hidden iff unreachable except through a collapsed frontier. The matrix below
// is the design contract — chains, diamonds, cycles, self-cycles, nesting and
// cross-linked hubs each pin one clause of it.

function n(id: string, over: Partial<MindNode> = {}): MindNode {
  return { id, kind: "note", title: id, content: "", x: 0, y: 0, collapsed: false, ...over };
}

function e(source: string, target: string, id = `${source}->${target}`): MindEdge {
  return { id, source, target, label: "" };
}

function hiddenIds(nodes: MindNode[], edges: MindEdge[]): string[] {
  return [...computeHiddenNodes(nodes, edges)].sort();
}

describe("computeHiddenNodes", () => {
  it("no collapsed nodes ⇒ nothing hidden", () => {
    expect(hiddenIds([n("a"), n("b")], [e("a", "b")])).toEqual([]);
  });

  it("hides the outgoing chain below a collapsed node, not the node itself", () => {
    const nodes = [n("a", { collapsed: true }), n("b"), n("c")];
    expect(hiddenIds(nodes, [e("a", "b"), e("b", "c")])).toEqual(["b", "c"]);
  });

  it("does not hide UPSTREAM nodes (direction matters)", () => {
    const nodes = [n("p"), n("a", { collapsed: true }), n("b")];
    expect(hiddenIds(nodes, [e("p", "a"), e("a", "b")])).toEqual(["b"]);
  });

  it("diamond: a child stays visible while any expanded parent can reach it", () => {
    const nodes = [n("a", { collapsed: true }), n("t"), n("b")];
    const edges = [e("a", "b"), e("t", "b")];
    expect(hiddenIds(nodes, edges)).toEqual([]);
    // ...and vanishes once that other parent collapses too.
    const both = [n("a", { collapsed: true }), n("t", { collapsed: true }), n("b")];
    expect(hiddenIds(both, edges)).toEqual(["b"]);
  });

  it("a chain into the collapsed subtree from outside keeps that path visible", () => {
    // a(collapsed) → b → c ; outside → c : c stays reachable, b does not.
    const nodes = [n("a", { collapsed: true }), n("b"), n("c"), n("out")];
    const edges = [e("a", "b"), e("b", "c"), e("out", "c")];
    expect(hiddenIds(nodes, edges)).toEqual(["b"]);
  });

  it("cycle back to the collapsed root never hides the root", () => {
    const nodes = [n("a", { collapsed: true }), n("b")];
    expect(hiddenIds(nodes, [e("a", "b"), e("b", "a")])).toEqual(["b"]);
  });

  it("a cycle wholly inside the collapsed subtree stays hidden", () => {
    const nodes = [n("a", { collapsed: true }), n("b"), n("c")];
    expect(hiddenIds(nodes, [e("a", "b"), e("b", "c"), e("c", "b")])).toEqual(["b", "c"]);
  });

  it("nested collapse: expanding the outer root reveals the inner one still folded", () => {
    const inner = [n("c1"), n("c2", { collapsed: true }), n("d")];
    const edges = [e("c1", "c2"), e("c2", "d")];
    expect(hiddenIds(inner, edges)).toEqual(["d"]);
    const outer = [n("c1", { collapsed: true }), n("c2", { collapsed: true }), n("d")];
    expect(hiddenIds(outer, edges)).toEqual(["c2", "d"]);
  });

  it("cross-linked topic hubs: collapsing one hub never punches holes in the other", () => {
    // Two topics share a note; a second note hangs only under topic A.
    const nodes = [n("ta", { kind: "topic", collapsed: true }), n("tb", { kind: "topic" }), n("shared"), n("own")];
    const edges = [e("ta", "shared"), e("tb", "shared"), e("ta", "own")];
    expect(hiddenIds(nodes, edges)).toEqual(["own"]);
  });

  it("an isolated collapsed node hides nothing", () => {
    expect(hiddenIds([n("a", { collapsed: true }), n("b")], [])).toEqual([]);
  });
});

describe("hiddenCounts", () => {
  it("counts only the descendants that are actually hidden", () => {
    // a(collapsed) → b → c, out → c: c survives via `out`, so a hides 1.
    const nodes = [n("a", { collapsed: true }), n("b"), n("c"), n("out")];
    const edges = [e("a", "b"), e("b", "c"), e("out", "c")];
    const hidden = computeHiddenNodes(nodes, edges);
    expect(hiddenCounts(nodes, edges, hidden).get("a")).toBe(1);
  });

  it("overlapping hubs each report their own hidden share", () => {
    const nodes = [n("ta", { collapsed: true }), n("tb", { collapsed: true }), n("shared")];
    const edges = [e("ta", "shared"), e("tb", "shared")];
    const hidden = computeHiddenNodes(nodes, edges);
    const counts = hiddenCounts(nodes, edges, hidden);
    expect(counts.get("ta")).toBe(1);
    expect(counts.get("tb")).toBe(1);
  });
});

describe("displayLabel / classes / elements", () => {
  it("bakes the ⊕ badge into the label only when something is hidden", () => {
    expect(displayLabel(n("a", { title: "T", collapsed: true }), 3)).toBe("T  ⊕ 3");
    expect(displayLabel(n("a", { title: "T", collapsed: true }), 0)).toBe("T");
    expect(displayLabel(n("a", { title: "T" }), 3)).toBe("T");
  });

  it("nodeClasses composes topic/collapsed/hidden", () => {
    const hidden = new Set(["x"]);
    expect(nodeClasses(n("x", { kind: "topic", collapsed: true }), hidden)).toBe("topic collapsed hidden-collapsed");
    expect(nodeClasses(n("y"), hidden)).toBe("");
  });

  it("docToElements bakes positions, classes and labels", () => {
    const nodes = [n("a", { collapsed: true, x: 5, y: 6 }), n("b", { x: 1, y: 2 })];
    const edges = [e("a", "b")];
    const defs = docToElements(nodes, edges);
    expect(defs).toHaveLength(3);
    const a = defs.find((d) => d.data.id === "a")!;
    expect(a.position).toEqual({ x: 5, y: 6 });
    expect(a.classes).toContain("collapsed");
    expect(a.data.displayLabel).toBe("a  ⊕ 1");
    const b = defs.find((d) => d.data.id === "b")!;
    expect(b.classes).toContain("hidden-collapsed");
  });
});

describe("validateNewEdge", () => {
  const edges = [e("a", "b")];

  it("rejects self-loops and same-direction duplicates, allows the reverse", () => {
    expect(validateNewEdge(edges, "a", "a")).toBe("self");
    expect(validateNewEdge(edges, "a", "b")).toBe("duplicate");
    expect(validateNewEdge(edges, "b", "a")).toBeNull();
    expect(validateNewEdge(edges, "a", "c")).toBeNull();
  });

  it("ignores the edge being reconnected when checking duplicates", () => {
    // Reattaching a->b's target back onto b must not collide with itself.
    expect(validateNewEdge(edges, "a", "b", "a->b")).toBeNull();
  });
});

describe("pickLayoutRoots", () => {
  it("prefers all in-degree-0 nodes", () => {
    const nodes = [n("r1"), n("r2"), n("child")];
    expect(pickLayoutRoots(nodes, [e("r1", "child"), e("r2", "child")]).sort()).toEqual(["r1", "r2"]);
  });

  it("falls back to the max-out-degree node in a fully cyclic graph", () => {
    const nodes = [n("a"), n("b"), n("c")];
    const edges = [e("a", "b"), e("b", "a"), e("b", "c"), e("c", "b")];
    expect(pickLayoutRoots(nodes, edges)).toEqual(["b"]);
  });

  it("empty graph has no roots", () => {
    expect(pickLayoutRoots([], [])).toEqual([]);
  });
});

describe("needsMaterialization", () => {
  it("true only for a multi-node doc with every position at the origin", () => {
    expect(needsMaterialization([n("a"), n("b")])).toBe(true);
    expect(needsMaterialization([n("a"), n("b", { x: 10 })])).toBe(false);
    expect(needsMaterialization([n("a")])).toBe(false);
    expect(needsMaterialization([])).toBe(false);
  });
});

describe("nextNodePosition", () => {
  it("returns the centre when free", () => {
    expect(nextNodePosition({ x: 10, y: 10 }, [])).toEqual({ x: 10, y: 10 });
  });

  it("walks outward until clear of every taken spot", () => {
    const taken = [{ x: 0, y: 0 }];
    const p = nextNodePosition({ x: 0, y: 0 }, taken);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(60);
  });
});
