// Two sessions over an in-memory bus, driven against each other. No Tauri, no
// network — the bus models what crates/collab enforces (tests/helpers/fakeBus.ts),
// and these are the properties the plan asked for, one test each.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSketch, type Sketch } from "../../src/sketch/useSketch";
import { createCollabSession } from "../../src/collab/useCollabSession";
import { makeFakeNet, SAS } from "../helpers/fakeBus";

function ids(s: Sketch): string[] {
  return s.doc.value.shapes.map((x) => x.id);
}

/** Host A, joiner B, paired and accepted — the state every drawing test starts from. */
async function pair() {
  const net = makeFakeNet();
  const A = createSketch();
  const B = createSketch();
  const a = createCollabSession(net.host, { me: "alice" });
  const b = createCollabSession(net.joiner, { me: "bob" });
  a.attach(A);
  b.attach(B);
  await a.host();
  await b.join(a.ticket.value!);
  await net.settle();
  await a.accept();
  await net.settle();
  return { net, A, B, a, b };
}

function rect(s: Sketch, x = 10) {
  s.addRect(x, x, 50, 40);
  return ids(s).at(-1)!;
}

afterEach(() => vi.useRealTimers());

describe("pairing", () => {
  it("shows a ticket, agrees on the digits, and sends nothing before Accept", async () => {
    const net = makeFakeNet();
    const A = createSketch();
    const B = createSketch();
    const a = createCollabSession(net.host, { me: "alice" });
    const b = createCollabSession(net.joiner, { me: "bob" });
    a.attach(A);
    b.attach(B);
    rect(A); // the host already has a drawing

    await a.host();
    expect(a.phase.value).toBe("hosting");
    expect(a.ticket.value).toMatch(/^ticket-/);

    await b.join(a.ticket.value!);
    await net.settle();
    expect(a.phase.value).toBe("pairing");
    expect(b.phase.value).toBe("pairing");
    expect(a.sas.value).toBe(SAS);
    expect(b.sas.value).toBe(SAS);
    // The document has NOT crossed: no snapshot, no shape on B.
    expect(net.delivered.some((d) => typeof d.frame !== "string" && "Snapshot" in d.frame)).toBe(false);
    expect(ids(B)).toEqual([]);

    await a.accept();
    await net.settle();
    expect(a.phase.value).toBe("live");
    expect(b.phase.value).toBe("live");
    expect(ids(B)).toEqual(ids(A));
  });

  it("drops what the joiner draws before the host accepts", async () => {
    // Rust's gate would drop those frames; the bus does the same. And the
    // joiner's own board is replaced by the host's on Welcome, so nothing
    // drawn before pairing survives on either side.
    const net = makeFakeNet();
    const A = createSketch();
    const B = createSketch();
    const a = createCollabSession(net.host, { me: "alice" });
    const b = createCollabSession(net.joiner, { me: "bob" });
    a.attach(A);
    b.attach(B);
    await a.host();
    await b.join(a.ticket.value!);
    await net.settle();
    rect(B);
    await net.settle();
    expect(ids(A)).toEqual([]);
    await a.accept();
    await net.settle();
    expect(ids(A)).toEqual([]);
    expect(ids(B)).toEqual([]);
  });

  it("gives the joiner the host's board and its size", async () => {
    const net = makeFakeNet();
    const A = createSketch();
    const B = createSketch();
    A.envelope.value = { ...A.envelope.value, width: 800, height: 600 };
    const a = createCollabSession(net.host, { me: "alice" });
    const b = createCollabSession(net.joiner, { me: "bob" });
    a.attach(A);
    b.attach(B);
    rect(B, 5); // the joiner's own drawing, which joining replaces
    const mine = rect(A);
    await a.host();
    await b.join(a.ticket.value!);
    await net.settle();
    await a.accept();
    await net.settle();
    expect(ids(B)).toEqual([mine]);
    expect(B.boardW.value).toBe(800);
    expect(B.boardH.value).toBe(600);
  });

  it("maps a refused ticket to a catalogue key and goes back to idle", async () => {
    const net = makeFakeNet();
    const b = createCollabSession(net.joiner, { me: "bob" });
    b.attach(createSketch());
    await b.join("garbage");
    expect(b.error.value).toBe("collab.errors.bad_ticket");
    expect(b.phase.value).toBe("idle");
  });
});

