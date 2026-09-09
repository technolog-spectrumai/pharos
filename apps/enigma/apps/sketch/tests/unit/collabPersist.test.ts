// The board on disk.
//
// A fake store rather than the real one: what these pin is the SESSION's
// judgement — when it writes, what it writes, and what it deliberately does
// not — and the store itself is tested in `crates/hoard` where it lives.
//
// The last test is the one that matters most. It asserts what is NOT written,
// because two deliberate security decisions rest on it: the MLS layer declines
// to persist a group key ("a group key persisted to disk outlives the reason
// it existed") and the transport keeps its identity ephemeral ("a stable id
// would let two sessions be tied to one machine"). Writing either here would
// reverse both, silently, and nothing else in the suite would notice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSketch, type Sketch } from "wisteria/useSketch";
import { createCollabSession, SAVE_DEBOUNCE_MS } from "../../src/collab/useCollabSession";
import type { BoardStore } from "../../src/collab/persist";
import { makeFakeNet } from "../helpers/fakeBus";

/** A store that records what it was asked to keep. */
function fakeStore() {
  const written = new Map<string, string>();
  const store: BoardStore = {
    save: async (board, snapshot) => {
      written.set(board, snapshot);
    },
    load: async (board) => written.get(board) ?? null,
    forget: async (board) => {
      written.delete(board);
    },
  };
  return { store, written, saves: () => written.size };
}

function rect(s: Sketch, x = 10) {
  s.addRect(x, x, 50, 40);
  return s.doc.value.shapes.at(-1)!.id;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Let the debounce fire and the write settle. */
async function settle() {
  await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
}

describe("saving the board", () => {
  it("writes after a change, once the burst settles", async () => {
    const net = makeFakeNet();
    const { store, written } = fakeStore();
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);

    rect(A);
    expect(written.size, "nothing yet — the debounce is still running").toBe(0);
    await settle();
    expect(written.size).toBe(1);
  });

  it("coalesces a burst into one write", async () => {
    // A drag, an erase sweep or a paste is many commits in quick succession.
    // Writing each would be two hundred fsyncs for one gesture.
    const net = makeFakeNet();
    const writes: string[] = [];
    const store: BoardStore = {
      save: async (_b, snap) => void writes.push(snap),
      load: async () => null,
      forget: async () => {},
    };
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);

    for (let i = 0; i < 20; i++) rect(A, i * 5);
    await settle();
    expect(writes).toHaveLength(1);
  });

  it("writes the shapes, the board size and the background", async () => {
    const net = makeFakeNet();
    const { store, written } = fakeStore();
    const A = createSketch();
    A.envelope.value = { ...A.envelope.value, width: 800, height: 600 };
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);

    const id = rect(A);
    A.setBackground("#111827");
    await settle();

    const body = JSON.parse(written.get("current")!);
    expect(body.snap.entries.map((e: { shape: { id: string } }) => e.shape.id)).toEqual([id]);
    expect(body.snap.width).toBe(800);
    expect(body.snap.height).toBe(600);
    expect(body.bg.color).toBe("#111827");
  });

  it("writes when the PEER draws, not only when we do", async () => {
    // A board is worth keeping whoever drew on it.
    const net = makeFakeNet();
    const { store, written } = fakeStore();
    const A = createSketch();
    const B = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    const b = createCollabSession(net.joiner, { me: "bob" });
    a.attach(A);
    b.attach(B);
    await a.host();
    await b.join(a.ticket.value!);
    await net.settle();
    await a.accept();
    await net.settle();

    written.clear();
    rect(B);
    await net.settle();
    await settle();
    expect(written.size).toBe(1);
  });

  it("flushes before the session ends, so the last stroke is not lost", async () => {
    const net = makeFakeNet();
    const { store, written } = fakeStore();
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);
    await a.host();

    rect(A);
    // No settle: the debounce is still pending when the session ends.
    await a.leave();
    expect(written.size, "leave must not drop a pending write").toBe(1);
  });

  it("keeps the session alive when a write fails", async () => {
    // A full disk is not a reason to stop drawing or to drop the peer.
    const net = makeFakeNet();
    const store: BoardStore = {
      save: async () => {
        throw new Error("store_failed: disk full");
      },
      load: async () => null,
      forget: async () => {},
    };
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);
    await a.host();

    rect(A);
    await settle();
    expect(a.phase.value).toBe("hosting");
    expect(a.error.value).toBe("persist.errors.store_failed");
    expect(A.doc.value.shapes).toHaveLength(1);
  });
});

