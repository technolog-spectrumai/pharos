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
    transport = (await import("../../src/services/chatTransport")).chatTransport;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("connectWs invokes realtime_connect and wires the gateway events", async () => {
    transport.onStatus(() => {}); // registering a handler wires the listeners
    await tick();
    transport.connectWs("room-1");
    await tick();
    expect(invoke).toHaveBeenCalledWith("realtime_connect", { room: "room-1" });
    expect(typeof listeners["realtime://message"]).toBe("function");
    expect(typeof listeners["realtime://status"]).toBe("function");
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

  it("createRoom and joinRoom call the right gateway commands", async () => {
    invoke.mockResolvedValueOnce({ room: "topic-abc", name: "general", ticket: "tkt" });
    const created = await transport.createRoom("general");
    expect(invoke).toHaveBeenCalledWith("realtime_create_room", { name: "general" });
    expect(created).toEqual({ room: "topic-abc", name: "general", ticket: "tkt" });

    invoke.mockResolvedValueOnce({ room: "topic-xyz", name: "secret" });
    const joined = await transport.joinRoom("ticket-string");
    expect(invoke).toHaveBeenCalledWith("realtime_join_room", { ticket: "ticket-string" });
    expect(joined).toEqual({ room: "topic-xyz", name: "secret" });
  });

  it("two channels filtering by room don't see each other's messages", async () => {
    const relay: any[] = [];
    const p2p: any[] = [];
    // Simulate two channels: each only keeps messages for the room it owns.
    transport.onMessage((room: string, data: any) => { if (room === "relay-1") relay.push(data); });
    transport.onMessage((room: string, data: any) => { if (room === "p2p-1") p2p.push(data); });
    await tick();
    listeners["realtime://message"]({ payload: { room: "relay-1", payload: JSON.stringify({ m: "a" }) } });
    listeners["realtime://message"]({ payload: { room: "p2p-1", payload: JSON.stringify({ m: "b" }) } });
    expect(relay).toEqual([{ m: "a" }]);
    expect(p2p).toEqual([{ m: "b" }]);
  });
});
