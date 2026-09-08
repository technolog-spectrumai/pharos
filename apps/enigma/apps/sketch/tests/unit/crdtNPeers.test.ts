// The CRDT with more than two authors.
//
// Step 31 rests on a claim that has been asserted but never tested: the
// LWW-element-set converges for ANY number of peers, so going from two to N
// is a transport and admission problem, not a merge problem. These are the
// CRDT laws stated for three authors, driven directly against the model with
// no session and no transport in the way.
//
// If any of these fail, N-peer sync is not a matter of seating more people —
// the merge itself would need rethinking.
import { describe, expect, it } from "vitest";
import {
  clearAll,
  deleteShapes,
  emptyCrdt,
  liveShapes,
  mergeSnapshot,
  SKETCH_WIRE_V,
  upsertShape,
  type SketchCrdt,
  type WireShape,
} from "../../src/sketch/sketchCrdt";
import type { Shape } from "../../src/sketch/sketchModel";

function rect(id: string, x = 0): Shape {
  return { id, kind: "rect", color: "#000", sw: 2, opacity: 1, fill: null, rot: 0,
           x, y: 0, w: 10, h: 10 } as Shape;
}

function entry(id: string, author: string, at: number, x = 0): WireShape {
  return { shape: rect(id, x), meta: { author, createdAt: at, updatedAt: at } };
}

/** Apply ops to a fresh document, in the given order. */
function applyAll(ops: WireShape[]): SketchCrdt {
  const doc = emptyCrdt();
  for (const e of ops) upsertShape(doc, e);
  return doc;
}

function ids(doc: SketchCrdt): string[] {
  return liveShapes(doc).map((s) => s.id);
}

/** Every ordering of a small list — the point of a commutativity test. */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

describe("three authors on one board", () => {
  const a = entry("s-a", "alice", 100);
  const b = entry("s-b", "bob", 101);
  const c = entry("s-c", "carol", 102);

  it("converges whatever order the operations arrive in", () => {
    // Six orderings, one board. This is the property that makes N peers a
    // transport question: gossip gives no ordering guarantee between peers.
    const expected = ids(applyAll([a, b, c]));
    expect(expected).toEqual(["s-a", "s-b", "s-c"]);
    for (const order of permutations([a, b, c])) {
      expect(ids(applyAll(order)), order.map((e) => e.shape.id).join(",")).toEqual(expected);
    }
  });

  it("is idempotent — a redelivered op changes nothing", () => {
    // Gossip can deliver the same message twice; a board that grew a
    // duplicate shape would diverge from one that did not.
    const once = applyAll([a, b, c]);
    const twice = applyAll([a, b, c, a, b, c, b]);
    expect(ids(twice)).toEqual(ids(once));
  });

  it("resolves a three-way edit of ONE shape the same way everywhere", () => {
    // All three draw over the same id at the same logical time. The author
    // tiebreak has to be total, or two peers keep different winners forever.
    const same = (author: string, x: number): WireShape => ({
      shape: rect("contested", x),
      meta: { author, createdAt: 50, updatedAt: 50 },
    });
    const edits = [same("alice", 1), same("bob", 2), same("carol", 3)];
    const winners = permutations(edits).map((order) => {
      const doc = applyAll(order);
      return (liveShapes(doc)[0] as { x: number }).x;
    });
    expect(new Set(winners).size, "every ordering picks one winner").toBe(1);
    // Highest author id wins the tie: carol.
    expect(winners[0]).toBe(3);
  });

  it("lets one peer's delete outrank another's older draw, for everyone", () => {
    const doc1 = applyAll([a, b, c]);
    deleteShapes(doc1, ["s-b"], 200);
    // The same two facts, learned in the other order.
    const doc2 = emptyCrdt();
    deleteShapes(doc2, ["s-b"], 200);
    for (const e of [a, b, c]) upsertShape(doc2, e);
    expect(ids(doc2)).toEqual(ids(doc1));
    expect(ids(doc1)).toEqual(["s-a", "s-c"]);
  });

  it("lets a later redraw resurrect a shape a third peer erased", () => {
    // Undo across peers depends on this: a tombstone is outranked by a strictly
    // later stamp, not permanent.
    const doc = applyAll([a, b, c]);
    deleteShapes(doc, ["s-b"], 200);
    expect(ids(doc)).not.toContain("s-b");
    upsertShape(doc, { shape: rect("s-b", 9), meta: { author: "bob", createdAt: 101, updatedAt: 300 } });
    expect(ids(doc)).toContain("s-b");
  });

  it("voids everything older than a clear, from any peer", () => {
    const doc = applyAll([a, b, c]);
    clearAll(doc, 500);
    expect(ids(doc)).toEqual([]);
    // A late-arriving op from before the clear stays void — otherwise a slow
    // peer's backlog would repopulate a board everyone else sees as empty.
    upsertShape(doc, entry("s-late", "carol", 400));
    expect(ids(doc)).toEqual([]);
    // But work done after it lands normally.
    upsertShape(doc, entry("s-new", "alice", 600));
    expect(ids(doc)).toEqual(["s-new"]);
  });

  it("merges a third peer's snapshot without losing local work", () => {
    // A peer joining a board of three gets a snapshot from one of them while
    // the other two keep drawing. Merge, never replace.
    const mine = applyAll([a]);
    upsertShape(mine, entry("s-mine", "alice", 150));
    const changed = mergeSnapshot(mine, {
      v: SKETCH_WIRE_V,
      entries: [b, c],
      tombs: [],
      clearedAt: 0,
      truncated: false,
      width: 1920,
      height: 1080,
    });
    expect(changed).toBeGreaterThan(0);
    expect(ids(mine)).toEqual(["s-a", "s-b", "s-c", "s-mine"]);
  });
});
