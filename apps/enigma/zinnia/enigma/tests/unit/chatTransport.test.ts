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

describe("chatTransport — Rust gateway backend", () => {
  let transport: any;

  beforeEach(async () => {
    invoke.mockClear();
    for (const k of Object.keys(listeners)) delete listeners[k];
    // Force the Tauri branch, then import a fresh module instance.
    (window as any).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    transport = (await import("../../src/services/chatTransport")).chatTransport;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__; // don't leak the Tauri branch to other files
  });

  it("connect invokes realtime_connect and wires the gateway events", async () => {
    transport.connect("room-1");
    await tick();
    expect(invoke).toHaveBeenCalledWith("realtime_connect", { room: "room-1" });
    expect(typeof listeners["realtime://message"]).toBe("function");
    expect(typeof listeners["realtime://status"]).toBe("function");
  });

  it("send serializes the payload through realtime_send", async () => {
    transport.connect("room-1");
    await tick();
    invoke.mockClear();
    transport.send({ type: "chat_message", message: "hi" });
    await tick();
    expect(invoke).toHaveBeenCalledWith("realtime_send", {
      room: "room-1",
      payload: JSON.stringify({ type: "chat_message", message: "hi" }),
    });
  });

  it("incoming realtime://message surfaces parsed objects via onMessage", async () => {
    const got: any[] = [];
    transport.onMessage((m: any) => got.push(m));
    transport.connect("room-1");
    await tick();
    listeners["realtime://message"]({
      payload: { room: "room-1", payload: JSON.stringify({ type: "chat_message", message: "yo" }) },
    });
    expect(got).toEqual([{ type: "chat_message", message: "yo" }]);
  });

  it("status events drive onStatus and isConnected", async () => {
    const states: string[] = [];
    transport.onStatus((s: string) => states.push(s));
    transport.connect("room-1");
    await tick();
    listeners["realtime://status"]({ payload: { room: "room-1", state: "connected" } });
    expect(states).toContain("connected");
    expect(transport.isConnected).toBe(true);
  });

  it("createRoom calls realtime_create_room and routes later sends to that room", async () => {
    invoke.mockResolvedValueOnce({ room: "topic-abc", name: "general", ticket: "tkt" });
    const res = await transport.createRoom("general");
    expect(invoke).toHaveBeenCalledWith("realtime_create_room", { name: "general" });
    expect(res).toEqual({ room: "topic-abc", name: "general", ticket: "tkt" });

    invoke.mockClear();
    transport.send({ type: "x" });
    await tick();
    expect(invoke).toHaveBeenCalledWith("realtime_send", {
      room: "topic-abc",
      payload: JSON.stringify({ type: "x" }),
    });
  });

  it("joinRoom calls realtime_join_room", async () => {
    invoke.mockResolvedValueOnce({ room: "topic-xyz", name: "secret" });
    const res = await transport.joinRoom("ticket-string");
    expect(invoke).toHaveBeenCalledWith("realtime_join_room", { ticket: "ticket-string" });
    expect(res).toEqual({ room: "topic-xyz", name: "secret" });
  });
});
