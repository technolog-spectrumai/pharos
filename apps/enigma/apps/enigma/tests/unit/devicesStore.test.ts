import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

// The linked-devices store: the UI-facing half of pairing. Rust owns the
// protocol (`devlink_*` commands + `devlink://*` events, device_link.rs); this
// store is the state machine that decides what the user sees and — more
// importantly — when a redeemable pairing QR stops being redeemable.
//
// It had no tests at all. What is pinned here is the safety-shaped behaviour:
// a cancel drops the QR's one-time secret even when the backend call fails, a
// backend error never leaves a hidden-but-live pairing session behind, and a
// decline is always answered locally so the confirm modal cannot dead-end.

const invokeMock = vi.fn();
type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("rakotis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rakotis")>();
  return {
    ...actual,
    isTauri: () => true,
    invoke: (...args: unknown[]) => invokeMock(...args),
  };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: Handler) => {
    handlers.set(name, cb);
    return () => undefined;
  }),
}));

// deviceSync lives on the chat store; the devices store only reads through it.
const deviceSync = {
  linked: ref(false),
  registry: ref<unknown>(null),
  link: ref<{ myDeviceId: string } | null>(null),
  lastSyncAt: ref(0),
  devConnected: ref(false),
  onlineLeafIds: ref<string[]>([]),
  refresh: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  unlinkDevice: vi.fn(async () => {}),
};
vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({ deviceSync }),
}));

import { useDevicesStore } from "../../src/stores/devices";

function emit(event: string, payload: unknown) {
  handlers.get(event)?.({ payload });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  handlers.clear();
  deviceSync.linked.value = false;
  deviceSync.registry.value = null;
  deviceSync.link.value = null;
  deviceSync.refresh.mockClear();
  deviceSync.start.mockClear();
  deviceSync.unlinkDevice.mockClear();
  setActivePinia(createPinia());
});

describe("startPairing — minting the QR", () => {
  it("stores the ticket and its expiry, and marks pairing live", async () => {
    invokeMock.mockResolvedValueOnce({ ticket: "devlink-ticket", expires_at: 1234 });
    const s = useDevicesStore();

    await s.startPairing();

    expect(invokeMock).toHaveBeenCalledWith("devlink_pair_begin");
    expect(s.pairTicket).toBe("devlink-ticket");
    expect(s.pairExpiresAt).toBe(1234);
    expect(s.pairing).toBe(true);
    expect(s.error).toBe("");
  });

  it("a refused begin surfaces the reason and does NOT claim a live session", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Device linking is disabled in this build."));
    const s = useDevicesStore();

    await s.startPairing();

    // The QR must not appear: there is no redeemable secret behind it.
    expect(s.pairing).toBe(false);
    expect(s.pairTicket).toBe("");
    expect(s.error).toContain("disabled in this build");
  });

  it("clears a previous error before trying again", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    const s = useDevicesStore();
    await s.startPairing();
    expect(s.error).toBe("boom");

    invokeMock.mockResolvedValueOnce({ ticket: "t", expires_at: 1 });
    await s.startPairing();
    expect(s.error).toBe("");
  });
});

describe("cancelPairing — the QR must stop being redeemable", () => {
  it("drops the local session and tells Rust to drop the secret", async () => {
    invokeMock.mockResolvedValueOnce({ ticket: "t", expires_at: 1 });
    const s = useDevicesStore();
    await s.startPairing();

    await s.cancelPairing();

    expect(s.pairing).toBe(false);
    expect(s.pairTicket).toBe("");
    expect(s.pairRequest).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("devlink_pair_cancel");
  });

  it("still clears locally when the backend call fails", async () => {
    invokeMock.mockResolvedValueOnce({ ticket: "t", expires_at: 1 });
    const s = useDevicesStore();
    await s.startPairing();

    invokeMock.mockRejectedValueOnce(new Error("no such session"));
    await expect(s.cancelPairing()).resolves.toBeUndefined();

    // Showing a QR we believe is dead would be worse than a failed cancel.
    expect(s.pairing).toBe(false);
    expect(s.pairTicket).toBe("");
  });
});

describe("confirmPairing — answering the request", () => {
  it("a decline is answered to Rust and closes the prompt locally", async () => {
    const s = useDevicesStore();
    await s.startPairing();
    emit("devlink://request", { label: "laptop", kind: "desktop", nodeId: "n1", deviceId: "d1" });
    expect(s.pairRequest).not.toBeNull();

    await s.confirmPairing(false);

    expect(invokeMock).toHaveBeenCalledWith("devlink_pair_confirm", { accept: false });
    expect(s.pairRequest).toBeNull();
  });

  it("an accept leaves the prompt up until Rust confirms the pairing landed", async () => {
    const s = useDevicesStore();
    await s.startPairing();
    emit("devlink://request", { label: "phone", kind: "mobile", nodeId: "n2", deviceId: "d2" });

    await s.confirmPairing(true);

    expect(invokeMock).toHaveBeenCalledWith("devlink_pair_confirm", { accept: true });
    // Deliberate: `devlink://paired` clears it, so the prompt cannot vanish
    // before the other device has actually joined.
    expect(s.pairRequest).not.toBeNull();
  });

  it("a decline still closes the prompt when the backend call fails", async () => {
    const s = useDevicesStore();
    emit("devlink://request", { label: "x", kind: "desktop", nodeId: "n", deviceId: "d" });
    invokeMock.mockRejectedValueOnce(new Error("session gone"));

    await s.confirmPairing(false);

    // The modal's only escape hatch is this path — it must never dead-end.
    expect(s.pairRequest).toBeNull();
    expect(s.error).toContain("session gone");
  });
});

