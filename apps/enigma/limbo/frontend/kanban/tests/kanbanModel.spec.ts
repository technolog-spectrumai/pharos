import { describe, expect, it } from "vitest";
import {
  applyRemoteCard,
  applyRemoteColumns,
  columnsSorted,
  compareCards,
  keyBetween,
  seedKeys,
  sortColumnCards,
  validateCardDraft,
  type Card,
  type CardWire,
  type ColumnsWire,
} from "../../src/components/kanban/kanbanModel";

// ── fractional index ──────────────────────────────────────────────────────────

describe("keyBetween", () => {
  it("seeds a key between the open ends", () => {
    const k = keyBetween(null, null);
    expect(k.length).toBeGreaterThan(0);
    expect("" < k).toBe(true);
  });

  it("appends strictly after a key", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    expect(a < b).toBe(true);
  });

  it("prepends strictly before a key", () => {
    const b = keyBetween(null, null);
    const a = keyBetween(null, b);
    expect(a < b).toBe(true);
    expect("" < a).toBe(true);
  });

  it("returns a key strictly between two neighbours", () => {
    const a = keyBetween(null, null);
    const c = keyBetween(a, null);
    const b = keyBetween(a, c);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("stays ordered under repeated inserts at the same gap", () => {
    let lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    const inserted: string[] = [];
    for (let i = 0; i < 50; i++) {
      const mid = keyBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      inserted.push(mid);
      lo = mid; // keep inserting just after the previous midpoint
    }
    const sorted = [...inserted].sort();
    expect(inserted).toEqual(sorted);
  });

  it("throws when the lower bound is not below the upper", () => {
    const k = keyBetween(null, null);
    expect(() => keyBetween(k, k)).toThrow();
  });
});

describe("seedKeys", () => {
  it("produces strictly increasing keys", () => {
    const keys = seedKeys(5);
    expect(keys).toHaveLength(5);
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true);
  });
});

// ── ordering ──────────────────────────────────────────────────────────────────

function card(over: Partial<Card>): Card {
  return {
    id: "id",
    columnId: "c1",
    title: "t",
    description: "",
    assignee: "",
    dueDate: null,
    color: "slate",
    orderKey: "V",
    author: "a",
    createdAt: 0,
    updatedAt: 0,
    deleted: false,
    ...over,
  };
}

describe("compareCards / sortColumnCards", () => {
  it("orders by orderKey, then author, then id — deterministically", () => {
    const a = card({ id: "z", orderKey: "V", author: "a" });
    const b = card({ id: "a", orderKey: "V", author: "a" }); // same key+author → id wins
    const c = card({ id: "m", orderKey: "V", author: "b" }); // higher author → after a/b
    const d = card({ id: "n", orderKey: "F", author: "z" }); // lower key → first
    const sorted = [a, b, c, d].sort(compareCards);
    expect(sorted.map((x) => x.id)).toEqual(["n", "a", "z", "m"]);
  });

  it("filters tombstones and other columns", () => {
    const cards = [
      card({ id: "1", columnId: "c1", orderKey: "F" }),
      card({ id: "2", columnId: "c1", orderKey: "V", deleted: true }),
      card({ id: "3", columnId: "c2", orderKey: "F" }),
    ];
    expect(sortColumnCards(cards, "c1").map((c) => c.id)).toEqual(["1"]);
  });
});

// ── card reconciliation (LWW) ──────────────────────────────────────────────────

function wire(over: Partial<CardWire>): CardWire {
  return {
    roomSlug: "room",
    id: "id",
    columnId: "c1",
    title: "t",
    description: "",
    assignee: "",
    dueDate: null,
    color: "slate",
    orderKey: "V",
    author: "a",
    createdAt: 0,
    updatedAt: 10,
    deleted: false,
    fromName: "n",
    fromDevice: "a",
    ...over,
  };
}

