import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { useVoxCall } from "../../src/components/vox/useVoxCall";
import type { ChatChannel } from "rakotis";

// useVoxCall drives the `vox_*` Tauri commands + `vox://*` events, and rides the
// chat channel's MLS `onSync`/`sendSync` seam for the "call a room member" flow.
// We stub the tauri bridge, the channel, and the DHT nickname lookup; the media
// pipeline is the Rust backend's job (covered by its own tests).

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => (invoke as any)(...a) }));

const backendListeners = new Map<string, (e: { payload: any }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: any }) => void) => {
    backendListeners.set(name, cb);
    return () => backendListeners.delete(name);
  }),
}));

const dhtFindNick = vi.fn(async (_nick: string) => [] as { node_id: string; name: string; ts: number }[]);
// PARTIAL mock (see torConnect.test.ts): the controller also uses rakotis'
// Privacy MANA helpers, so only the nickname lookup is replaced.
vi.mock("rakotis", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dhtFindNick: (...a: unknown[]) => (dhtFindNick as any)(...a),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));
const fire = (name: string, payload: unknown) => backendListeners.get(name)?.({ payload });

function makeChannel() {
  let handler: ((type: string, payload: Record<string, unknown>, sender: string) => void) | null = null;
  const stub = {
    onSync: vi.fn((fn: typeof handler) => {
      handler = fn;
      return () => (handler = null);
    }),
    sendSync: vi.fn(async () => {}),
    ensureNode: vi.fn(async () => {}),
    currentUserName: ref("alice"),
    mlsIdentity: ref("alice-id"),
    participants: ref([{ id: "alice-id", name: "alice" }]),
  };
  const emitSync = (type: string, payload: Record<string, unknown>, sender = "bob") =>
    handler?.(type, payload, sender);
  return { channel: stub as unknown as ChatChannel, stub, emitSync };
}

/** Build a controller with listeners already registered. */
async function freshVox(tauri = true) {
  backendListeners.clear();
  invoke.mockClear();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "vox_create") return { ticket: "tkt-abc", node_id: "node-1", call_id: "cid-1" };
    return undefined;
  });
  if (tauri) (window as any).__TAURI_INTERNALS__ = {};
  else delete (window as any).__TAURI_INTERNALS__;
  const ctx = makeChannel();
  const vox = useVoxCall(ctx.channel);
  await flush(); // let the constructor's ensureListeners() register
  return { vox, ...ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  backendListeners.clear();
  (window as any).__TAURI_INTERNALS__ = {};
});

