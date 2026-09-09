// The session over a yrs board — the document that actually ships.
//
// These drive `crates/board` through a helper process (tests/helpers/fakeBoard),
// so a test saying "two peers converge" is a statement about the Rust in
// production, not about a JavaScript lookalike written to agree with it.
//
// What is pinned here is the SEAM: that the session drives the board, sends
// what the board produced, merges what arrives, and keeps the undo boundary.
// Convergence itself belongs to crates/board and is tested there.
import { afterEach, describe, expect, it } from "vitest";
import { createSketch, type Sketch } from "wisteria/useSketch";
import { createCollabSession, SAVE_DEBOUNCE_MS } from "../../src/collab/useCollabSession";
import type { BoardStore } from "../../src/collab/persist";
import { fakeBoardDoc } from "../helpers/fakeBoard";
import { makeFakeNet } from "../helpers/fakeBus";

const boards: Array<{ close(): void }> = [];

function board() {
  const d = fakeBoardDoc();
  boards.push(d);
  return d;
}

afterEach(() => {
  for (const b of boards.splice(0)) b.close();
});

function ids(s: Sketch): string[] {
  return s.doc.value.shapes.map((x) => x.id);
}

function rect(s: Sketch, x = 10) {
  s.addRect(x, x, 50, 40);
  return ids(s).at(-1)!;
}

