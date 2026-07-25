import { describe, expect, it } from "vitest";
import {
  emptyMindDoc,
  emptyMindDump,
  MIND_COORD_LIMIT,
  MIND_EXPORT_FORMAT,
  MIND_EXPORT_VERSION,
  parseImportFile,
  roundPos,
  splitDumpEntry,
  toExportFile,
  validateMindDoc,
  validateMindDump,
  validateMindEdge,
  validateMindNode,
  type MindCaps,
  type MindDoc,
  type MindNode,
} from "../../src/components/mind/mindModel";

const CAPS: MindCaps = {
  maxNodes: 500,
  maxEdges: 1000,
  maxTitleLen: 200,
  maxContentLen: 4000,
  maxDumpEntries: 200,
  maxDumpEntryLen: 4000,
};

function node(over: Partial<MindNode> = {}): MindNode {
  return { id: "n1", kind: "note", title: "T", content: "", x: 0, y: 0, collapsed: false, ...over };
}

describe("empty documents", () => {
  it("shapes", () => {
    expect(emptyMindDoc()).toEqual({ v: 1, nodes: [], edges: [] });
    expect(emptyMindDump()).toEqual({ v: 1, entries: [] });
  });
});

describe("roundPos", () => {
  it("rounds to integers", () => {
    expect(roundPos(12.4)).toBe(12);
    expect(roundPos(-3.6)).toBe(-4);
  });
});

describe("validateMindNode", () => {
  it("accepts a well-formed node and rebuilds every field", () => {
    const v = validateMindNode({ ...node(), extra: "junk" }, CAPS);
    expect(v).toEqual(node());
    expect(v).not.toHaveProperty("extra");
  });

  it("defaults kind to note for anything not topic", () => {
    expect(validateMindNode(node({ kind: "topic" }), CAPS)?.kind).toBe("topic");
    expect(validateMindNode({ ...node(), kind: "hub" }, CAPS)?.kind).toBe("note");
    expect(validateMindNode({ ...node(), kind: 7 }, CAPS)?.kind).toBe("note");
  });

  it("drops nodes with a missing or empty title, slices an overlong one", () => {
    expect(validateMindNode({ ...node(), title: "" }, CAPS)).toBeNull();
    expect(validateMindNode({ ...node(), title: 3 }, CAPS)).toBeNull();
    const long = validateMindNode(node({ title: "x".repeat(500) }), CAPS);
    expect(long?.title).toHaveLength(CAPS.maxTitleLen);
  });

  it("slices overlong content and defaults missing content to empty", () => {
    expect(validateMindNode(node({ content: "y".repeat(9000) }), CAPS)?.content).toHaveLength(CAPS.maxContentLen);
    const noContent = { ...node() } as Record<string, unknown>;
    delete noContent.content;
    expect(validateMindNode(noContent, CAPS)?.content).toBe("");
  });

  it("drops hostile coordinates", () => {
    expect(validateMindNode(node({ x: Number.NaN }), CAPS)).toBeNull();
    expect(validateMindNode(node({ y: Number.POSITIVE_INFINITY }), CAPS)).toBeNull();
    expect(validateMindNode(node({ x: MIND_COORD_LIMIT + 1 }), CAPS)).toBeNull();
    expect(validateMindNode(node({ x: -MIND_COORD_LIMIT }), CAPS)).not.toBeNull();
  });

  it("coerces collapsed to a boolean", () => {
    expect(validateMindNode({ ...node(), collapsed: 1 }, CAPS)?.collapsed).toBe(true);
    expect(validateMindNode({ ...node(), collapsed: undefined }, CAPS)?.collapsed).toBe(false);
  });
});

describe("validateMindEdge", () => {
  const ids = new Set(["a", "b"]);

  it("accepts a well-formed edge", () => {
    expect(validateMindEdge({ id: "e1", source: "a", target: "b", label: "rel" }, ids, CAPS)).toEqual({
      id: "e1",
      source: "a",
      target: "b",
      label: "rel",
    });
  });

  it("drops dangling endpoints and self-loops", () => {
    expect(validateMindEdge({ id: "e1", source: "a", target: "zz" }, ids, CAPS)).toBeNull();
    expect(validateMindEdge({ id: "e1", source: "zz", target: "b" }, ids, CAPS)).toBeNull();
    expect(validateMindEdge({ id: "e1", source: "a", target: "a" }, ids, CAPS)).toBeNull();
  });

  it("defaults a missing label and slices an overlong one", () => {
    expect(validateMindEdge({ id: "e1", source: "a", target: "b" }, ids, CAPS)?.label).toBe("");
    const long = validateMindEdge({ id: "e1", source: "a", target: "b", label: "x".repeat(500) }, ids, CAPS);
    expect(long?.label).toHaveLength(CAPS.maxTitleLen);
  });
});