describe("restoring the board", () => {
  it("brings back what was stored", async () => {
    const net = makeFakeNet();
    const { store } = fakeStore();
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);
    const id = rect(A);
    await settle();

    // A fresh session over the same store, the way a restart arrives.
    const B = createSketch();
    const b = createCollabSession(net.joiner, { me: "alice-again", store });
    b.attach(B);
    expect(await b.restore()).toBe(true);
    expect(B.doc.value.shapes.map((s) => s.id)).toEqual([id]);
  });

  it("answers false for a board nobody has drawn", async () => {
    const net = makeFakeNet();
    const { store } = fakeStore();
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);
    expect(await a.restore()).toBe(false);
  });

  it("merges rather than replacing, so newer local work survives", async () => {
    // The stored copy is older than what is on screen — a board drawn on since
    // the last write. Replacing would silently discard that.
    const net = makeFakeNet();
    const { store } = fakeStore();
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);
    const stored = rect(A, 10);
    await settle();

    const B = createSketch();
    const b = createCollabSession(net.joiner, { me: "bob", store });
    b.attach(B);
    const drawnSince = rect(B, 200);
    await b.restore();

    const ids = B.doc.value.shapes.map((s) => s.id);
    expect(ids).toContain(stored);
    expect(ids, "local work must survive a restore").toContain(drawnSince);
  });

  it("says so when the stored copy is unreadable", async () => {
    const net = makeFakeNet();
    const store: BoardStore = {
      save: async () => {},
      load: async () => "{ not json",
      forget: async () => {},
    };
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);
    expect(await a.restore()).toBe(false);
    expect(a.error.value).toBeTruthy();
  });
});

describe("what is never written", () => {
  it("stores the document and nothing else", async () => {
    // THE RULE. Two deliberate security choices depend on it, and no other
    // test in this suite would notice if a key reached the disk.
    const net = makeFakeNet();
    const { store, written } = fakeStore();
    const A = createSketch();
    const B = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    const b = createCollabSession(net.joiner, { me: "bob" });
    a.attach(A);
    b.attach(B);
    await a.host();
    const ticket = a.ticket.value!;
    await b.join(ticket);
    await net.settle();
    await a.accept();
    await net.settle();
    rect(A);
    await settle();

    const raw = written.get("current")!;
    const body = JSON.parse(raw);

    // What IS there: the document.
    expect(Object.keys(body).sort()).toEqual(["bg", "snap"]);
    expect(Object.keys(body.snap).sort()).toEqual(
      ["clearedAt", "entries", "height", "tombs", "truncated", "v", "width"],
    );

    // What is NOT: the ticket that would let a stranger rejoin, the auth
    // string, the peer's endpoint id, or the per-session author id.
    expect(raw).not.toContain(ticket);
    expect(raw).not.toContain(a.sas.value ?? " no-sas");
    expect(raw).not.toContain(a.peer.value ?? " no-peer");
    for (const forbidden of ["nonce", "welcome", "key_package", "endpoint", "secret"]) {
      expect(raw.toLowerCase(), `${forbidden} must not reach the disk`).not.toContain(forbidden);
    }
  });

  it("does not write a live stroke or a cursor", async () => {
    // Ephemeral by design: they are redrawn twenty times a second and mean
    // nothing after the gesture. Persisting them would write constantly.
    const net = makeFakeNet();
    const { store, written } = fakeStore();
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store });
    a.attach(A);

    A.beginStroke(0, 0);
    A.extendStroke(10, 10);
    A.pointer.value = { x: 5, y: 5 };
    await settle();
    expect(written.size, "a stroke in progress is not a document").toBe(0);

    A.commitStroke();
    await settle();
    expect(written.size, "the finished stroke is").toBe(1);
  });
});
