import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMind, resetMind } from "../../src/components/mind/useMind";

// These pin the persistence gates and the undo bookkeeping — the two places
// where a wiring mistake destroys user data silently rather than failing loudly.
// kv falls back to localStorage in vitest, so writes are directly observable.

const DOC_KEY = "enigma:db:mind:default:";

function docInStore() {
  const raw = localStorage.getItem(DOC_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** A loaded mind with fake timers running — what most tests start from. */
async function loadedMind() {
  const mind = getMind();
  await mind.load();
  return mind;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetMind();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("persistence gates", () => {
  it("never writes the doc before load() has finished", async () => {
    const mind = getMind();
    // No load() — the ready gate must hold even through a flush.
    mind.addNode("note", "orphan", "", 0, 0);
    await mind.flushPersist();
    expect(localStorage.getItem(DOC_KEY)).toBeNull();
  });

  it("debounces the doc write and flushes immediately on demand", async () => {
    const mind = await loadedMind();
    mind.addNode("note", "a", "", 0, 0);
    expect(localStorage.getItem(DOC_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(799);
    expect(localStorage.getItem(DOC_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(docInStore()?.nodes).toHaveLength(1);

    mind.addNode("note", "b", "", 10, 10);
    await mind.flushPersist(); // no timer advance needed
    expect(docInStore()?.nodes).toHaveLength(2);
  });

  it("starts fresh on corrupt content but keeps persisting", async () => {
    localStorage.setItem(DOC_KEY, "{not json");
    const mind = await loadedMind();
    expect(mind.ready.value).toBe(true);
    expect(mind.loadFailed.value).toBe(false);
    expect(mind.nodes.value).toHaveLength(0);
    mind.addNode("note", "recovered", "", 0, 0);
    await vi.advanceTimersByTimeAsync(800);
    expect(docInStore()?.nodes).toHaveLength(1);
  });

  it("loads and revalidates a saved doc", async () => {
    const doc = {
      v: 1,
      nodes: [
        { id: "a", kind: "topic", title: "T", content: "", x: 1, y: 2, collapsed: false },
        { junk: true },
      ],
      edges: [],
    };
    localStorage.setItem(DOC_KEY, JSON.stringify(doc));
    const mind = await loadedMind();
    expect(mind.nodes.value.map((n) => n.id)).toEqual(["a"]);
  });

});

describe("graph mutations", () => {
  it("addNode refuses empty titles and rounds positions", async () => {
    const mind = await loadedMind();
    expect(mind.addNode("note", "   ", "", 0, 0)).toBeNull();
    const n = mind.addNode("note", "ok", "", 10.6, -3.4)!;
    expect([n.x, n.y]).toEqual([11, -3]);
  });

  it("deleteNode drops incident edges in one undo step", async () => {
    const mind = await loadedMind();
    const a = mind.addNode("note", "a", "", 0, 0)!;
    const b = mind.addNode("note", "b", "", 100, 0)!;
    const c = mind.addNode("note", "c", "", 200, 0)!;
    mind.addEdge(a.id, b.id);
    mind.addEdge(b.id, c.id);
    mind.deleteNode(b.id);
    expect(mind.nodes.value).toHaveLength(2);
    expect(mind.edges.value).toHaveLength(0);
    mind.undo();
    expect(mind.nodes.value).toHaveLength(3);
    expect(mind.edges.value).toHaveLength(2);
  });

  it("addEdge refuses self-loops and dangling endpoints", async () => {
    const mind = await loadedMind();
    const a = mind.addNode("note", "a", "", 0, 0)!;
    expect(mind.addEdge(a.id, a.id)).toBeNull();
    expect(mind.addEdge(a.id, "ghost")).toBeNull();
  });

  it("reconnectEdge keeps id and label, refuses a resulting self-loop", async () => {
    const mind = await loadedMind();
    const a = mind.addNode("note", "a", "", 0, 0)!;
    const b = mind.addNode("note", "b", "", 100, 0)!;
    const c = mind.addNode("note", "c", "", 200, 0)!;
    const e = mind.addEdge(a.id, b.id, "rel")!;
    expect(mind.reconnectEdge(e.id, "target", a.id)).toBeNull(); // a → a
    const moved = mind.reconnectEdge(e.id, "target", c.id)!;
    expect(moved.id).toBe(e.id);
    expect(moved.label).toBe("rel");
    expect(mind.edges.value[0].target).toBe(c.id);
  });

  it("swapEdgeDirection flips endpoints in one step", async () => {
    const mind = await loadedMind();
    const a = mind.addNode("note", "a", "", 0, 0)!;
    const b = mind.addNode("note", "b", "", 100, 0)!;
    const e = mind.addEdge(a.id, b.id)!;
    mind.swapEdgeDirection(e.id);
    expect(mind.edges.value[0].source).toBe(b.id);
    mind.undo();
    expect(mind.edges.value[0].source).toBe(a.id);
  });

  it("updateNodeFields ignores an empty title (the validator would drop the node)", async () => {
    const mind = await loadedMind();
    const n = mind.addNode("note", "keep me", "", 0, 0)!;
    mind.updateNodeFields(n.id, { title: "  ", content: "<div>body</div>" });
    const after = mind.nodes.value[0];
    expect(after.title).toBe("keep me");
    expect(after.content).toBe("<div>body</div>");
  });
});

describe("undo / redo", () => {
  it("one editing session = one undo step, reset on selection change", async () => {
    const mind = await loadedMind();
    const n = mind.addNode("note", "v1", "", 0, 0)!;
    mind.select({ kind: "node", id: n.id });
    mind.updateNodeFields(n.id, { title: "v2" });
    mind.updateNodeFields(n.id, { title: "v3" });
    mind.undo(); // whole session unwinds at once
    expect(mind.nodes.value[0].title).toBe("v1");

    mind.redo();
    mind.select(null);
    mind.select({ kind: "node", id: n.id });
    mind.updateNodeFields(n.id, { title: "v4" });
    mind.undo();
    expect(mind.nodes.value[0].title).toBe("v3");
  });

  it("a drag gesture is one undo step; a no-op drag is none", async () => {
    const mind = await loadedMind();
    const n = mind.addNode("note", "n", "", 0, 0)!;
    const undoDepthBefore = (() => {
      // Depth is observable through behavior: count undos until canUndo is false.
      return null;
    })();
    void undoDepthBefore;
    mind.beginNodeDrag();
    mind.moveNode(n.id, 50, 50);
    mind.moveNode(n.id, 120, 80);
    mind.endNodeDrag();
    expect(mind.nodes.value[0]).toMatchObject({ x: 120, y: 80 });
    mind.undo();
    expect(mind.nodes.value[0]).toMatchObject({ x: 0, y: 0 });

    // With a redo pending, a no-op drag must not fork the timeline.
    expect(mind.canRedo.value).toBe(true);
    mind.beginNodeDrag();
    mind.endNodeDrag(); // never moved — no snapshot, redo survives
    expect(mind.canRedo.value).toBe(true);
    mind.redo();
    expect(mind.nodes.value[0]).toMatchObject({ x: 120, y: 80 });
  });

  it("a fresh action clears redo", async () => {
    const mind = await loadedMind();
    mind.addNode("note", "a", "", 0, 0);
    mind.undo();
    expect(mind.canRedo.value).toBe(true);
    mind.addNode("note", "b", "", 0, 0);
    expect(mind.canRedo.value).toBe(false);
  });

  it("undo restores selection-safety (selection on a deleted element clears)", async () => {
    const mind = await loadedMind();
    const n = mind.addNode("note", "a", "", 0, 0)!;
    mind.select({ kind: "node", id: n.id });
    mind.undo(); // node never existed in the restored state
    expect(mind.selected.value).toBeNull();
  });

  it("history is bounded", async () => {
    const mind = await loadedMind();
    const n = mind.addNode("note", "base", "", 0, 0)!;
    for (let i = 0; i < 130; i++) mind.toggleCollapsed(n.id);
    let undos = 0;
    while (mind.canUndo.value) {
      mind.undo();
      undos++;
    }
    expect(undos).toBe(100);
  });
});

describe("topics", () => {
  it("addNoteToTopic creates node + note→topic edge atomically", async () => {
    const mind = await loadedMind();
    const topic = mind.addNode("topic", "Ideas", "", 100, 100)!;
    const note = mind.addNoteToTopic(topic.id, "Untitled")!;

    expect(note.kind).toBe("note");
    expect(mind.edges.value[0]).toMatchObject({ source: note.id, target: topic.id });
    mind.undo(); // ONE step: node and edge disappear together
    expect(mind.nodes.value).toHaveLength(1);
    expect(mind.edges.value).toHaveLength(0);
  });

  it("refuses non-topics and blank titles", async () => {
    const mind = await loadedMind();
    const note = mind.addNode("note", "not a hub", "", 0, 0)!;
    const topic = mind.addNode("topic", "T", "", 0, 0)!;
    expect(mind.addNoteToTopic(note.id, "x")).toBeNull();
    expect(mind.addNoteToTopic(topic.id, "   ")).toBeNull();
    expect(mind.nodes.value).toHaveLength(2);
  });

  it("fans successive notes out to distinct slots", async () => {
    const mind = await loadedMind();
    const topic = mind.addNode("topic", "T", "", 0, 0)!;
    const n1 = mind.addNoteToTopic(topic.id, "one")!;
    const n2 = mind.addNoteToTopic(topic.id, "two")!;
    expect(n1.y).not.toBe(n2.y);
  });
});

describe("commitNodeEdit (the edit modal's Save)", () => {
  it("applies title, kind and content in ONE undo step, scrubbing content", async () => {
    const mind = await loadedMind();
    const n = mind.addNode("note", "before", "", 0, 0)!;
    mind.commitNodeEdit(n.id, {
      title: "after",
      kind: "topic",
      content: '<div>ok<img src="https://evil.example/x.png"></div>',
    });

    const edited = mind.nodes.value[0];
    expect(edited).toMatchObject({ title: "after", kind: "topic", content: "<div>ok</div>" });

    mind.undo();
    expect(mind.nodes.value[0]).toMatchObject({ title: "before", kind: "note", content: "" });
  });

  it("keeps the old title when the draft is blank, and no-ops on no change", async () => {
    const mind = await loadedMind();
    const n = mind.addNode("note", "keep", "", 0, 0)!;
    mind.commitNodeEdit(n.id, { title: "   ", kind: "note", content: "<div>x</div>" });
    expect(mind.nodes.value[0].title).toBe("keep");

    const canUndoBefore = mind.canUndo.value;
    mind.undo();
    mind.redo();
    mind.commitNodeEdit(n.id, { title: "keep", kind: "note", content: "<div>x</div>" }); // identical
    expect(mind.canRedo.value).toBe(false); // redo was already consumed…
    void canUndoBefore;
    // …and the identical commit took no snapshot: one undo returns to pre-edit.
    mind.undo();
    expect(mind.nodes.value[0].content).toBe("");
  });
});

describe("import", () => {
  it("replaceDoc swaps the map, clears selection, flushes, and is one Ctrl+Z away", async () => {
    const mind = await loadedMind();
    const old = mind.addNode("note", "old", "", 0, 0)!;
    mind.select({ kind: "node", id: old.id });
    const rev = mind.revision.value;

    await mind.replaceDoc({
      v: 1,
      nodes: [{ id: "i1", kind: "note", title: "imported", content: "", x: 0, y: 0, collapsed: false }],
      edges: [],
    });

    expect(mind.nodes.value.map((n) => n.title)).toEqual(["imported"]);
    expect(mind.selected.value).toBeNull();
    expect(mind.revision.value).toBeGreaterThan(rev);
    expect(docInStore()?.nodes[0].title).toBe("imported"); // flushed, not debounced

    mind.undo();
    expect(mind.nodes.value.map((n) => n.title)).toEqual(["old"]);
  });
});

describe("layout write-back", () => {
  it("applyLayout moves everything in one undo step; materialization takes none", async () => {
    const mind = await loadedMind();
    const a = mind.addNode("note", "a", "", 0, 0)!;
    const b = mind.addNode("note", "b", "", 10, 10)!;

    mind.applyLayout({ [a.id]: { x: 100, y: 0 }, [b.id]: { x: 100, y: 100 } });
    expect(mind.nodes.value.map((n) => n.x)).toEqual([100, 100]);
    mind.undo();
    expect(mind.nodes.value.map((n) => n.x)).toEqual([0, 10]);

    mind.redo();
    const before = mind.canUndo.value;
    mind.applyLayout({ [a.id]: { x: 200, y: 0 } }, false); // import materialization
    expect(mind.nodes.value[0].x).toBe(200);
    mind.undo();
    // The materialization left no extra undo entry: this undo unwound applyLayout.
    expect(mind.nodes.value.map((n) => n.x)).toEqual([0, 10]);
    void before;
  });
});
