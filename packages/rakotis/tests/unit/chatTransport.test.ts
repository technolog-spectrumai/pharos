import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri bridge so we can exercise the Rust-gateway backend of
// chatTransport without a real Tauri runtime.
const invoke = vi.fn(async () => undefined as unknown);
const listeners: Record<string, (e: { payload: unknown }) => void> = {};

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => (invoke as any)(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners[name] = cb;
    return () => {};
  }),
}));

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("chatTransport — room-multiplexing Rust gateway backend (P2P only)", () => {
  let transport: any;

  beforeEach(async () => {
    invoke.mockClear();
    for (const k of Object.keys(listeners)) delete listeners[k];
    (window as any).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    transport = (await import("../../src/chatTransport")).chatTransport;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("send routes the payload to a specific room via realtime_send", async () => {
    transport.send("room-1", { type: "chat_message", message: "hi" });
    await tick();
    expect(invoke).toHaveBeenCalledWith("realtime_send", {
      room: "room-1",
      payload: JSON.stringify({ type: "chat_message", message: "hi" }),
    });
  });

  it("incoming messages are dispatched room-tagged to onMessage", async () => {
    const got: Array<[string, any]> = [];
    transport.onMessage((room: string, data: any) => got.push([room, data]));
    await tick();
    listeners["realtime://message"]({
      payload: { room: "room-7", payload: JSON.stringify({ type: "chat_message", message: "yo" }) },
    });
    expect(got).toEqual([["room-7", { type: "chat_message", message: "yo" }]]);
  });

  it("status events are dispatched room-tagged to onStatus", async () => {
    const got: Array<[string, string]> = [];
    transport.onStatus((room: string, state: string) => got.push([room, state]));
    await tick();
    listeners["realtime://status"]({ payload: { room: "room-9", state: "connected" } });
    expect(got).toContainEqual(["room-9", "connected"]);
    expect(transport.lastStatus("room-9")).toBe("connected");
  });

  it("neighbor-up status events carry the peer NodeId (the reconnect handle)", async () => {
    const got: Array<[string, string, string | undefined]> = [];
    transport.onStatus((room: string, state: string, peerId?: string) => got.push([room, state, peerId]));
    await tick();
    listeners["realtime://status"]({
      payload: { room: "room-2", state: "connected", peers: 1, peer_id: "node-abc" },
    });
    listeners["realtime://status"]({
      payload: { room: "room-2", state: "disconnected", peers: 0, peer_id: null },
    });
    expect(got).toContainEqual(["room-2", "connected", "node-abc"]);
    expect(got).toContainEqual(["room-2", "disconnected", undefined]);
  });

  it("createRoom returns a room, not a credential", async () => {
    // It used to hand back a permanent ticket. Creating a room now produces
    // nothing shareable — letting someone in is a separate, deliberate act.
    invoke.mockResolvedValueOnce({ room: "topic-abc", name: "general", onion: "" });
    const created = await transport.createRoom("general");
    expect(invoke).toHaveBeenCalledWith("realtime_create_room", { name: "general" });
    expect(created).toEqual({ room: "topic-abc", name: "general", onion: "" });
    expect(created).not.toHaveProperty("ticket");
  });

  it("has no join-by-ticket command left to call", async () => {
    // `realtime_join_room` is gone from the Rust command table; calling it would
    // fail at runtime rather than being merely unused.
    expect((transport as Record<string, unknown>).joinRoom).toBeUndefined();
  });

  it("joinRoomByNode bootstraps a named room from peer NodeIds — the only join", async () => {
    invoke.mockResolvedValueOnce({ room: "topic-n", name: "duo" });
    const joined = await transport.joinRoomByNode("duo", ["node-a", "node-b"]);
    expect(invoke).toHaveBeenCalledWith("realtime_join_room_by_node", {
      name: "duo",
      peerNodeIds: ["node-a", "node-b"],
    });
    expect(joined).toEqual({ room: "topic-n", name: "duo" });
  });

  it("channels filtering by room don't see each other's messages", async () => {
    const roomA: any[] = [];
    const roomB: any[] = [];
    transport.onMessage((room: string, data: any) => { if (room === "room-a") roomA.push(data); });
    transport.onMessage((room: string, data: any) => { if (room === "room-b") roomB.push(data); });
    await tick();
    listeners["realtime://message"]({ payload: { room: "room-a", payload: JSON.stringify({ m: "a" }) } });
    listeners["realtime://message"]({ payload: { room: "room-b", payload: JSON.stringify({ m: "b" }) } });
    expect(roomA).toEqual([{ m: "a" }]);
    expect(roomB).toEqual([{ m: "b" }]);
  });
});

describe("chatTransport — browser stub (no Tauri runtime)", () => {
  it("rejects P2P operations with a clear message", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.resetModules();
    const stub = (await import("../../src/chatTransport")).chatTransport;
    await expect(stub.createRoom("x")).rejects.toThrow(/desktop/i);
    await expect(stub.joinRoomByNode("x", [])).rejects.toThrow(/desktop/i);
    await expect(stub.nodeInfo()).resolves.toBeNull();
  });
});

describe("chatTransport — gateway commands and awkward frames", () => {
  let transport: any;

  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    for (const k of Object.keys(listeners)) delete listeners[k];
    (window as any).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    transport = (await import("../../src/chatTransport")).chatTransport;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("drops a frame that is not JSON instead of throwing into every handler", async () => {
    const got: unknown[] = [];
    transport.onMessage((_room: string, data: unknown) => got.push(data));
    await tick();
    listeners["realtime://message"]({ payload: { room: "room-1", payload: "{not json" } });
    listeners["realtime://message"]({ payload: { room: "room-1", payload: JSON.stringify({ ok: 1 }) } });
    expect(got).toEqual([{ ok: 1 }]);
  });

  it("passes a status reason through, so a dead Tor captain is not mistaken for a disconnect", async () => {
    const got: unknown[][] = [];
    transport.onStatus((...args: unknown[]) => got.push(args));
    await tick();
    listeners["realtime://status"]({
      payload: { room: "room-1", state: "disconnected", peer_id: "cap.onion", reason: "captain_unreachable" },
    });
    listeners["realtime://status"]({ payload: { room: "room-1", state: "connected", reason: null } });
    expect(got).toEqual([
      ["room-1", "disconnected", "cap.onion", "captain_unreachable"],
      ["room-1", "connected", undefined, undefined],
    ]);
  });

  it("registers the Rust listeners once, however many handlers subscribe", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const before = vi.mocked(listen).mock.calls.length;
    transport.onMessage(() => {});
    transport.onMessage(() => {});
    transport.onStatus(() => {});
    await transport.createRoom("general");
    await tick();
    expect(vi.mocked(listen).mock.calls.slice(before).map(([name]) => name)).toEqual([
      "realtime://message",
      "realtime://status",
    ]);
  });

  it("stops delivering to a handler once it unsubscribes", async () => {
    const got: unknown[] = [];
    const off = transport.onMessage((_room: string, data: unknown) => got.push(data));
    await tick();
    off();
    listeners["realtime://message"]({ payload: { room: "room-1", payload: "{}" } });
    expect(got).toEqual([]);
  });

  it("reads a retired ticket through Rust, and a refusal as nothing to recover", async () => {
    const info = { tor: true, name: "Room", peers: [], captain_onion: "cap.onion" };
    invoke.mockResolvedValueOnce(info);
    expect(await transport.decodeLegacyTicket("tlegacy")).toEqual(info);
    expect(invoke).toHaveBeenCalledWith("legacy_ticket_decode", { ticket: "tlegacy" });
    invoke.mockRejectedValueOnce(new Error("not a ticket"));
    expect(await transport.decodeLegacyTicket("garbage")).toBeNull();
  });

  it.each([
    ["cancelJoin", (t: any) => t.cancelJoin(), "realtime_cancel_join", undefined],
    ["leaveRoom", (t: any) => t.leaveRoom("room-1"), "realtime_leave_room", { room: "room-1" }],
    ["forgetTorOnion", (t: any) => t.forgetTorOnion("Room One"), "realtime_forget_tor_onion", { name: "Room One" }],
    ["setCaptain", (t: any) => t.setCaptain("room-1", "cap.onion"), "realtime_tor_set_captain", { room: "room-1", captainOnion: "cap.onion" }],
    ["send", (t: any) => t.send("room-1", { a: 1 }), "realtime_send", { room: "room-1", payload: '{"a":1}' }],
  ])("%s fires its command and swallows a failure", async (_name, call, cmd, args) => {
    // These are fire-and-forget from UI paths; a rejected invoke must not
    // surface as an unhandled rejection.
    invoke.mockRejectedValueOnce(new Error("gateway down"));
    expect(call(transport)).toBeUndefined();
    await tick();
    expect(invoke).toHaveBeenCalledWith(cmd, args);
  });

  it("forgets a room's last status when it is left", async () => {
    transport.onStatus(() => {});
    await tick();
    listeners["realtime://status"]({ payload: { room: "room-1", state: "connected" } });
    expect(transport.lastStatus("room-1")).toBe("connected");
    transport.leaveRoom("room-1");
    expect(transport.lastStatus("room-1")).toBeUndefined();
  });

  it("asks Rust for this device's NodeId", async () => {
    invoke.mockResolvedValueOnce({ node_id: "node-me" });
    expect(await transport.nodeInfo()).toEqual({ node_id: "node-me" });
    expect(invoke).toHaveBeenCalledWith("realtime_node_info", undefined);
  });
});

describe("chatTransport — the browser stub's quiet half", () => {
  it("answers everything that is not a join without side effects", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.resetModules();
    invoke.mockClear();
    const stub = (await import("../../src/chatTransport")).chatTransport;
    expect(await stub.decodeLegacyTicket("t")).toBeNull();
    stub.send("room-1", {});
    stub.leaveRoom("room-1");
    stub.cancelJoin();
    stub.forgetTorOnion("Room");
    stub.setCaptain("room-1", "x.onion");
    expect(typeof stub.onMessage(() => {})).toBe("function");
    expect(typeof stub.onStatus(() => {})).toBe("function");
    expect(stub.lastStatus("room-1")).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