describe("useVoxCall — iroh voice controller", () => {
  it("registers listeners on construction and lazily binds the node", async () => {
    const { stub } = await freshVox(true);
    expect(typeof backendListeners.get("vox://incoming")).toBe("function");
    expect(typeof backendListeners.get("vox://state")).toBe("function");
    expect(typeof backendListeners.get("vox://spectrum")).toBe("function");
    expect(stub.ensureNode).toHaveBeenCalled();
  });

  it("createCall opens a ticket and waits", async () => {
    const { vox } = await freshVox(true);
    await vox.createCall();
    await flush();
    expect(invoke).toHaveBeenCalledWith("vox_create", { name: "alice", identity: "alice-id" });
    expect(vox.phase.value).toBe("waiting");
    expect(vox.ticket.value).toBe("tkt-abc");
  });

  it("an incoming event puts the call into the ringing state", async () => {
    const { vox } = await freshVox(true);
    fire("vox://incoming", { from_name: "bob", node_id: "n", call_id: "x" });
    expect(vox.phase.value).toBe("incoming");
    expect(vox.incomingName.value).toBe("bob");
  });

  it("a connected state event starts the live call", async () => {
    const { vox } = await freshVox(true);
    fire("vox://state", { state: "connected", peer: "bob", encryption: "mls" });
    expect(vox.phase.value).toBe("connected");
    expect(vox.peerName.value).toBe("bob");
    expect(vox.encryption.value).toBe("mls");
  });

  it("marks a call transport-only when MLS is unavailable", async () => {
    const { vox } = await freshVox(true);
    fire("vox://state", { state: "connected", peer: "bob", encryption: "transport" });
    expect(vox.encryption.value).toBe("transport");
  });

  it("vox://spectrum updates the live equalizer bands", async () => {
    const { vox } = await freshVox(true);
    fire("vox://spectrum", { bands: [0.1, 0.5, 1] });
    expect(vox.spectrum.value).toEqual([0.1, 0.5, 1]);
  });

  it("joinByTicket dials the trimmed ticket as the caller", async () => {
    const { vox } = await freshVox(true);
    await vox.joinByTicket("  tkt-xyz  ");
    await flush();
    expect(vox.phase.value).toBe("calling");
    expect(invoke).toHaveBeenCalledWith("vox_join", { ticket: "tkt-xyz", name: "alice", identity: "alice-id" });
  });

  // ── nickname / contact ──────────────────────────────────────────────────────
  it("callByNick dials the sole claim's node", async () => {
    const { vox } = await freshVox(true);
    dhtFindNick.mockResolvedValueOnce([{ node_id: "bob-node", name: "bob", ts: 1 }]);
    await vox.callByNick("  bob  ");
    await flush();
    expect(dhtFindNick).toHaveBeenCalledWith("bob");
    expect(invoke).toHaveBeenCalledWith("vox_call_node", {
      nodeId: "bob-node",
      name: "alice",
      identity: "alice-id",
    });
    expect(vox.phase.value).toBe("calling");
  });

  it("callByNick surfaces a pick-list when several claim the nickname", async () => {
    const { vox } = await freshVox(true);
    dhtFindNick.mockResolvedValueOnce([
      { node_id: "n1", name: "bob", ts: 2 },
      { node_id: "n2", name: "bob", ts: 1 },
    ]);
    await vox.callByNick("bob");
    await flush();
    expect(vox.nickResults.value.length).toBe(2);
    expect(invoke).not.toHaveBeenCalledWith("vox_call_node", expect.anything());
  });

  it("callByNick reports an offline contact when no claim exists", async () => {
    const { vox } = await freshVox(true);
    dhtFindNick.mockResolvedValueOnce([]);
    await vox.callByNick("ghost");
    await flush();
    expect(vox.error.value).toBe("vox.contactOffline");
    expect(invoke).not.toHaveBeenCalledWith("vox_call_node", expect.anything());
  });

  it("callNode dials a NodeId directly", async () => {
    const { vox } = await freshVox(true);
    await vox.callNode("saved-node", "Saved");
    await flush();
    expect(invoke).toHaveBeenCalledWith("vox_call_node", {
      nodeId: "saved-node",
      name: "alice",
      identity: "alice-id",
    });
    expect(vox.phase.value).toBe("calling");
  });

  // ── room-peer flow ──────────────────────────────────────────────────────────
  it("callPeer creates a slot, offers over the channel and auto-accepts the match", async () => {
    const { vox, stub } = await freshVox(true);
    await vox.callPeer({ id: "bob-id", name: "Bob" });
    await flush();
    expect(invoke).toHaveBeenCalledWith("vox_create", { name: "alice", identity: "alice-id" });
    const offer = stub.sendSync.mock.calls.find((c) => c[0] === "vox_offer");
    expect(offer).toBeTruthy();
    expect(offer![1]).toMatchObject({ target: "bob-id", ticket: "tkt-abc", callId: "cid-1" });
    expect(vox.phase.value).toBe("calling");
    // The target dials us back → our backend rings with the matching call id → auto-accept.
    fire("vox://incoming", { from_name: "Bob", node_id: "n", call_id: "cid-1" });
    await flush();
    expect(invoke.mock.calls.some((c) => c[0] === "vox_accept")).toBe(true);
    expect(vox.phase.value).toBe("calling"); // stays until "connected" arrives
  });

  it("a room offer addressed to us rings; accept dials the offered ticket", async () => {
    const { vox, emitSync } = await freshVox(true);
    emitSync("vox_offer", { offerId: "o1", target: "alice-id", ticket: "tkt-room", fromName: "Bob" });
    expect(vox.phase.value).toBe("incoming");
    expect(vox.incomingName.value).toBe("Bob");
    await vox.accept();
    await flush();
    expect(invoke).toHaveBeenCalledWith("vox_join", { ticket: "tkt-room", name: "alice", identity: "alice-id" });
  });

  it("ignores a room offer addressed to someone else", async () => {
    const { vox, emitSync } = await freshVox(true);
    emitSync("vox_offer", { offerId: "o1", target: "carol-id", ticket: "t", fromName: "Bob" });
    expect(vox.phase.value).toBe("idle");
  });

  it("auto-declines a room offer while busy", async () => {
    const { vox, stub, emitSync } = await freshVox(true);
    fire("vox://state", { state: "connected", peer: "bob", encryption: "mls" }); // now busy
    emitSync("vox_offer", { offerId: "o2", target: "alice-id", ticket: "t", fromName: "Carol" });
    expect(stub.sendSync).toHaveBeenCalledWith("vox_decline", { offerId: "o2" });
    expect(vox.phase.value).toBe("connected");
  });

  // ── controls ────────────────────────────────────────────────────────────────
  it("toggleMute flips the mute flag through the backend", async () => {
    const { vox } = await freshVox(true);
    await vox.toggleMute();
    expect(invoke).toHaveBeenCalledWith("vox_set_mute", { muted: true });
    expect(vox.muted.value).toBe(true);
  });

  it("hangup tears the call down and returns to idle", async () => {
    const { vox } = await freshVox(true);
    await vox.createCall();
    await flush();
    await vox.hangup();
    expect(invoke.mock.calls.some((c) => c[0] === "vox_hangup")).toBe(true);
    expect(vox.phase.value).toBe("idle");
    expect(vox.ticket.value).toBe("");
  });

  it("is unavailable (no backend call) in a plain browser", async () => {
    const { vox } = await freshVox(false);
    expect(vox.available).toBe(false);
    await vox.createCall();
    expect(vox.error.value).toBe("vox.desktopOnly");
    expect(invoke).not.toHaveBeenCalled();
  });
});