describe("drawing together", () => {
  it("shows a shape drawn on either side on the other, in one order", async () => {
    // Both shapes reach both boards, and the two boards agree on the ORDER.
    // Not on a particular order: the peers stamp independently, so which of
    // two shapes drawn in the same millisecond paints first is decided by the
    // author tiebreak in `compareEntries` and is not the property under test.
    // Asserting a fixed order here made this flake about one run in five.
    const { net, A, B } = await pair();
    const r = rect(A);
    B.addEllipse(100, 100, 20, 20);
    const e = ids(B).at(-1)!;
    await net.settle();
    expect(new Set(ids(A))).toEqual(new Set([r, e]));
    expect(ids(B)).toEqual(ids(A));
  });

  it("moves a shape on the peer's board when it is dragged here", async () => {
    const { net, A, B } = await pair();
    const r = rect(A);
    await net.settle();
    A.selectedId.value = r;
    A.beginTransform();
    A.moveSelected(30, 0);
    await net.settle();
    // Provisional: nothing crossed yet.
    expect((B.doc.value.shapes[0] as { x: number }).x).toBe(10);
    A.endTransform();
    await net.settle();
    expect((B.doc.value.shapes[0] as { x: number }).x).toBe(40);
  });

  it("lets an edit erase the peer's shape", async () => {
    // A decision, not history: deleting what someone else drew is allowed.
    const { net, A, B } = await pair();
    const r = rect(A);
    await net.settle();
    B.selectedId.value = r;
    B.deleteSelected();
    await net.settle();
    expect(ids(A)).toEqual([]);
    expect(ids(B)).toEqual([]);
  });

  it("clears both boards, and the clear cannot be undone by the other side", async () => {
    const { net, A, B } = await pair();
    rect(A);
    B.addEllipse(100, 100, 20, 20);
    await net.settle();
    A.clearBoard();
    await net.settle();
    expect(ids(A)).toEqual([]);
    expect(ids(B)).toEqual([]);
    B.undo(); // B's ellipse was cleared by A; B was not the last to touch it
    await net.settle();
    expect(ids(B)).toEqual([]);
    expect(ids(A)).toEqual([]);
  });

  it("carries the background colour as last-writer-wins", async () => {
    const { net, A, B } = await pair();
    A.setBackground("#111827");
    await net.settle();
    expect(B.doc.value.background).toBe("#111827");
    B.setBackground("#ffffff");
    await net.settle();
    expect(A.doc.value.background).toBe("#ffffff");
  });
});

describe("undo with a peer", () => {
  it("reverts only your own shape, on both sides", async () => {
    const { net, A, B } = await pair();
    const r = rect(A);
    B.addEllipse(100, 100, 20, 20);
    const e = ids(B).at(-1)!;
    await net.settle();
    A.undo();
    await net.settle();
    expect(ids(A)).toEqual([e]);
    expect(ids(B)).toEqual([e]);
    B.undo();
    await net.settle();
    expect(ids(A)).toEqual([]);
    expect(ids(B)).toEqual([]);
    expect(r).not.toBe(e);
  });

  it("does not resurrect a shape the peer erased", async () => {
    // A's undo snapshot still holds r1, but B was the last to touch it.
    const { net, A, B } = await pair();
    const r1 = rect(A);
    await net.settle();
    B.selectedId.value = r1;
    B.deleteSelected();
    await net.settle();
    const r2 = rect(A, 200);
    await net.settle();
    A.undo(); // reverts r2 only
    await net.settle();
    expect(ids(A)).toEqual([]);
    expect(ids(B)).toEqual([]);
    expect(r2).not.toBe(r1);
  });

  it("brings back a shape you erased yourself", async () => {
    const { net, A, B } = await pair();
    const r = rect(A);
    await net.settle();
    A.selectedId.value = r;
    A.deleteSelected();
    await net.settle();
    expect(ids(B)).toEqual([]);
    A.undo();
    await net.settle();
    expect(ids(A)).toEqual([r]);
    expect(ids(B)).toEqual([r]);
  });
});