/** The session writes to the board asynchronously, so let those land. */
async function settle(net?: { settle(): Promise<void> }) {
  for (let i = 0; i < 8; i++) {
    await net?.settle();
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Host A and joiner B, paired and accepted, both on real yrs boards. */
async function pair() {
  const net = makeFakeNet();
  const A = createSketch();
  const B = createSketch();
  const a = createCollabSession(net.host, { me: "alice", doc: board() });
  const b = createCollabSession(net.joiner, { me: "bob", doc: board() });
  a.attach(A);
  b.attach(B);
  await a.host();
  await b.join(a.ticket.value!);
  await net.settle();
  await a.accept();
  await settle(net);
  return { net, A, B, a, b };
}

describe("drawing on a yrs board", () => {
  it("puts a local shape on the board and shows it at once", async () => {
    const A = createSketch();
    const a = createCollabSession(makeFakeNet().host, { me: "alice", doc: board() });
    a.attach(A);
    const id = rect(A);
    // The engine answers synchronously — the user's own stroke may not wait
    // for a round trip to Rust.
    expect(ids(A)).toEqual([id]);
    await settle();
    expect(ids(A)).toEqual([id]);
  });

  it("carries a shape to the peer", async () => {
    const { net, A, B } = await pair();
    const id = rect(A, 30);
    await settle(net);
    expect(ids(B)).toEqual([id]);
  });

  it("carries a shape in BOTH directions", async () => {
    const { net, A, B } = await pair();
    const fromA = rect(A, 10);
    await settle(net);
    const fromB = rect(B, 200);
    await settle(net);
    expect(ids(A).sort()).toEqual([fromA, fromB].sort());
    expect(ids(B).sort()).toEqual([fromA, fromB].sort());
  });

  it("converges when both peers draw at once", async () => {
    // The property the whole CRDT exists for, over the real transport seam.
    const { net, A, B } = await pair();
    rect(A, 10);
    rect(B, 200);
    await settle(net);
    await settle(net);
    expect(ids(A).sort()).toEqual(ids(B).sort());
    expect(ids(A)).toHaveLength(2);
  });

  it("carries a delete", async () => {
    const { net, A, B } = await pair();
    const id = rect(A, 10);
    await settle(net);
    expect(ids(B)).toEqual([id]);
    A.selectedId.value = id;
    A.deleteSelected();
    await settle(net);
    expect(ids(B)).toEqual([]);
  });

  it("carries an edit without reordering the board", async () => {
    // Editing a shape must not bring it to the front — the reason the paint
    // order is a separate array in the crate.
    const { net, A, B } = await pair();
    const first = rect(A, 10);
    const second = rect(A, 60);
    await settle(net);
    expect(ids(B)).toEqual([first, second]);
    A.selectedId.value = first;
    A.moveSelected(5, 5);
    await settle(net);
    expect(ids(B), "the edited shape stays first").toEqual([first, second]);
  });

  it("carries a clear", async () => {
    const { net, A, B } = await pair();
    rect(A, 10);
    rect(A, 60);
    await settle(net);
    A.clearBoard();
    await settle(net);
    expect(ids(B)).toEqual([]);
  });

  it("carries the background colour", async () => {
    const { net, A, B } = await pair();
    A.setBackground("#111827");
    await settle(net);
    expect(B.doc.value.background).toBe("#111827");
  });

  it("gives the joiner the host's board size", async () => {
    // A joiner that assumed its own default would put the host's stroke at
    // x=3000 off its own edge.
    const net = makeFakeNet();
    const A = createSketch();
    const B = createSketch();
    A.envelope.value = { ...A.envelope.value, width: 640, height: 480 };
    const a = createCollabSession(net.host, { me: "alice", doc: board() });
    const b = createCollabSession(net.joiner, { me: "bob", doc: board() });
    a.attach(A);
    b.attach(B);
    await a.host();
    await b.join(a.ticket.value!);
    await net.settle();
    await a.accept();
    await settle(net);
    expect(B.envelope.value.width).toBe(640);
    expect(B.envelope.value.height).toBe(480);
  });

  it("gives a joiner what the host had already drawn", async () => {
    const net = makeFakeNet();
    const A = createSketch();
    const B = createSketch();
    const a = createCollabSession(net.host, { me: "alice", doc: board() });
    const b = createCollabSession(net.joiner, { me: "bob", doc: board() });
    a.attach(A);
    b.attach(B);
    const drawn = rect(A, 10);
    await a.host();
    await settle();
    await b.join(a.ticket.value!);
    await net.settle();
    await a.accept();
    await settle(net);
    expect(ids(B)).toEqual([drawn]);
  });

  it("sends nothing before the host accepts", async () => {
    // The rule the whole admission gate exists for: the document leaves the
    // host only after a human said yes.
    const net = makeFakeNet();
    const A = createSketch();
    const B = createSketch();
    const a = createCollabSession(net.host, { me: "alice", doc: board() });
    const b = createCollabSession(net.joiner, { me: "bob", doc: board() });
    a.attach(A);
    b.attach(B);
    rect(A, 10);
    await a.host();
    await settle();
    await b.join(a.ticket.value!);
    await net.settle();
    await settle();
    expect(ids(B), "nothing crosses before Accept").toEqual([]);
  });
});

describe("what the yrs path no longer needs", () => {
  it("never reports a truncated board", async () => {
    // 1000 shapes encode to ~123 KB where the JSON snapshot had to be cut at
    // 700 KB. The flag, its panel line and its strings are dead on this path.
    const { net, A, a } = await pair();
    for (let i = 0; i < 40; i++) rect(A, i * 3);
    await settle(net);
    expect(a.truncated.value).toBe(false);
  });
});

describe("the board on disk, over yrs", () => {
  it("writes the document and brings it back", async () => {
    const written = new Map<string, string>();
    const store: BoardStore = {
      save: async (b, snap) => void written.set(b, snap),
      load: async (b) => written.get(b) ?? null,
      forget: async (b) => void written.delete(b),
    };
    const net = makeFakeNet();
    const A = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store, doc: board() });
    a.attach(A);
    const id = rect(A, 10);
    await settle();
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 20));
    await settle();
    expect(written.size).toBe(1);

    // A fresh session over the same store, the way a restart arrives.
    const B = createSketch();
    const b = createCollabSession(net.joiner, { me: "alice-again", store, doc: board() });
    b.attach(B);
    expect(await b.restore()).toBe(true);
    await settle();
    expect(ids(B)).toEqual([id]);
  });

  it("stores the document and nothing else", async () => {
    // THE RULE, on this path too: no ticket, no auth string, no peer id, no
    // key material. The stored body is a yrs update and nothing beside it.
    const written = new Map<string, string>();
    const store: BoardStore = {
      save: async (b, snap) => void written.set(b, snap),
      load: async () => null,
      forget: async () => {},
    };
    const net = makeFakeNet();
    const A = createSketch();
    const B = createSketch();
    const a = createCollabSession(net.host, { me: "alice", store, doc: board() });
    const b = createCollabSession(net.joiner, { me: "bob", doc: board() });
    a.attach(A);
    b.attach(B);
    await a.host();
    const ticket = a.ticket.value!;
    await b.join(ticket);
    await net.settle();
    await a.accept();
    await settle(net);
    rect(A, 10);
    await settle(net);
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 20));
    await settle();

    const raw = written.get("current")!;
    expect(Object.keys(JSON.parse(raw)), "the update, and nothing beside it").toEqual(["y"]);
    expect(raw).not.toContain(ticket);
    expect(raw).not.toContain(a.sas.value ?? " no-sas");
    for (const forbidden of ["nonce", "welcome", "key_package", "endpoint", "secret"]) {
      expect(raw.toLowerCase(), `${forbidden} must not reach the disk`).not.toContain(forbidden);
    }
  });
});