describe("applyRemoteCard", () => {
  it("accepts a first sighting", () => {
    expect(applyRemoteCard(undefined, wire({}))?.id).toBe("id");
  });

  it("accepts a strictly newer update, drops a stale one", () => {
    const existing = card({ updatedAt: 10 });
    expect(applyRemoteCard(existing, wire({ updatedAt: 20, title: "new" }))?.title).toBe("new");
    expect(applyRemoteCard(existing, wire({ updatedAt: 5, title: "old" }))).toBeNull();
  });

  it("lets a delete win a same-timestamp tie over an edit", () => {
    const existing = card({ updatedAt: 10, deleted: false, author: "z" });
    const merged = applyRemoteCard(existing, wire({ updatedAt: 10, deleted: true, author: "a" }));
    expect(merged?.deleted).toBe(true);
  });

  it("keeps an existing delete over an incoming edit at the same timestamp", () => {
    const existing = card({ updatedAt: 10, deleted: true, author: "a" });
    expect(applyRemoteCard(existing, wire({ updatedAt: 10, deleted: false, author: "z" }))).toBeNull();
  });

  it("breaks a same-class timestamp tie by higher author id", () => {
    const existing = card({ updatedAt: 10, author: "a", title: "keep" });
    expect(applyRemoteCard(existing, wire({ updatedAt: 10, author: "b", title: "win" }))?.title).toBe("win");
    expect(applyRemoteCard(existing, wire({ updatedAt: 10, author: "a", title: "dup" }))).toBeNull();
  });
});

// ── columns reconciliation (captain-authoritative) ──────────────────────────────

function colsWire(over: Partial<ColumnsWire>): ColumnsWire {
  return {
    roomSlug: "room",
    columns: [{ id: "k1", title: "To Do", orderKey: "V" }],
    columnsRev: 2,
    fromName: "n",
    fromDevice: "cap",
    ...over,
  };
}

describe("applyRemoteColumns", () => {
  it("accepts the captain's snapshot at same-or-higher rev", () => {
    expect(applyRemoteColumns(2, colsWire({ columnsRev: 2 }), true)).not.toBeNull();
    expect(applyRemoteColumns(2, colsWire({ columnsRev: 3 }), true)).not.toBeNull();
    expect(applyRemoteColumns(3, colsWire({ columnsRev: 2 }), true)).toBeNull();
  });

  it("accepts a non-captain snapshot only when strictly newer (handoff)", () => {
    expect(applyRemoteColumns(2, colsWire({ columnsRev: 2 }), false)).toBeNull();
    expect(applyRemoteColumns(2, colsWire({ columnsRev: 3 }), false)).not.toBeNull();
  });

  it("returns columns sorted and sanitized", () => {
    const out = applyRemoteColumns(
      0,
      colsWire({
        columnsRev: 1,
        columns: [
          { id: "b", title: "B", orderKey: "m" },
          { id: "a", title: "A", orderKey: "F" },
          // @ts-expect-error malformed entry must be dropped
          { id: 3, title: "bad" },
        ],
      }),
      true,
    );
    expect(out?.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("columnsSorted", () => {
  it("orders by orderKey then id", () => {
    const out = columnsSorted([
      { id: "z", title: "Z", orderKey: "V" },
      { id: "a", title: "A", orderKey: "V" },
      { id: "y", title: "Y", orderKey: "F" },
    ]);
    expect(out.map((c) => c.id)).toEqual(["y", "a", "z"]);
  });
});

// ── validation ──────────────────────────────────────────────────────────────────

describe("validateCardDraft", () => {
  it("requires a non-empty title within the cap", () => {
    expect(validateCardDraft({ title: "", description: "" }, 200, 4000)).toBe("titleRequired");
    expect(validateCardDraft({ title: "a".repeat(201), description: "" }, 200, 4000)).toBe("titleTooLong");
    expect(validateCardDraft({ title: "ok", description: "x".repeat(4001) }, 200, 4000)).toBe(
      "descriptionTooLong",
    );
    expect(validateCardDraft({ title: "ok", description: "fine" }, 200, 4000)).toBeNull();
  });
});