describe("validateMindDoc", () => {
  it("rejects non-documents", () => {
    expect(validateMindDoc(null, CAPS)).toBeNull();
    expect(validateMindDoc(42, CAPS)).toBeNull();
    expect(validateMindDoc({ nodes: "x", edges: [] }, CAPS)).toBeNull();
    expect(validateMindDoc({ nodes: [], edges: {} }, CAPS)).toBeNull();
  });

  it("drops malformed members but keeps the rest, in order", () => {
    const doc = validateMindDoc(
      {
        nodes: [node({ id: "a" }), { junk: true }, node({ id: "b" })],
        edges: [
          { id: "e1", source: "a", target: "b" },
          { id: "e2", source: "a", target: "gone" },
        ],
      },
      CAPS,
    );
    expect(doc?.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(doc?.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("keeps the first occurrence of a duplicated id", () => {
    const doc = validateMindDoc(
      {
        nodes: [node({ id: "a", title: "first" }), node({ id: "a", title: "second" }), node({ id: "b" })],
        edges: [
          { id: "e", source: "a", target: "b", label: "one" },
          { id: "e", source: "b", target: "a", label: "two" },
        ],
      },
      CAPS,
    );
    expect(doc?.nodes).toHaveLength(2);
    expect(doc?.nodes[0].title).toBe("first");
    expect(doc?.edges).toHaveLength(1);
    expect(doc?.edges[0].label).toBe("one");
  });

  it("truncates at the caps, and edges to cap-dropped nodes go too", () => {
    const caps: MindCaps = { ...CAPS, maxNodes: 2, maxEdges: 2 };
    const doc = validateMindDoc(
      {
        nodes: [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
        edges: [
          { id: "e1", source: "a", target: "c" }, // c was cap-dropped
          { id: "e2", source: "a", target: "b" },
          { id: "e3", source: "b", target: "a" },
          { id: "e4", source: "b", target: "a" },
        ],
      },
      caps,
    );
    expect(doc?.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(doc?.edges.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("keeps parallel edges between the same pair", () => {
    const doc = validateMindDoc(
      {
        nodes: [node({ id: "a" }), node({ id: "b" })],
        edges: [
          { id: "e1", source: "a", target: "b" },
          { id: "e2", source: "a", target: "b" },
          { id: "e3", source: "b", target: "a" },
        ],
      },
      CAPS,
    );
    expect(doc?.edges).toHaveLength(3);
  });
});

describe("validateMindDump", () => {
  it("rejects non-dumps and drops malformed entries", () => {
    expect(validateMindDump(null, CAPS)).toBeNull();
    expect(validateMindDump({ entries: "x" }, CAPS)).toBeNull();
    const dump = validateMindDump(
      {
        entries: [
          { id: "d1", text: "keep", createdAt: 5 },
          { id: "d2", text: "", createdAt: 5 },
          { id: "d3", text: "bad clock", createdAt: Number.NaN },
          { id: "d1", text: "dup id", createdAt: 6 },
          "junk",
        ],
      },
      CAPS,
    );
    expect(dump?.entries.map((e) => e.id)).toEqual(["d1"]);
    expect(dump?.entries[0].text).toBe("keep");
  });

  it("caps the entry count and slices overlong text", () => {
    const caps: MindCaps = { ...CAPS, maxDumpEntries: 2, maxDumpEntryLen: 4 };
    const dump = validateMindDump(
      {
        entries: [
          { id: "a", text: "abcdefgh", createdAt: 1 },
          { id: "b", text: "ok", createdAt: 2 },
          { id: "c", text: "over", createdAt: 3 },
        ],
      },
      caps,
    );
    expect(dump?.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(dump?.entries[0].text).toBe("abcd");
  });
});

describe("export / import round-trip", () => {
  const doc: MindDoc = {
    v: 1,
    nodes: [
      node({ id: "t", kind: "topic", title: "Topic", x: 10, y: -20 }),
      node({ id: "n", title: "Note", content: "body", collapsed: true }),
    ],
    edges: [{ id: "e", source: "t", target: "n", label: "captures" }],
  };

  it("survives JSON serialization losslessly", () => {
    const file = toExportFile(doc);
    expect(file.format).toBe(MIND_EXPORT_FORMAT);
    expect(file.version).toBe(MIND_EXPORT_VERSION);
    expect(file.metadata).toEqual({ nodeCount: 2, edgeCount: 1 });
    const back = parseImportFile(JSON.parse(JSON.stringify(file)), CAPS);
    expect(back).toEqual(doc);
  });

  it("refuses foreign or wrong-version files", () => {
    const file = toExportFile(doc);
    expect(parseImportFile({ ...file, format: "other" }, CAPS)).toBeNull();
    expect(parseImportFile({ ...file, version: 2 }, CAPS)).toBeNull();
    expect(parseImportFile("[]", CAPS)).toBeNull();
    expect(parseImportFile(null, CAPS)).toBeNull();
  });

  it("validates the arrays, ignoring the file's claimed counts", () => {
    const file = {
      format: MIND_EXPORT_FORMAT,
      version: MIND_EXPORT_VERSION,
      exportedAt: "whenever",
      metadata: { nodeCount: 999, edgeCount: 999 },
      nodes: [node({ id: "a" }), { junk: true }],
      edges: [{ id: "e", source: "a", target: "missing" }],
    };
    const back = parseImportFile(file, CAPS);
    expect(back?.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(back?.edges).toEqual([]);
  });
});

describe("splitDumpEntry", () => {
  it("uses the first non-empty line as title, the remainder as content", () => {
    expect(splitDumpEntry("Title line\nbody one\nbody two", CAPS)).toEqual({
      title: "Title line",
      content: "body one\nbody two",
    });
  });

  it("skips leading blank lines and trims", () => {
    expect(splitDumpEntry("\n\n  Idea  \n\nrest\n", CAPS)).toEqual({ title: "Idea", content: "rest" });
  });

  it("single line means empty content", () => {
    expect(splitDumpEntry("just this", CAPS)).toEqual({ title: "just this", content: "" });
  });

  it("whitespace-only text produces an empty title (caller must refuse)", () => {
    expect(splitDumpEntry("   \n  ", CAPS)).toEqual({ title: "", content: "" });
  });

  it("slices both parts to their caps", () => {
    const caps: MindCaps = { ...CAPS, maxTitleLen: 3, maxContentLen: 5 };
    expect(splitDumpEntry("abcdef\nghijklmn", caps)).toEqual({ title: "abc", content: "ghijk" });
  });
});
