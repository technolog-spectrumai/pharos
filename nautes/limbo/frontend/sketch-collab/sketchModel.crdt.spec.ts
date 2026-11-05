import { describe, expect, it } from "vitest";
import {
  arrowHead,
  clearAll,
  compareShapes,
  deleteShapes,
  distToShape,
  emptyDoc,
  gcTombstones,
  hitTest,
  makeClock,
  mergeSnapshot,
  pathD,
  scaleShape,
  shapeBounds,
  toSvg,
  translateShape,
  trianglePoints,
  truncateSnapshot,
  upsertShape,
  validateDoc,
  validateShape,
  validateSnapshot,
  validateStrokeDelta,
  type PathShape,
  type Shape,
  type SketchCaps,
  type SketchDoc,
  type SnapshotWire,
} from "../../src/components/sketch/sketchModel";

const CAPS: SketchCaps = { maxShapes: 1000, maxPointsPerStroke: 2000, maxTextLen: 200 };

function path(id: string, createdAt: number, pts: number[], author = "a"): PathShape {
  return {
    id,
    kind: "path",
    author,
    createdAt,
    updatedAt: createdAt,
    color: "#111827",
    sw: 4,
    opacity: 1,
    fill: null,
    pts,
  };
}

/** Same shape, edited at `updatedAt` — the LWW key. */
function edited(s: PathShape, updatedAt: number, pts?: number[]): PathShape {
  return { ...s, updatedAt, pts: pts ?? s.pts };
}

function snap(over: Partial<SnapshotWire> = {}): SnapshotWire {
  return {
    roomSlug: "room",
    v: 1,
    shapes: [],
    tombs: [],
    clearedAt: 0,
    truncated: false,
    fromName: "n",
    fromDevice: "d",
    ...over,
  };
}

/** Compare two docs by observable content, ignoring key order. */
function docShape(d: SketchDoc) {
  return {
    ids: d.shapes.map((s) => s.id),
    tombs: Object.entries(d.tombstones).sort(),
    clearedAt: d.clearedAt,
  };
}

describe("makeClock", () => {
  it("is strictly increasing even within the same millisecond", () => {
    const c = makeClock();
    const a = c.now();
    const b = c.now();
    const d = c.now();
    expect(b).toBeGreaterThan(a);
    expect(d).toBeGreaterThan(b);
  });

  it("never falls behind a timestamp observed from a peer", () => {
    const c = makeClock();
    const far = Date.now() + 5_000_000;
    c.observe(far);
    expect(c.now()).toBeGreaterThan(far);
  });

  it("ignores non-finite observations", () => {
    const c = makeClock();
    c.observe(Number.NaN);
    c.observe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(c.now())).toBe(true);
  });

  it("lets a slow-clocked peer still draw after a clear it has seen", () => {
    // The whole point of the HLC: without observe(), a shape stamped from a slow
    // wall clock would sort below clearedAt and be voided on every peer.
    const doc = emptyDoc();
    const clearedAt = Date.now() + 1_000_000;
    clearAll(doc, clearedAt);
    const slow = makeClock();
    slow.observe(clearedAt);
    expect(upsertShape(doc, path("s1", slow.now(), [0, 0, 1, 1]))).toBe(true);
  });
});