describe("joinPairing — the new device redeeming a ticket", () => {
  it("trims the pasted ticket and reports progress state", async () => {
    const s = useDevicesStore();

    await s.joinPairing("  ticket-with-spaces \n", "my laptop", "desktop");

    expect(invokeMock).toHaveBeenCalledWith("devlink_pair_join", {
      ticket: "ticket-with-spaces",
      label: "my laptop",
      kind: "desktop",
    });
    expect(s.joining).toBe(true);
    expect(s.joinPhase).toBe("connecting");
  });

  it("a rejected join stops the spinner instead of hanging on 'connecting'", async () => {
    invokeMock.mockRejectedValueOnce(new Error("ticket expired"));
    const s = useDevicesStore();

    await s.joinPairing("t", "l", "mobile");

    expect(s.joining).toBe(false);
    expect(s.error).toContain("ticket expired");
  });
});

describe("devlink://* events", () => {
  it("a request opens the confirm prompt with the peer's details", async () => {
    const s = useDevicesStore();
    await s.startPairing();

    emit("devlink://request", { label: "laptop", kind: "desktop", nodeId: "abc", deviceId: "d9" });

    expect(s.pairRequest).toEqual({ label: "laptop", kind: "desktop", nodeId: "abc", deviceId: "d9" });
  });

  it("a completed pairing ends the session and restarts sync", async () => {
    invokeMock.mockResolvedValueOnce({ ticket: "t", expires_at: 1 });
    const s = useDevicesStore();
    await s.startPairing();
    emit("devlink://request", { label: "l", kind: "desktop", nodeId: "n", deviceId: "d" });

    emit("devlink://paired", { registry: {}, leafId: "leaf1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(s.pairing).toBe(false);
    expect(s.pairTicket).toBe("");
    expect(s.pairRequest).toBeNull();
    expect(deviceSync.refresh).toHaveBeenCalled();
  });

  it("progress updates drive the joining UI", async () => {
    const s = useDevicesStore();
    await s.joinPairing("t", "l", "desktop");

    emit("devlink://progress", { phase: "applying", current: 3, total: 7 });

    expect(s.joinPhase).toBe("applying");
    expect(s.joinProgress).toEqual({ current: 3, total: 7 });
  });

  it("an error cancels a live pairing so no hidden QR stays redeemable", async () => {
    invokeMock.mockResolvedValueOnce({ ticket: "t", expires_at: 1 });
    const s = useDevicesStore();
    await s.startPairing();
    expect(s.pairing).toBe(true);
    invokeMock.mockClear();

    emit("devlink://error", { message: "handshake failed" });
    await Promise.resolve();

    expect(s.error).toBe("handshake failed");
    expect(s.joining).toBe(false);
    expect(s.pairRequest).toBeNull();
    expect(s.pairing).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("devlink_pair_cancel");
  });

  it("an error with no pairing session does not call cancel", async () => {
    const s = useDevicesStore();
    await s.joinPairing("t", "l", "desktop");
    invokeMock.mockClear();

    emit("devlink://error", { message: "join refused" });
    await Promise.resolve();

    expect(s.error).toBe("join refused");
    expect(invokeMock).not.toHaveBeenCalledWith("devlink_pair_cancel");
  });
});

describe("refresh — reconciling with Rust", () => {
  it("drops a local pairing flag Rust no longer backs", async () => {
    invokeMock.mockResolvedValueOnce({ ticket: "t", expires_at: 1 });
    const s = useDevicesStore();
    await s.startPairing();

    invokeMock.mockResolvedValueOnce({
      allow_linking: true, pairing_active: false, linked: false,
      device_count: 1, my_device_id: "d1", my_leaf_id: "l1",
    });
    await s.refresh();

    // Rust is authoritative: a session it has forgotten must not show a QR.
    expect(s.pairing).toBe(false);
  });

  it("never resurrects a pairing the user cancelled locally", async () => {
    const s = useDevicesStore();
    invokeMock.mockResolvedValueOnce({
      allow_linking: true, pairing_active: true, linked: true,
      device_count: 2, my_device_id: "d1", my_leaf_id: "l1",
    });

    await s.refresh();

    expect(s.pairing).toBe(false);
  });
});

describe("derived state reads through deviceSync", () => {
  it("reports linked, device id and sync freshness from the sync engine", () => {
    deviceSync.linked.value = true;
    deviceSync.link.value = { myDeviceId: "dev-7" };
    deviceSync.lastSyncAt.value = 999;
    deviceSync.onlineLeafIds.value = ["leaf-a"];
    const s = useDevicesStore();

    expect(s.linked).toBe(true);
    expect(s.myDeviceId).toBe("dev-7");
    expect(s.lastSyncAt).toBe(999);
    expect(s.onlineLeafIds).toEqual(["leaf-a"]);
  });

  it("stays inert with no sync engine (a build without linking)", () => {
    const s = useDevicesStore();
    expect(s.linked).toBe(false);
    expect(s.devices).toEqual([]);
    expect(s.myDeviceId).toBeNull();
  });

  it("unlink delegates to the sync engine, which owns the protocol", async () => {
    const s = useDevicesStore();
    await s.unlinkDevice("dev-2");
    expect(deviceSync.unlinkDevice).toHaveBeenCalledWith("dev-2");
  });
});
