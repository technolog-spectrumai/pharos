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