describe("CRDT laws", () => {
  const a = path("a", 100, [0, 0, 10, 10]);
  const b = path("b", 200, [5, 5, 15, 15]);
  const s1 = snap({ shapes: [a], clearedAt: 0 });
  const s2 = snap({ shapes: [b], tombs: [["a", 300]] });

  it("merge is idempotent", () => {
    const d1 = emptyDoc();
    mergeSnapshot(d1, s1);
    const once = docShape(d1);
    mergeSnapshot(d1, s1);
    mergeSnapshot(d1, s1);
    expect(docShape(d1)).toEqual(once);
  });

  it("merge is commutative — this is what makes unordered gossip safe", () => {
    const d1 = emptyDoc();
    mergeSnapshot(d1, s1);
    mergeSnapshot(d1, s2);

    const d2 = emptyDoc();
    mergeSnapshot(d2, s2);
    mergeSnapshot(d2, s1);

    expect(docShape(d1)).toEqual(docShape(d2));
  });

  it("merge is associative across three peers in any order", () => {
    const c = path("c", 250, [1, 1, 2, 2], "z");
    const s3 = snap({ shapes: [c] });
    const orders: SnapshotWire[][] = [
      [s1, s2, s3],
      [s3, s1, s2],
      [s2, s3, s1],
      [s3, s2, s1],
    ];
    const results = orders.map((order) => {
      const d = emptyDoc();
      for (const s of order) mergeSnapshot(d, s);
      return docShape(d);
    });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it("a snapshot is additive — it never deletes what it omits", () => {
    const doc = emptyDoc();
    upsertShape(doc, a);
    // An empty snapshot from a peer that just joined must not wipe our board.
    mergeSnapshot(doc, snap());
    expect(doc.shapes.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("last-write-wins upsert", () => {
  it("a newer edit replaces an older one, and an older edit is ignored", () => {
    const doc = emptyDoc();
    const v1 = path("x", 10, [0, 0, 1, 1]);
    expect(upsertShape(doc, v1)).toBe(true);
    expect(upsertShape(doc, edited(v1, 20, [0, 0, 9, 9]))).toBe(true);
    expect((doc.shapes[0] as PathShape).pts).toEqual([0, 0, 9, 9]);
    expect(upsertShape(doc, edited(v1, 15, [5, 5, 5, 5]))).toBe(false);
    expect((doc.shapes[0] as PathShape).pts).toEqual([0, 0, 9, 9]);
  });

  it("breaks a same-clock tie on author so both peers pick the same winner", () => {
    const d1 = emptyDoc();
    const lo = { ...path("x", 10, [1, 1, 1, 1], "aaa"), updatedAt: 50 };
    const hi = { ...path("x", 10, [2, 2, 2, 2], "zzz"), updatedAt: 50 };
    upsertShape(d1, lo);
    upsertShape(d1, hi);

    const d2 = emptyDoc();
    upsertShape(d2, hi);
    upsertShape(d2, lo);

    expect(d1.shapes[0].author).toBe("zzz");
    expect(d2.shapes[0].author).toBe("zzz");
  });

  it("keeps our createdAt so a remote edit can't rewrite paint order", () => {
    const doc = emptyDoc();
    upsertShape(doc, path("x", 10, [0, 0, 1, 1]));
    upsertShape(doc, { ...path("x", 999, [0, 0, 2, 2]), updatedAt: 20 });
    expect(doc.shapes[0].createdAt).toBe(10);
  });

  it("converges to deleted whether the delete arrives before or after the add", () => {
    const after = emptyDoc();
    upsertShape(after, path("x", 10, [0, 0, 1, 1]));
    deleteShapes(after, ["x"], 20);

    const before = emptyDoc();
    deleteShapes(before, ["x"], 20);
    upsertShape(before, path("x", 10, [0, 0, 1, 1]));

    expect(after.shapes).toHaveLength(0);
    expect(before.shapes).toHaveLength(0);
    expect(docShape(after)).toEqual(docShape(before));
  });

  it("resurrects a deleted shape when the upsert is newer — this is how undo works", () => {
    const doc = emptyDoc();
    const s = path("x", 10, [0, 0, 1, 1]);
    upsertShape(doc, s);
    deleteShapes(doc, ["x"], 20);
    expect(doc.shapes).toHaveLength(0);
    // Undo re-stamps the shape later than the tombstone.
    expect(upsertShape(doc, edited(s, 30))).toBe(true);
    expect(doc.shapes).toHaveLength(1);
    expect(doc.tombstones.x).toBeUndefined();
  });

  it("lets a delete win a same-clock tie against an upsert", () => {
    const doc = emptyDoc();
    deleteShapes(doc, ["x"], 20);
    expect(upsertShape(doc, edited(path("x", 10, [0, 0, 1, 1]), 20))).toBe(false);
  });

  it("max-merges deletedAt so concurrent erasers converge", () => {
    const d1 = emptyDoc();
    deleteShapes(d1, ["x"], 50);
    deleteShapes(d1, ["x"], 30);

    const d2 = emptyDoc();
    deleteShapes(d2, ["x"], 30);
    deleteShapes(d2, ["x"], 50);

    expect(d1.tombstones.x).toBe(50);
    expect(d2.tombstones.x).toBe(50);
  });

  it("erases many shapes in one batch", () => {
    const doc = emptyDoc();
    for (let i = 0; i < 5; i++) upsertShape(doc, path(`s${i}`, 10 + i, [0, 0, 1, 1]));
    expect(deleteShapes(doc, ["s1", "s3"], 100)).toBe(4); // 2 tombstones + 2 removals
    expect(doc.shapes.map((s) => s.id)).toEqual(["s0", "s2", "s4"]);
  });
});

describe("clearAll", () => {
  it("voids only shapes at or before the cutoff", () => {
    const doc = emptyDoc();
    upsertShape(doc, path("old", 100, [0, 0, 1, 1]));
    clearAll(doc, 150);
    expect(doc.shapes).toHaveLength(0);
    expect(upsertShape(doc, path("older", 120, [0, 0, 1, 1]))).toBe(false);
    expect(upsertShape(doc, path("newer", 160, [0, 0, 1, 1]))).toBe(true);
  });

  it("is a grow-only max register — a stale clear is ignored", () => {
    const doc = emptyDoc();
    expect(clearAll(doc, 200)).toBe(true);
    expect(clearAll(doc, 100)).toBe(false);
    expect(clearAll(doc, 200)).toBe(false);
    expect(doc.clearedAt).toBe(200);
  });

  it("drops tombstones wholesale (they all predate the clear)", () => {
    const doc = emptyDoc();
    deleteShapes(doc, ["a", "b"], 50);
    clearAll(doc, 100);
    expect(doc.tombstones).toEqual({});
  });
});

describe("ordering", () => {
  it("gives every peer the same total order regardless of insertion order", () => {
    const shapes: Shape[] = [
      path("c", 100, [0, 0, 1, 1], "b"),
      path("a", 100, [0, 0, 1, 1], "a"),
      path("b", 50, [0, 0, 1, 1], "z"),
    ];
    const d1 = emptyDoc();
    for (const s of shapes) upsertShape(d1, s);
    const d2 = emptyDoc();
    for (const s of [...shapes].reverse()) upsertShape(d2, s);
    expect(d1.shapes.map((s) => s.id)).toEqual(d2.shapes.map((s) => s.id));
    // createdAt first, then author, then id.
    expect(d1.shapes.map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("compareShapes is a consistent total order", () => {
    const x = path("x", 1, [0, 0], "a");
    const y = path("y", 1, [0, 0], "a");
    expect(compareShapes(x, y)).toBeLessThan(0);
    expect(compareShapes(y, x)).toBeGreaterThan(0);
    expect(compareShapes(x, x)).toBe(0);
  });
});

describe("pathD", () => {
  it("handles empty, single, and two-point strokes", () => {
    expect(pathD([])).toBe("");
    expect(pathD([5, 5])).toContain("M5 5");
    expect(pathD([0, 0, 10, 10])).toBe("M0 0L10 10");
  });

  it("is append-safe: extending a stroke never rewrites drawn geometry", () => {
    // This is why midpoint-quadratic was chosen over Catmull-Rom — a live stroke
    // is re-serialized on every delta and must not visually shift.
    const base = [0, 0, 10, 10, 20, 0, 30, 10];
    const grown = [...base, 40, 0];
    const a = pathD(base);
    const b = pathD(grown);
    // Everything up to the final straight-line tail of `a` is a prefix of `b`.
    const stable = a.slice(0, a.lastIndexOf("L"));
    expect(b.startsWith(stable)).toBe(true);
  });
});

describe("hitTest", () => {
  it("hits within sw/2 + radius and misses outside", () => {
    const s = path("s", 1, [0, 0, 100, 0]); // sw 4 => tol 2 + radius
    expect(hitTest([s], 50, 3, 2)).toBe("s");
    expect(hitTest([s], 50, 20, 2)).toBeNull();
  });

  it("returns the topmost of two overlapping shapes", () => {
    const doc = emptyDoc();
    upsertShape(doc, path("under", 10, [0, 0, 100, 0]));
    upsertShape(doc, path("over", 20, [0, 0, 100, 0]));
    expect(hitTest(doc.shapes, 50, 0, 2)).toBe("over");
  });

  it("hits a rect outline but not its hollow interior", () => {
    const r: Shape = { id: "r", kind: "rect", author: "a", createdAt: 1, updatedAt: 1, color: "#111827", sw: 2, opacity: 1, fill: null, x: 0, y: 0, w: 100, h: 100 };
    expect(hitTest([r], 0, 50, 2)).toBe("r"); // on the left edge
    expect(hitTest([r], 50, 50, 2)).toBeNull(); // dead centre
  });

  it("hits inside a text box", () => {
    const t: Shape = { id: "t", kind: "text", author: "a", createdAt: 1, updatedAt: 1, color: "#111827", sw: 2, opacity: 1, fill: null, x: 10, y: 100, text: "hi", size: 24, tw: 40, th: 24 };
    expect(hitTest([t], 20, 95, 0)).toBe("t");
    expect(hitTest([t], 300, 95, 0)).toBeNull();
  });

  it("returns null on an empty board", () => {
    expect(hitTest([], 0, 0, 10)).toBeNull();
  });

  it("measures an ellipse against its ring, not its interior", () => {
    const e: Shape = { id: "e", kind: "ellipse", author: "a", createdAt: 1, updatedAt: 1, color: "#111827", sw: 2, opacity: 1, fill: null, cx: 100, cy: 100, rx: 50, ry: 50 };
    expect(distToShape(e, 150, 100)).toBeCloseTo(0, 5); // on the ring
    expect(distToShape(e, 100, 100)).toBeGreaterThan(10); // centre is far from the ring
  });
});

describe("transforms", () => {
  it("translate moves every kind and never mutates the input", () => {
    const p = path("p", 1, [0, 0, 10, 10]);
    const moved = translateShape(p, 5, -3);
    expect(moved.pts).toEqual([5, -3, 15, 7]);
    expect(p.pts).toEqual([0, 0, 10, 10]); // untouched

    const r = { ...path("r", 1, []), kind: "rect" as const, x: 10, y: 10, w: 20, h: 30 } as Shape;
    expect(shapeBounds(translateShape(r, 5, 5))).toMatchObject({ x: 15, y: 15 });

    const a = { ...path("a", 1, []), kind: "arrow" as const, x1: 0, y1: 0, x2: 10, y2: 10 } as Shape;
    const am = translateShape(a, 2, 2) as Extract<Shape, { kind: "arrow" }>;
    expect([am.x1, am.y1, am.x2, am.y2]).toEqual([2, 2, 12, 12]);
  });

  it("scale about an origin keeps that origin fixed", () => {
    const p = path("p", 1, [0, 0, 10, 0]);
    const s = scaleShape(p, 0, 0, 2, 2);
    expect(s.pts).toEqual([0, 0, 20, 0]);
  });

  it("scaling text scales its font and its measured box together", () => {
    const t = {
      ...path("t", 1, []),
      kind: "text" as const,
      x: 0,
      y: 0,
      text: "hi",
      size: 20,
      tw: 40,
      th: 20,
    } as Shape;
    const s = scaleShape(t, 0, 0, 2, 2) as Extract<Shape, { kind: "text" }>;
    expect(s.size).toBe(40);
    expect(s.tw).toBe(80);
    expect(s.th).toBe(40);
  });

  it("bounds cover every kind", () => {
    expect(shapeBounds(path("p", 1, [0, 0, 10, 20]))).toEqual({ x: 0, y: 0, w: 10, h: 20 });
    const e = { ...path("e", 1, []), kind: "ellipse" as const, cx: 50, cy: 50, rx: 10, ry: 5 } as Shape;
    expect(shapeBounds(e)).toEqual({ x: 40, y: 45, w: 20, h: 10 });
  });
});

describe("triangle and arrow", () => {
  const tri = {
    ...path("t", 1, []),
    kind: "triangle" as const,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  } as Shape;

  it("inscribes a triangle in its box: apex top-centre, base at the bottom", () => {
    expect(trianglePoints(tri as Extract<Shape, { kind: "triangle" }>)).toEqual([
      [50, 0],
      [100, 100],
      [0, 100],
    ]);
  });

  it("hits a triangle's edge but not its hollow interior", () => {
    expect(hitTest([tri], 50, 100, 2)).toBe("t"); // on the base
    expect(hitTest([tri], 50, 60, 2)).toBeNull(); // inside, unfilled
  });

  it("hits anywhere inside once filled", () => {
    const filled = { ...tri, fill: "#3b82f6" } as Shape;
    expect(hitTest([filled], 50, 60, 2)).toBe("t");
  });

  it("puts the arrow head at the far end and hits along the shaft", () => {
    const a = { ...path("a", 1, []), kind: "arrow" as const, x1: 0, y1: 0, x2: 100, y2: 0 } as Shape;
    const head = arrowHead(a as Extract<Shape, { kind: "arrow" }>);
    expect(head[0]).toEqual([100, 0]);
    expect(hitTest([a], 50, 0, 2)).toBe("a");
    expect(hitTest([a], 50, 40, 2)).toBeNull();
  });

  it("keeps the arrow head inside a very short shaft", () => {
    const a = { ...path("a", 1, []), kind: "arrow" as const, x1: 0, y1: 0, x2: 4, y2: 0 } as Shape;
    const head = arrowHead(a as Extract<Shape, { kind: "arrow" }>);
    for (const [hx] of head) expect(hx).toBeGreaterThanOrEqual(0);
  });
});

describe("fill and opacity", () => {
  it("an undefined fill reads as unfilled, not as a solid hit box", () => {
    // Shapes from an older peer have no `fill` at all.
    const legacy = { ...path("r", 1, []), kind: "rect" as const, x: 0, y: 0, w: 100, h: 100 } as Shape;
    delete (legacy as unknown as Record<string, unknown>).fill;
    expect(hitTest([legacy], 50, 50, 2)).toBeNull();
  });

  it("round-trips fill and opacity through validation", () => {
    const v = validateShape(
      { ...path("r", 1, []), kind: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#ff0000", opacity: 0.5 },
      CAPS,
    );
    expect(v?.fill).toBe("#ff0000");
    expect(v?.opacity).toBe(0.5);
  });

  it("defaults a missing or out-of-range opacity to fully opaque", () => {
    const base = { ...path("p", 1, [0, 0, 1, 1]) } as Record<string, unknown>;
    delete base.opacity;
    expect(validateShape(base, CAPS)?.opacity).toBe(1);
    expect(validateShape({ ...base, opacity: 0 }, CAPS)?.opacity).toBe(1);
    expect(validateShape({ ...base, opacity: 5 }, CAPS)?.opacity).toBe(1);
  });

  it("rejects a malformed fill rather than trusting it into the SVG", () => {
    const v = validateShape(
      { ...path("r", 1, []), kind: "rect", x: 0, y: 0, w: 10, h: 10, fill: 'red" onload="x' },
      CAPS,
    );
    expect(v?.fill).toBeNull();
  });
});

describe("validation", () => {
  const good = path("s", 5, [0, 0, 10, 10]);

  it("accepts a well-formed shape", () => {
    expect(validateShape({ ...good }, CAPS)).not.toBeNull();
  });

  it("rejects non-finite and absurd coordinates", () => {
    expect(validateShape({ ...good, pts: [0, 0, Number.NaN, 1] }, CAPS)).toBeNull();
    expect(validateShape({ ...good, pts: [0, 0, Number.POSITIVE_INFINITY, 1] }, CAPS)).toBeNull();
    expect(validateShape({ ...good, pts: [0, 0, 1e300, 1] }, CAPS)).toBeNull();
  });

  it("rejects malformed point arrays", () => {
    expect(validateShape({ ...good, pts: [0, 0, 1] }, CAPS)).toBeNull(); // odd length
    expect(validateShape({ ...good, pts: [] }, CAPS)).toBeNull();
    const tooMany = new Array(2 * CAPS.maxPointsPerStroke + 2).fill(1);
    expect(validateShape({ ...good, pts: tooMany }, CAPS)).toBeNull();
  });

  it("rejects a bad colour, width, kind, or missing id", () => {
    expect(validateShape({ ...good, color: "red" }, CAPS)).toBeNull();
    expect(validateShape({ ...good, color: "#fff" }, CAPS)).toBeNull();
    expect(validateShape({ ...good, sw: 0 }, CAPS)).toBeNull();
    expect(validateShape({ ...good, sw: 500 }, CAPS)).toBeNull();
    expect(validateShape({ ...good, kind: "polygon" }, CAPS)).toBeNull();
    expect(validateShape({ ...good, id: "" }, CAPS)).toBeNull();
  });

  it("truncates over-long text rather than dropping the shape", () => {
    const v = validateShape(
      { id: "t", kind: "text", author: "a", createdAt: 1, updatedAt: 1, color: "#111827", sw: 2, opacity: 1, fill: null, x: 0, y: 0, text: "z".repeat(1000), size: 16, tw: 10, th: 10 },
      CAPS,
    );
    expect(v?.kind).toBe("text");
    expect((v as { text: string }).text).toHaveLength(CAPS.maxTextLen);
  });

  it("never returns the input object itself (no spread of untrusted data)", () => {
    const evil = { ...good, __proto__: { polluted: true }, extra: "ignored" };
    const v = validateShape(evil, CAPS);
    expect(v).not.toBe(evil);
    expect((v as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it("validates stroke deltas and rejects a negative or oversized offset", () => {
    const base = { roomSlug: "r", strokeId: "s", from: 0, pts: [1, 2], color: "#111827", sw: 4, fromName: "n", fromDevice: "d" };
    expect(validateStrokeDelta(base, CAPS)).not.toBeNull();
    expect(validateStrokeDelta({ ...base, from: -1 }, CAPS)).toBeNull();
    expect(validateStrokeDelta({ ...base, from: 1.5 }, CAPS)).toBeNull();
    expect(validateStrokeDelta({ ...base, pts: [1] }, CAPS)).toBeNull();
  });

  it("skips bad shapes inside a snapshot instead of dropping the whole thing", () => {
    const v = validateSnapshot(
      snap({ shapes: [good as Shape, { junk: true } as unknown as Shape] }),
      CAPS,
    );
    expect(v?.shapes).toHaveLength(1);
  });

  it("rejects a snapshot with more shapes than the cap", () => {
    const many = new Array(CAPS.maxShapes + 1).fill(good);
    expect(validateSnapshot(snap({ shapes: many as Shape[] }), CAPS)).toBeNull();
  });

  it("re-validates a stored doc and drops cleared/tombstoned entries", () => {
    const stored = {
      v: 1,
      shapes: [path("keep", 200, [0, 0, 1, 1]), path("old", 50, [0, 0, 1, 1]), path("gone", 300, [0, 0, 1, 1])],
      tombstones: { gone: 400 },
      clearedAt: 100,
    };
    const doc = validateDoc(stored, CAPS);
    expect(doc?.shapes.map((s) => s.id)).toEqual(["keep"]);
  });
});

describe("gcTombstones", () => {
  it("keeps the most recent and drops the oldest", () => {
    const doc = emptyDoc();
    for (let i = 0; i < 20; i++) doc.tombstones[`t${i}`] = i;
    expect(gcTombstones(doc, 5)).toBe(15);
    expect(Object.keys(doc.tombstones).sort()).toEqual(["t15", "t16", "t17", "t18", "t19"]);
  });

  it("is a no-op below the cap", () => {
    const doc = emptyDoc();
    doc.tombstones.a = 1;
    expect(gcTombstones(doc, 100)).toBe(0);
  });
});

describe("truncateSnapshot", () => {
  it("drops oldest-first until it fits and flags truncation", () => {
    const shapes = Array.from({ length: 200 }, (_, i) => path(`s${i}`, i, [0, 0, 10, 10]));
    const out = truncateSnapshot(shapes, [], 0, 2000);
    expect(out.truncated).toBe(true);
    expect(JSON.stringify({ shapes: out.shapes, tombs: [], clearedAt: 0 }).length).toBeLessThanOrEqual(2000);
    // The newest survive — a joiner most needs recent work.
    expect(out.shapes[out.shapes.length - 1].id).toBe("s199");
  });

  it("leaves a small snapshot untouched", () => {
    const shapes = [path("a", 1, [0, 0, 1, 1])];
    const out = truncateSnapshot(shapes, [], 0, 1_000_000);
    expect(out.truncated).toBe(false);
    expect(out.shapes).toHaveLength(1);
  });
});

describe("toSvg", () => {
  it("emits explicit width/height so it rasterizes in WebKit", () => {
    const svg = toSvg(emptyDoc());
    expect(svg).toContain('width="1920"');
    expect(svg).toContain('height="1080"');
    expect(svg).toContain('viewBox="0 0 1920 1080"');
  });

  it("escapes peer-supplied text — it lands in a file on this user's disk", () => {
    const doc = emptyDoc();
    upsertShape(doc, {
      id: "t",
      kind: "text",
      author: "a",
      createdAt: 10,
      updatedAt: 10,
      color: "#111827",
      sw: 2,
      opacity: 1,
      fill: null,
      x: 0,
      y: 0,
      text: '</text><script>alert("x")</script>',
      size: 16,
      tw: 10,
      th: 10,
    });
    const svg = toSvg(doc);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;/text&gt;");
  });

  it("omits cleared and tombstoned shapes", () => {
    const doc = emptyDoc();
    upsertShape(doc, path("keep", 100, [0, 0, 10, 10]));
    upsertShape(doc, path("drop", 110, [0, 0, 10, 10]));
    deleteShapes(doc, ["drop"], 120);
    const svg = toSvg(doc);
    expect(svg.match(/<path/g)).toHaveLength(1);
  });
});
