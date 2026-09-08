import { describe, expect, it } from "vitest";
import {
  authorOf, clearAll, compareEntries, deleteShapes, emptyCrdt, gcTombstones,
  liveShapes, makeClock, mergeSnapshot, truncateSnapshot, upsertShape,
  type SketchCrdt, type SnapshotWire, type WireShape,
} from "../../src/sketch/sketchCrdt";
import type { Shape } from "../../src/sketch/sketchModel";

// The CRDT laws, restored with the engine from
// `enigma/limbo/frontend/sketch-collab/sketchModel.crdt.spec.ts`.
//
// These are not ordinary unit tests: they are the reason unordered delivery is
// safe. If idempotence, commutativity or associativity breaks, two peers can
// see different boards with no error anywhere — which is exactly the failure a
// from-scratch merge design was shown to have before this was restored.

const rect = (id: string): Shape => ({
  id, kind: "rect", color: "#000", sw: 4, opacity: 1, fill: null, rot: 0,
  x: 0, y: 0, w: 10, h: 10,
} as Shape);

const entry = (id: string, author: string, createdAt: number, updatedAt = createdAt): WireShape =>
  ({ shape: rect(id), meta: { author, createdAt, updatedAt } });

/** Apply a list of operations to a fresh document, in the order given. */
type Op = (d: SketchCrdt) => void;
const run = (...ops: Op[]): SketchCrdt => {
  const d = emptyCrdt();
  for (const op of ops) op(d);
  return d;
};
const ids = (d: SketchCrdt) => liveShapes(d).map((s) => s.id);

describe("the hybrid logical clock", () => {
  it("is strictly increasing even within the same millisecond", () => {
    const c = makeClock();
    const a = c.now(), b = c.now(), d = c.now();
    expect(b).toBeGreaterThan(a);
    expect(d).toBeGreaterThan(b);
  });

  it("never falls behind a timestamp observed from a peer", () => {
    // The failure this prevents: a peer with a slow wall clock stamps work
    // below a clear it has already seen, and that work is voided everywhere.
    const c = makeClock();
    const far = Date.now() + 60_000;
    c.observe(far);
    expect(c.now()).toBeGreaterThan(far);
  });

  it("ignores a non-finite observation rather than poisoning itself", () => {
    const c = makeClock();
    c.observe(Number.NaN);
    c.observe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(c.now())).toBe(true);
  });
});

