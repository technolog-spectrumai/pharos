import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri bridge so we can exercise the Vox controller without a real
// runtime, and capture the registered `vox://*` event listeners.
const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
const listeners: Record<string, (e: { payload: any }) => void> = {};

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => (invoke as any)(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: any }) => void) => {
    listeners[name] = cb;
    return () => {};
  }),
}));
// Keep the controller isolated from the real chat store (we only need a name).
vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    relay: { currentUserName: { value: "alice" }, mlsIdentity: { value: "alice-id" } },
  }),
}));

const tick = () => new Promise((r) => setTimeout(r, 0));

async function freshVox(tauri = true) {
  vi.resetModules();
  for (const k of Object.keys(listeners)) delete listeners[k];
  invoke.mockClear();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "vox_create") return { ticket: "tkt-abc", node_id: "node-1" };
    return undefined;
  });
  if (tauri) (window as any).__TAURI_INTERNALS__ = {};
  else delete (window as any).__TAURI_INTERNALS__;
  const mod = await import("../../src/composables/useVoxCall");
  return mod.useVoxCall();
}

describe("useVoxCall — iroh voice controller", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  it("createCall opens a ticket, wires listeners and waits", async () => {
    const vox = await freshVox(true);
    await vox.createCall();
    await tick();
    expect(invoke).toHaveBeenCalledWith("vox_create", { name: "alice" });
    expect(vox.phase.value).toBe("waiting");
    expect(vox.ticket.value).toBe("tkt-abc");
    expect(typeof listeners["vox://incoming"]).toBe("function");
    expect(typeof listeners["vox://state"]).toBe("function");
  });

  it("an incoming event puts the call into the ringing state", async () => {
    const vox = await freshVox(true);
    await vox.createCall();
    await tick();
    listeners["vox://incoming"]({ payload: { from_name: "bob", node_id: "n" } });
    expect(vox.phase.value).toBe("incoming");
    expect(vox.incomingName.value).toBe("bob");
  });

  it("a connected state event starts the live call", async () => {
    const vox = await freshVox(true);
    await vox.createCall();
    await tick();
    listeners["vox://state"]({ payload: { state: "connected", peer: "bob" } });
    expect(vox.phase.value).toBe("connected");
    expect(vox.peerName.value).toBe("bob");
  });

  it("vox://spectrum updates the live equalizer bands", async () => {
    const vox = await freshVox(true);
    await vox.createCall();
    await tick();
    listeners["vox://spectrum"]({ payload: { bands: [0.1, 0.5, 1] } });
    expect(vox.spectrum.value).toEqual([0.1, 0.5, 1]);
  });

  it("joinByTicket dials the trimmed ticket as the caller", async () => {
    const vox = await freshVox(true);
    await vox.joinByTicket("  tkt-xyz  ");
    await tick();
    expect(vox.phase.value).toBe("calling");
    expect(invoke).toHaveBeenCalledWith("vox_join", { ticket: "tkt-xyz", name: "alice" });
  });

  it("toggleMute flips the mute flag through the backend", async () => {
    const vox = await freshVox(true);
    await vox.toggleMute();
    expect(invoke).toHaveBeenCalledWith("vox_set_mute", { muted: true });
    expect(vox.muted.value).toBe(true);
  });

  it("hangup tears the call down and returns to idle", async () => {
    const vox = await freshVox(true);
    await vox.createCall();
    await tick();
    await vox.hangup();
    expect(invoke.mock.calls.some((c) => c[0] === "vox_hangup")).toBe(true);
    expect(vox.phase.value).toBe("idle");
    expect(vox.ticket.value).toBe("");
  });

  it("is unavailable (no backend call) in a plain browser", async () => {
    const vox = await freshVox(false);
    expect(vox.available).toBe(false);
    await vox.createCall();
    expect(vox.error.value).toBe("vox.desktopOnly");
    expect(invoke).not.toHaveBeenCalled();
  });
});
