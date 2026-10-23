import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";
import { useVoxCall } from "../../src/components/vox/useVoxCall";
import { refreshHp, resolveHpConfirm, hpConfirm, stopHp } from "../../src/components/hp/useHp";
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
// Privacy HP helpers, so only the nickname lookup is replaced.
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

// ── the rest of the state machine ───────────────────────────────────────────
// What follows pins the paths a call takes when it does NOT go smoothly: a
// stranger dialling our one-shot window, a member who declines, a backend that
// throws, and the settle-back to idle that the panel's start screen relies on.

const callsTo = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

describe("useVoxCall — backend events", () => {
  it("declines a stranger who dials in while our room offer is pending", async () => {
    // While we wait for the member we rang, our listener is open to anyone who
    // holds the ticket; only the call id we offered may be auto-accepted.
    const { vox } = await freshVox(true);
    await vox.callPeer({ id: "bob-id", name: "Bob" });
    await flush();
    fire("vox://incoming", { from_name: "Mallory", node_id: "m", call_id: "not-ours" });
    await flush();
    expect(callsTo("vox_decline")).toHaveLength(1);
    expect(callsTo("vox_accept")).toHaveLength(0);
    // The ring is handled silently: no incoming prompt for the stranger.
    expect(vox.phase.value).toBe("calling");
    expect(vox.incomingName.value).toBe("");
  });

  it("names an anonymous caller 'Unknown'", async () => {
    const { vox } = await freshVox(true);
    fire("vox://incoming", { from_name: "", node_id: "n", call_id: "x" });
    expect(vox.incomingName.value).toBe("Unknown");
  });

  it("treats a spectrum frame without bands as silence", async () => {
    const { vox } = await freshVox(true);
    fire("vox://spectrum", { bands: [0.2] });
    fire("vox://spectrum", {});
    expect(vox.spectrum.value).toEqual([]);
  });

  it("moves to calling on the backend's say-so, and learns the ringing peer's name", async () => {
    const { vox } = await freshVox(true);
    fire("vox://state", { state: "calling", peer: null });
    expect(vox.phase.value).toBe("calling");
    fire("vox://state", { state: "ringing", peer: "Dana" });
    expect(vox.incomingName.value).toBe("Dana");
    fire("vox://state", { state: "ringing", peer: null });
    expect(vox.incomingName.value).toBe("Dana");
  });

  it("falls back to the ringing name, then 'Peer', for a connected call with no peer", async () => {
    const a = await freshVox(true);
    fire("vox://incoming", { from_name: "Erin", node_id: "n", call_id: "x" });
    fire("vox://state", { state: "connected", peer: null });
    expect(a.vox.peerName.value).toBe("Erin");
    expect(a.vox.incomingName.value).toBe("");

    const b = await freshVox(true);
    fire("vox://state", { state: "connected", peer: null });
    expect(b.vox.peerName.value).toBe("Peer");
  });

  it("assumes transport-only encryption when the backend does not say MLS", async () => {
    // Claiming end-to-end encryption by default would be the dangerous error.
    const { vox } = await freshVox(true);
    fire("vox://state", { state: "connected", peer: "bob" });
    expect(vox.encryption.value).toBe("transport");
  });
});