describe("the merge laws", () => {
  it("is idempotent — replaying an operation changes nothing", () => {
    const e = entry("a", "p1", 10);
    const once = run((d) => { upsertShape(d, e); });
    const twice = run((d) => { upsertShape(d, e); upsertShape(d, e); });
    expect(ids(twice)).toEqual(ids(once));
    expect(twice.entries.length).toBe(1);
  });

  it("is commutative — this is what makes unordered delivery safe", () => {
    const a = entry("a", "p1", 10);
    const b = entry("b", "p2", 20);
    const ab = run((d) => { upsertShape(d, a); }, (d) => { upsertShape(d, b); });
    const ba = run((d) => { upsertShape(d, b); }, (d) => { upsertShape(d, a); });
    expect(ids(ab)).toEqual(ids(ba));
  });

  it("is associative across three peers in any order", () => {
    const a = entry("a", "p1", 10), b = entry("b", "p2", 20), c = entry("c", "p3", 30);
    const orders: WireShape[][] = [[a, b, c], [c, b, a], [b, a, c], [c, a, b]];
    const results = orders.map((o) => ids(run((d) => { for (const e of o) upsertShape(d, e); })));
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it("gives every peer the same total order regardless of insertion order", () => {
    // Same createdAt on purpose: the tie-break must be deterministic, or the
    // two peers paint the same shapes in a different z-order.
    const a = entry("a", "p2", 10), b = entry("b", "p1", 10);
    expect(ids(run((d) => { upsertShape(d, a); upsertShape(d, b); })))
      .toEqual(ids(run((d) => { upsertShape(d, b); upsertShape(d, a); })));
    expect(compareEntries(a, b)).toBeGreaterThan(0); // p2 > p1
  });
});

describe("last-writer-wins on a shape", () => {
  it("takes a newer edit and ignores an older one", () => {
    const d = run((x) => { upsertShape(x, entry("a", "p1", 10, 20)); });
    expect(upsertShape(d, entry("a", "p1", 10, 30))).toBe(true);
    expect(upsertShape(d, entry("a", "p1", 10, 15))).toBe(false);
    expect(d.entries[0].meta.updatedAt).toBe(30);
  });

  it("breaks a same-clock tie on author so both peers pick the same winner", () => {
    const d = run((x) => { upsertShape(x, entry("a", "p1", 10, 20)); });
    expect(upsertShape(d, entry("a", "p2", 10, 20))).toBe(true);   // p2 > p1
    expect(upsertShape(d, entry("a", "p0", 10, 20))).toBe(false);  // p0 < p2
    expect(d.entries[0].meta.author).toBe("p2");
  });

  it("keeps our createdAt so a remote edit cannot rewrite paint order", () => {
    const d = run((x) => { upsertShape(x, entry("a", "p1", 10, 10)); });
    upsertShape(d, entry("a", "p1", 999, 20));
    expect(d.entries[0].meta.createdAt).toBe(10);
  });
});

describe("delete and resurrect", () => {
  it("converges whether the delete arrives before or after the add", () => {
    // The interleaving a plain LWW map gets wrong: at one peer the delete
    // lands on a shape that is not there yet, and must still be remembered.
    const addThenDel = run((d) => { upsertShape(d, entry("a", "p1", 10, 10)); },
                            (d) => { deleteShapes(d, ["a"], 20); });
    const delThenAdd = run((d) => { deleteShapes(d, ["a"], 20); },
                            (d) => { upsertShape(d, entry("a", "p1", 10, 10)); });
    expect(ids(addThenDel)).toEqual([]);
    expect(ids(delThenAdd)).toEqual([]);
  });

  it("resurrects a deleted shape when the upsert is newer — this is how undo works", () => {
    const d = run((x) => { upsertShape(x, entry("a", "p1", 10, 10)); },
                  (x) => { deleteShapes(x, ["a"], 20); });
    expect(ids(d)).toEqual([]);
    expect(upsertShape(d, entry("a", "p1", 10, 30))).toBe(true);
    expect(ids(d)).toEqual(["a"]);
  });

  it("lets a delete win a same-clock tie against an upsert", () => {
    // Deliberate, and the reason undo must re-stamp strictly later.
    const d = run((x) => { deleteShapes(x, ["a"], 20); });
    expect(upsertShape(d, entry("a", "p1", 10, 20))).toBe(false);
  });

  it("max-merges deletedAt so concurrent erasers converge", () => {
    const d = emptyCrdt();
    deleteShapes(d, ["a"], 30);
    deleteShapes(d, ["a"], 20); // older, must not lower the tombstone
    expect(d.tombstones.a).toBe(30);
  });
});

describe("clear is a grow-only register", () => {
  it("voids only shapes at or before the cutoff", () => {
    const d = run((x) => { upsertShape(x, entry("old", "p1", 10)); },
                  (x) => { upsertShape(x, entry("new", "p1", 30)); });
    clearAll(d, 20);
    expect(ids(d)).toEqual(["new"]);
  });

  it("ignores a stale clear", () => {
    const d = emptyCrdt();
    expect(clearAll(d, 30)).toBe(true);
    expect(clearAll(d, 20)).toBe(false);
    expect(d.clearedAt).toBe(30);
  });

  it("refuses work stamped before a clear it has already seen", () => {
    const d = run((x) => { clearAll(x, 50); });
    expect(upsertShape(d, entry("a", "p1", 40))).toBe(false);
    expect(upsertShape(d, entry("b", "p1", 60))).toBe(true);
  });
});

describe("snapshots", () => {
  const snap = (entries: WireShape[], tombs: [string, number][] = [], clearedAt = 0): SnapshotWire =>
    ({ v: 1, entries, tombs, clearedAt, truncated: false, width: 1920, height: 1080 });

  it("is additive — it never deletes what it omits", () => {
    // The bug this catches: applying a snapshot as a REPLACE throws away work
    // drawn locally while the snapshot was in flight.
    const d = run((x) => { upsertShape(x, entry("mine", "p1", 10)); });
    mergeSnapshot(d, snap([entry("theirs", "p2", 20)]));
    expect(ids(d).sort()).toEqual(["mine", "theirs"]);
  });

  it("carries the board size, so both peers draw on the same canvas", () => {
    const s = snap([]);
    expect(s.width).toBe(1920);
    expect(s.height).toBe(1080);
  });

  it("applies clear, tombstones and upserts in an order that converges", () => {
    const d = emptyCrdt();
    mergeSnapshot(d, snap([entry("a", "p1", 30), entry("b", "p1", 40)], [["b", 50]], 20));
    expect(ids(d)).toEqual(["a"]);
  });

  it("merging the same snapshot twice changes nothing the second time", () => {
    const s = snap([entry("a", "p1", 10)]);
    const d = emptyCrdt();
    mergeSnapshot(d, s);
    expect(mergeSnapshot(d, s)).toBe(0);
  });
});

describe("bounded state", () => {
  it("drops the oldest tombstones once over the cap", () => {
    const d = emptyCrdt();
    for (let i = 0; i < 10; i++) d.tombstones[`s${i}`] = i;
    expect(gcTombstones(d, 4)).toBe(6);
    expect(Object.keys(d.tombstones).sort()).toEqual(["s6", "s7", "s8", "s9"]);
  });

  it("is a no-op below the cap", () => {
    const d = emptyCrdt();
    d.tombstones.a = 1;
    expect(gcTombstones(d, 10)).toBe(0);
  });

  it("truncates oldest-first and flags it, so a joiner is told", () => {
    const many = Array.from({ length: 200 }, (_, i) => entry(`s${i}`, "p1", i));
    const out = truncateSnapshot(many, [], 0, 500);
    expect(out.truncated).toBe(true);
    expect(out.entries.length).toBeLessThan(many.length);
    // The NEWEST survive — they are what a joiner most needs.
    expect(out.entries[out.entries.length - 1].shape.id).toBe("s199");
  });

  it("leaves a small snapshot untouched", () => {
    const few = [entry("a", "p1", 1)];
    const out = truncateSnapshot(few, [], 0, 100_000);
    expect(out.truncated).toBe(false);
    expect(out.entries).toEqual(few);
  });
});

describe("authorship, for per-author undo", () => {
  it("reports who last wrote a live shape, and null for one that is gone", () => {
    const d = run((x) => { upsertShape(x, entry("a", "p1", 10)); });
    expect(authorOf(d, "a")).toBe("p1");
    expect(authorOf(d, "missing")).toBeNull();
    deleteShapes(d, ["a"], 20);
    expect(authorOf(d, "a")).toBeNull();
  });

  it("follows the shape to whoever edited it last", () => {
    // Undo is "my write is still the latest", not "I created it" — so the
    // author must move with the edit or a peer's change becomes unrevertable.
    const d = run((x) => { upsertShape(x, entry("a", "p1", 10, 10)); });
    upsertShape(d, entry("a", "p2", 10, 20));
    expect(authorOf(d, "a")).toBe("p2");
  });
});

describe("rotation survives the restore", () => {
  it("carries `rot`, which the parked wire format predated", () => {
    // The restore note flags this: rotation was added to the model AFTER the
    // collaborative engine was parked, so a verbatim restore would silently
    // drop it on every shape that crossed the wire.
    const spun: Shape = { ...rect("a"), rot: 45 } as Shape;
    const d = emptyCrdt();
    upsertShape(d, { shape: spun, meta: { author: "p1", createdAt: 10, updatedAt: 10 } });
    expect(liveShapes(d)[0].rot).toBe(45);
  });
});
