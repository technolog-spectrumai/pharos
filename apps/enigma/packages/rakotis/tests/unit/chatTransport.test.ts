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

describe("chatTransport — room-multiplexing Rust gateway backend", () => {
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

  it("link status events carry the onion of the member whose link changed", async () => {
    const got: Array<[string, string, string | undefined]> = [];
    transport.onStatus((room: string, state: string, peerId?: string) => got.push([room, state, peerId]));
    await tick();
    listeners["realtime://status"]({
      payload: { room: "room-2", state: "connected", peers: 1, peer_id: "bob.onion" },
    });
    listeners["realtime://status"]({
      payload: { room: "room-2", state: "waiting", peers: 0, peer_id: "bob.onion" },
    });
    listeners["realtime://status"]({
      payload: { room: "room-2", state: "disconnected", peers: 0, peer_id: null },
    });
    expect(got).toContainEqual(["room-2", "connected", "bob.onion"]);
    expect(got).toContainEqual(["room-2", "waiting", "bob.onion"]);
    expect(got).toContainEqual(["room-2", "disconnected", undefined]);
    expect(transport.lastStatus("room-2")).toBe("disconnected");
  });

  it("createRoom returns a room, not a credential", async () => {
    // It used to hand back a permanent ticket. Creating a room now produces
    // nothing shareable — letting someone in is a separate, deliberate act.
    invoke.mockResolvedValueOnce({ room: "topic-abc", name: "general", onion: "me.onion" });
    const created = await transport.createRoom("general");
    expect(invoke).toHaveBeenCalledWith("realtime_create_room", { name: "general" });
    expect(created).toEqual({ room: "topic-abc", name: "general", onion: "me.onion" });
    expect(created).not.toHaveProperty("ticket");
  });

  it("joinRoom opens a named room and links to the given members' onions", async () => {
    invoke.mockResolvedValueOnce({ room: "topic-n", name: "duo", onion: "me.onion" });
    const joined = await transport.joinRoom("duo", ["a.onion", "b.onion"]);
    expect(invoke).toHaveBeenCalledWith("realtime_join_room", {
      name: "duo",
      peers: ["a.onion", "b.onion"],
    });
    expect(joined).toEqual({ room: "topic-n", name: "duo", onion: "me.onion" });
  });

  it("has none of the retired iroh/captain/ticket calls left", () => {
    for (const gone of ["joinRoomByNode", "decodeLegacyTicket", "setCaptain", "nodeInfo", "forgetTorOnion"]) {
      expect((transport as Record<string, unknown>)[gone]).toBeUndefined();
    }
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
    await expect(stub.joinRoom("x", [])).rejects.toThrow(/desktop/i);
    await expect(stub.deviceId()).resolves.toBeNull();
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

  it("hands status handlers exactly (room, state, peerId, linked) — no reason argument", async () => {
    const got: unknown[][] = [];
    transport.onStatus((...args: unknown[]) => got.push(args));
    await tick();
    listeners["realtime://status"]({
      payload: { room: "room-1", state: "waiting", peer_id: "bob.onion", reason: "whatever", linked: [] },
    });
    listeners["realtime://status"]({
      payload: { room: "room-1", state: "connected", peer_id: "carol.onion", linked: ["carol.onion", "dan.onion"] },
    });
    // An older Rust that sends no `linked` reads as nobody linked, never undefined.
    listeners["realtime://status"]({ payload: { room: "room-1", state: "connected", peer_id: null } });
    expect(got).toEqual([
      ["room-1", "waiting", "bob.onion", []],
      ["room-1", "connected", "carol.onion", ["carol.onion", "dan.onion"]],
      ["room-1", "connected", undefined, []],
    ]);
    expect(transport.lastStatus("room-1")).toBe("connected");
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


  it.each([
    ["cancelJoin", (t: any) => t.cancelJoin(), "realtime_cancel_join", undefined],
    ["leaveRoom", (t: any) => t.leaveRoom("room-1"), "realtime_leave_room", { room: "room-1" }],
    ["forgetOnion", (t: any) => t.forgetOnion("Room One"), "realtime_forget_onion", { name: "Room One" }],
    ["setPeers", (t: any) => t.setPeers("room-1", ["a.onion"]), "realtime_set_peers", { room: "room-1", peers: ["a.onion"] }],
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

  it("asks Rust for this device's id, and a failure as none", async () => {
    invoke.mockResolvedValueOnce("device-me");
    expect(await transport.deviceId()).toBe("device-me");
    expect(invoke).toHaveBeenCalledWith("realtime_device_id", undefined);
    invoke.mockRejectedValueOnce(new Error("gateway down"));
    expect(await transport.deviceId()).toBeNull();
  });
});

describe("chatTransport — the browser stub's quiet half", () => {
  it("answers everything that is not a join without side effects", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.resetModules();
    invoke.mockClear();
    const stub = (await import("../../src/chatTransport")).chatTransport;
    expect(await stub.deviceId()).toBeNull();
    stub.send("room-1", {});
    stub.leaveRoom("room-1");
    stub.cancelJoin();
    stub.forgetOnion("Room");
    stub.setPeers("room-1", ["x.onion"]);
    expect(typeof stub.onMessage(() => {})).toBe("function");
    expect(typeof stub.onStatus(() => {})).toBe("function");
    expect(stub.lastStatus("room-1")).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