describe("useVoxCall — ending a call", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bills the call's real duration, rounded up to the minute, when it ends", async () => {
    const { vox } = await freshVox(true);
    vi.useFakeTimers();
    fire("vox://state", { state: "connected", peer: "bob", encryption: "mls" });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(vox.callSeconds.value).toBe(61);
    fire("vox://state", { state: "ended", peer: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo("hp_charge").map((c) => c[1])).toEqual([{ actionId: "vox.call", bytes: null, minutes: 2 }]);
    // The clock stops with the call.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vox.callSeconds.value).toBe(61);
  });

  it("bills nothing for a call that never reached its first second", async () => {
    await freshVox(true);
    vi.useFakeTimers();
    fire("vox://state", { state: "connected", peer: "bob", encryption: "mls" });
    fire("vox://state", { state: "ended", peer: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo("hp_charge")).toHaveLength(0);
  });

  it("shows an ended call briefly, then settles back to the start screen", async () => {
    const { vox } = await freshVox(true);
    vi.useFakeTimers();
    fire("vox://state", { state: "connected", peer: "bob", encryption: "mls" });
    fire("vox://state", { state: "ended", peer: null });
    expect(vox.phase.value).toBe("ended");
    await vi.advanceTimersByTimeAsync(1_499);
    expect(vox.phase.value).toBe("ended");
    await vi.advanceTimersByTimeAsync(1);
    expect(vox.phase.value).toBe("idle");
    expect(vox.peerName.value).toBe("");
    expect(vox.encryption.value).toBe("");
  });

  it("reports a backend error, then settles back too", async () => {
    const { vox } = await freshVox(true);
    vi.useFakeTimers();
    fire("vox://state", { state: "error", peer: null });
    expect(vox.phase.value).toBe("error");
    expect(vox.error.value).toBe("vox.errorGeneric");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(vox.phase.value).toBe("idle");
  });

  it("does not wipe a new call that started during the settle delay", async () => {
    const { vox } = await freshVox(true);
    vi.useFakeTimers();
    fire("vox://state", { state: "ended", peer: null });
    fire("vox://incoming", { from_name: "Fay", node_id: "n", call_id: "y" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(vox.phase.value).toBe("incoming");
    expect(vox.incomingName.value).toBe("Fay");
  });
});

describe("useVoxCall — refusals and failures", () => {
  // The HP meter is module state; never let a drained one leak into a later test.
  afterEach(() => stopHp());

  it("refuses every way of starting a call in a plain browser", async () => {
    const { vox, stub } = await freshVox(false);
    for (const start of [
      () => vox.joinByTicket("tkt"),
      () => vox.callNode("node"),
      () => vox.callByNick("bob"),
      () => vox.callPeer({ id: "bob-id" }),
    ]) {
      vox.error.value = "";
      await start();
      expect(vox.error.value).toBe("vox.desktopOnly");
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(dhtFindNick).not.toHaveBeenCalled();
    expect(stub.sendSync).not.toHaveBeenCalled();
    // Nor does a browser build bind the node or listen for rings.
    expect(stub.ensureNode).not.toHaveBeenCalled();
    expect(backendListeners.size).toBe(0);
  });

  it("ignores blank targets without touching the backend", async () => {
    const { vox, stub } = await freshVox(true);
    invoke.mockClear();
    await vox.joinByTicket("   ");
    await vox.callNode("  ");
    await vox.callByNick(" ");
    await vox.callPeer({ id: "" });
    expect(invoke).not.toHaveBeenCalled();
    expect(dhtFindNick).not.toHaveBeenCalled();
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(vox.phase.value).toBe("idle");
  });

  it("surfaces a failed ticket call as an error phase with the backend's message", async () => {
    const { vox } = await freshVox(true);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vox_create") throw new Error("TOR_BLOCKED");
      return undefined;
    });
    await vox.createCall();
    expect(vox.phase.value).toBe("error");
    expect(vox.error.value).toBe("TOR_BLOCKED");
  });

  it("falls back to the generic message when a failure carries none", async () => {
    const { vox } = await freshVox(true);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vox_join" || cmd === "vox_call_node") throw new Error("");
      return undefined;
    });
    await vox.joinByTicket("tkt");
    expect(vox.error.value).toBe("vox.errorGeneric");
    expect(vox.phase.value).toBe("error");
    vox.error.value = "";
    await vox.callNode("node-1");
    expect(vox.error.value).toBe("vox.errorGeneric");
    expect(vox.phase.value).toBe("error");
  });

  it("explains a nickname lookup that could not run", async () => {
    const { vox } = await freshVox(true);
    dhtFindNick.mockRejectedValueOnce(new Error("DHT_DISABLED"));
    await vox.callByNick("bob");
    expect(vox.error.value).toBe("DHT_DISABLED");
    dhtFindNick.mockRejectedValueOnce(new Error(""));
    await vox.callByNick("bob");
    expect(vox.error.value).toBe("vox.needsDht");
    expect(callsTo("vox_call_node")).toHaveLength(0);
  });

  it("clears an old pick-list when a nickname is dialled directly", async () => {
    const { vox } = await freshVox(true);
    dhtFindNick.mockResolvedValueOnce([
      { node_id: "n1", name: "bob", ts: 2 },
      { node_id: "n2", name: "bob", ts: 1 },
    ]);
    await vox.callByNick("bob");
    expect(vox.nickResults.value).toHaveLength(2);
    await vox.callNode("n2", "bob");
    expect(vox.nickResults.value).toEqual([]);
    expect(vox.peerName.value).toBe("bob");
  });

  it("forgets a room offer whose slot could not be opened, so later rings are normal", async () => {
    const { vox, stub } = await freshVox(true);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vox_create") throw new Error("no endpoint");
      return undefined;
    });
    await vox.callPeer({ id: "bob-id", name: "Bob" });
    expect(vox.phase.value).toBe("error");
    expect(vox.error.value).toBe("no endpoint");
    expect(stub.sendSync).not.toHaveBeenCalled();

    fire("vox://incoming", { from_name: "Gus", node_id: "n", call_id: "z" });
    expect(vox.phase.value).toBe("incoming");
    expect(callsTo("vox_decline")).toHaveLength(0);
  });

  it("sends no offer when the user declines the call's price", async () => {
    // confirmHp only asks when the meter is already empty; drain it, then say no.
    const { vox, stub } = await freshVox(true);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "hp_ledger") return [{ ts: Date.now(), kind: "spend", code: "x", hp: -1_000_000, n: 1, bucket: 0 }];
      if (cmd === "vox_create") return { ticket: "tkt-abc", node_id: "node-1", call_id: "cid-1" };
      return undefined;
    });
    await refreshHp();
    const pending = vox.callPeer({ id: "bob-id", name: "Bob" });
    await flush();
    expect(hpConfirm.value).not.toBeNull();
    resolveHpConfirm(false);
    await pending;
    expect(callsTo("vox_create")).toHaveLength(0);
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(vox.phase.value).toBe("idle");
  });
});