describe("loss and recovery", () => {
  it("detects a dropped frame and converges again by resync", async () => {
    const { net, A, B } = await pair();
    net.lose(1); // the NEXT frame — the bus queues synchronously, so before the draw
    const r1 = rect(A);
    await net.settle();
    expect(ids(B)).toEqual([]); // the op was lost
    const r2 = rect(A, 200);
    await net.settle(); // the gap → lagged → Resync → Snapshot
    expect(ids(B)).toEqual([r1, r2]);
    expect(ids(A)).toEqual([r1, r2]);
  });

  it("merges the snapshot rather than replacing local work", async () => {
    const { net, A, B } = await pair();
    net.lose(1);
    const r1 = rect(A);
    await net.settle();
    B.addEllipse(100, 100, 20, 20); // drawn while B is missing r1
    const e = ids(B).at(-1)!;
    await net.settle();
    const r2 = rect(A, 200);
    await net.settle();
    expect(ids(B)).toEqual(ids(A));
    expect(new Set(ids(B))).toEqual(new Set([r1, e, r2]));
  });
});

describe("live strokes and cursors", () => {
  it("streams a stroke at most 20 times a second, and its end at once", async () => {
    vi.useFakeTimers();
    const { net, A, B } = await pair();
    const liveTo = () =>
      net.delivered.filter((d) => d.to === "joiner" && typeof d.frame !== "string" && "Live" in d.frame).length;
    A.beginStroke(0, 0);
    for (let i = 1; i <= 30; i++) A.extendStroke(i * 5, i * 5);
    await net.settle();
    expect(liveTo()).toBe(1); // the first change goes out at once
    expect(B.peerLive.value?.pts.length).toBe(2);
    vi.advanceTimersByTime(60);
    await net.settle();
    expect(liveTo()).toBe(2); // one tick, the LATEST, not thirty
    expect(B.peerLive.value?.pts.length).toBe(62);
    A.commitStroke();
    await net.settle();
    expect(liveTo()).toBe(3); // the end is not held for the tick
    expect(B.peerLive.value).toBeNull(); // the committed shape replaced it
    expect(ids(B)).toEqual(ids(A));
  });

  it("shows the peer's pointer and clears it when the peer leaves", async () => {
    const { net, A, B, b } = await pair();
    B.pointer.value = { x: 12, y: 34 };
    B.beginStroke(1, 1);
    await net.settle();
    expect(A.peerCursor.value).toEqual({ x: 12, y: 34 });
    expect(A.peerLive.value).not.toBeNull();
    await b.leave();
    await net.settle();
    expect(A.peerLive.value).toBeNull();
    expect(A.peerCursor.value).toBeNull();
    expect(b.phase.value).toBe("idle");
  });

  it("leaves no artefact when the peer vanishes mid-stroke", async () => {
    const { net, A, B, a } = await pair();
    B.beginStroke(1, 1);
    B.extendStroke(50, 50);
    await net.settle();
    expect(A.peerLive.value).not.toBeNull();
    net.vanish("joiner");
    await net.settle();
    expect(A.peerLive.value).toBeNull();
    expect(a.peerOnline.value).toBe(false);
    expect(a.phase.value).toBe("live"); // the session waits; the peer may return
    expect(ids(A)).toEqual([]);
  });
});

describe("the session and the drawing", () => {
  it("ends when the drawing changes, and the merged board stays", async () => {
    const { net, A, B, a, b } = await pair();
    const r = rect(A);
    await net.settle();
    a.attach(createSketch()); // New / Open
    await net.settle();
    expect(a.phase.value).toBe("idle");
    expect(b.peerOnline.value).toBe(false);
    // Both boards keep what was drawn: either side can save it.
    expect(ids(A)).toEqual([r]);
    expect(ids(B)).toEqual([r]);
  });

  it("goes back to a plain editor after leaving: local edits no longer cross", async () => {
    const { net, A, B, a } = await pair();
    await a.leave();
    await net.settle();
    rect(A);
    await net.settle();
    expect(ids(B)).toEqual([]);
    expect(A.canUndo.value).toBe(true); // and undo is whole-document again
  });
});
