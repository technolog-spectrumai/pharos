import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { DeviceRegistry } from "rakotis";

// The linked-devices store is now only the UI-facing reader for already-linked
// device sync. QR device pairing is parked in limbo, so the store must not
// expose begin/join/confirm/cancel state anymore.

const { deviceSync, state } = vi.hoisted(() => {
  const holder = <T>(value: T) => ({ value });
  return {
    state: { syncEnabled: true },
    deviceSync: {
      linked: holder(false),
      registry: holder<DeviceRegistry | null>(null),
      link: holder<{ myDeviceId: string } | null>(null),
      lastSyncAt: holder(0),
      devConnected: holder(false),
      onlineLeafIds: holder<string[]>([]),
      refresh: vi.fn(async () => {}),
      unlinkDevice: vi.fn(async () => {}),
    },
  };
});

vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({ deviceSync: state.syncEnabled ? deviceSync : null }),
}));

import { useDevicesStore } from "../../src/stores/devices";

beforeEach(() => {
  state.syncEnabled = true;
  deviceSync.linked.value = false;
  deviceSync.registry.value = null;
  deviceSync.link.value = null;
  deviceSync.lastSyncAt.value = 0;
  deviceSync.devConnected.value = false;
  deviceSync.onlineLeafIds.value = [];
  deviceSync.refresh.mockClear();
  deviceSync.unlinkDevice.mockClear();
  setActivePinia(createPinia());
});

const REGISTRY: DeviceRegistry = {
  v: 1,
  user: "alice",
  rev: 2,
  devices: [
    { deviceId: "primary", label: "Desktop", kind: "desktop", leafId: "alice", nodeId: "node-a", addedAt: 1 },
    { deviceId: "phone", label: "Phone", kind: "mobile", leafId: "alice#dev-phone123", nodeId: "node-b", addedAt: 2 },
    { deviceId: "old", label: "Old phone", kind: "mobile", leafId: "alice#dev-oldphone", nodeId: "node-c", addedAt: 3, revokedAt: 4 },
  ],
  mac: "f".repeat(64),
};

describe("derived state reads through deviceSync", () => {
  it("reports linked devices, device id and sync freshness from the sync engine", () => {
    deviceSync.linked.value = true;
    deviceSync.registry.value = REGISTRY;
    deviceSync.link.value = { myDeviceId: "primary" };
    deviceSync.lastSyncAt.value = 999;
    deviceSync.devConnected.value = true;
    deviceSync.onlineLeafIds.value = ["alice#dev-phone123"];

    const s = useDevicesStore();

    expect(s.linked).toBe(true);
    expect(s.devices.map((d) => d.deviceId)).toEqual(["primary", "phone"]);
    expect(s.myDeviceId).toBe("primary");
    expect(s.lastSyncAt).toBe(999);
    expect(s.devConnected).toBe(true);
    expect(s.onlineLeafIds).toEqual(["alice#dev-phone123"]);
  });

  it("stays inert with no sync engine", () => {
    state.syncEnabled = false;
    const s = useDevicesStore();

    expect(s.linked).toBe(false);
    expect(s.devices).toEqual([]);
    expect(s.myDeviceId).toBeNull();
    expect(s.lastSyncAt).toBe(0);
  });
});

describe("actions", () => {
  it("refresh delegates to the sync engine", async () => {
    const s = useDevicesStore();

    await s.refresh();

    expect(deviceSync.refresh).toHaveBeenCalled();
  });

  it("unlink delegates to the sync engine, which owns the protocol", async () => {
    const s = useDevicesStore();

    await s.unlinkDevice("phone");

    expect(deviceSync.unlinkDevice).toHaveBeenCalledWith("phone");
  });
});