describe("useVoxCall — who we say we are", () => {
  it("introduces itself by device identity when the profile name is the placeholder", async () => {
    const { vox, stub } = await freshVox(true);
    stub.currentUserName.value = "You";
    await vox.createCall();
    expect(invoke).toHaveBeenCalledWith("vox_create", { name: "alice-id", identity: "alice-id" });
  });

  it("falls back to 'Caller' and the profile name when there is no device identity", async () => {
    const { vox, stub } = await freshVox(true);
    stub.mlsIdentity.value = "";
    stub.currentUserName.value = "";
    await vox.createCall();
    expect(invoke).toHaveBeenCalledWith("vox_create", { name: "Caller", identity: "anon" });

    stub.currentUserName.value = "Zoe";
    await vox.createCall();
    expect(invoke).toHaveBeenLastCalledWith("vox_create", { name: "Zoe", identity: "Zoe" });
  });

  it("still offers a call when crypto.randomUUID is unavailable", async () => {
    // Older WebViews lack randomUUID; the offer id only has to be unique enough
    // to match a decline/cancel to its offer.
    const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("not supported");
    });
    try {
      const { vox, stub } = await freshVox(true);
      await vox.callPeer({ id: "bob-id" });
      const offer = stub.sendSync.mock.calls.find((c) => c[0] === "vox_offer")!;
      expect(String((offer[1] as { offerId: string }).offerId)).toMatch(/^\d+-[a-z0-9]+$/);
      // With no display name, the member is shown by id.
      expect(vox.peerName.value).toBe("bob-id");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("useVoxCall — call controls", () => {
  it("accepts an ordinary inbound call at the backend, swallowing a call that vanished", async () => {
    const { vox } = await freshVox(true);
    fire("vox://incoming", { from_name: "bob", node_id: "n", call_id: "x" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vox_accept") throw new Error("call gone");
      return undefined;
    });
    await expect(vox.accept()).resolves.toBeUndefined();
    expect(callsTo("vox_accept")).toHaveLength(1);
    expect(callsTo("vox_join")).toHaveLength(0);
  });

  it("declines a room offer over the channel, not the backend", async () => {
    const { vox, stub, emitSync } = await freshVox(true);
    emitSync("vox_offer", { offerId: "o7", target: "alice-id", ticket: "t", fromName: "Bob" });
    stub.sendSync.mockRejectedValueOnce(new Error("channel closed"));
    await vox.decline();
    expect(stub.sendSync).toHaveBeenCalledWith("vox_decline", { offerId: "o7" });
    expect(callsTo("vox_decline")).toHaveLength(0);
    expect(vox.phase.value).toBe("idle");
  });

  it("declines an ordinary inbound call at the backend", async () => {
    const { vox, stub } = await freshVox(true);
    fire("vox://incoming", { from_name: "bob", node_id: "n", call_id: "x" });
    invoke.mockRejectedValueOnce(new Error("already gone"));
    await vox.decline();
    expect(callsTo("vox_decline")).toHaveLength(1);
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(vox.phase.value).toBe("idle");
    expect(vox.incomingName.value).toBe("");
  });

  it("withdraws a pending room offer for the member when we hang up first", async () => {
    const { vox, stub } = await freshVox(true);
    await vox.callPeer({ id: "bob-id", name: "Bob" });
    const offerId = (stub.sendSync.mock.calls.find((c) => c[0] === "vox_offer")![1] as { offerId: string }).offerId;
    stub.sendSync.mockRejectedValueOnce(new Error("channel closed"));
    invoke.mockRejectedValueOnce(new Error("nothing to hang up"));
    await vox.hangup();
    expect(stub.sendSync).toHaveBeenCalledWith("vox_cancel", { offerId });
    expect(vox.phase.value).toBe("idle");
  });

  it("restart ends the current call so a fresh one can retry MLS", async () => {
    const { vox } = await freshVox(true);
    fire("vox://state", { state: "connected", peer: "bob", encryption: "transport" });
    await vox.restart();
    expect(callsTo("vox_hangup")).toHaveLength(1);
    expect(vox.phase.value).toBe("idle");
    expect(vox.encryption.value).toBe("");
  });

  it("keeps the mute flag as it was when the backend refuses", async () => {
    const { vox } = await freshVox(true);
    invoke.mockRejectedValueOnce(new Error("no call"));
    await vox.toggleMute();
    expect(vox.muted.value).toBe(false);
    await vox.toggleMute();
    await vox.toggleMute();
    expect(invoke).toHaveBeenLastCalledWith("vox_set_mute", { muted: false });
    expect(vox.muted.value).toBe(false);
  });
});

describe("useVoxCall — room signalling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores sync traffic that is not a call's", async () => {
    const { vox, emitSync } = await freshVox(true);
    emitSync("file_offer", { offerId: "f1", target: "alice-id" });
    emitSync("sync_snapshot", {});
    expect(vox.phase.value).toBe("idle");
  });

  it("rings for an unaddressed offer, naming the sender when the offer does not", async () => {
    // A 1:1 room may omit the target; the MLS sender is the best name we have.
    const { vox, emitSync } = await freshVox(true);
    emitSync("vox_offer", { offerId: "o1" }, "bob-device");
    expect(vox.phase.value).toBe("incoming");
    expect(vox.incomingName.value).toBe("bob-device");
    await vox.accept();
    // An offer with no ticket dials nothing.
    expect(callsTo("vox_join")).toHaveLength(0);
  });

  it("ends our call when the member we rang declines it", async () => {
    const { vox, stub, emitSync } = await freshVox(true);
    await vox.callPeer({ id: "bob-id", name: "Bob" });
    const offerId = (stub.sendSync.mock.calls.find((c) => c[0] === "vox_offer")![1] as { offerId: string }).offerId;
    vi.useFakeTimers();
    emitSync("vox_decline", { offerId });
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo("vox_hangup")).toHaveLength(1);
    expect(vox.error.value).toBe("vox.declined");
    expect(vox.phase.value).toBe("ended");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(vox.phase.value).toBe("idle");
  });

  it("ignores a decline for an offer that is not ours", async () => {
    const { vox, emitSync } = await freshVox(true);
    await vox.callPeer({ id: "bob-id", name: "Bob" });
    emitSync("vox_decline", { offerId: "someone-elses" });
    expect(vox.phase.value).toBe("calling");
    expect(vox.error.value).toBe("");
  });

  it("stops ringing when the caller withdraws the offer, and only that offer", async () => {
    const { vox, emitSync } = await freshVox(true);
    emitSync("vox_offer", { offerId: "o1", target: "alice-id", ticket: "t", fromName: "Bob" });
    emitSync("vox_cancel", { offerId: "other" });
    expect(vox.phase.value).toBe("incoming");
    emitSync("vox_cancel", { offerId: "o1" });
    expect(vox.phase.value).toBe("idle");
    expect(vox.incomingName.value).toBe("");
  });

  it("works with a channel that cannot bind a node up front", async () => {
    backendListeners.clear();
    const ctx = makeChannel();
    delete (ctx.stub as { ensureNode?: unknown }).ensureNode;
    const vox = useVoxCall(ctx.channel);
    await flush();
    expect(vox.available).toBe(true);
    expect(typeof backendListeners.get("vox://state")).toBe("function");
  });
});
