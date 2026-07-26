import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// The beacon store drives the `beacon_*` Tauri commands against the user's
// faros server. The Rust side (transport, gating, GeoJSON building) has its
// own cargo tests — here we verify the frontend state machine: refresh
// parsing, optimistic updates on publish/delete, the unauthorized flip shared
// with the cloud store, and near-mode.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { useBeaconStore } from "../../src/stores/beacon";
import { useCloudStore } from "../../src/stores/cloud";

const EXPIRES = "2026-07-26T19:00:00+00:00";
const CREATED = "2026-07-26T13:00:00+00:00";

function wirePin(id: number, user: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    user,
    geometry: { type: "Point", coordinates: [21.0122, 52.2297] },
    comment: "",
    expires_at: EXPIRES,
    created_at: CREATED,
    ...extra,
  };
}

const WIRE_ZONE = {
  id: 7,
  user: "bob",
  name: "camp",
  geometry: {
    type: "Polygon",
    coordinates: [[[21.0, 52.2], [21.1, 52.2], [21.1, 52.3], [21.0, 52.2]]],
  },
  comment: "",
  expires_at: EXPIRES,
  created_at: CREATED,
};

const WIRE_ROUTE = {
  id: 2,
  user: "bob",
  name: "leg 1",
  geometry: { type: "LineString", coordinates: [[21.0, 52.2], [21.1, 52.3]] },
  comment: "",
  expires_at: EXPIRES,
  created_at: CREATED,
};

function loggedInCloud() {
  const cloud = useCloudStore();
  cloud.loggedIn = true;
  cloud.username = "alice";
  cloud.serverUrl = "https://localhost:8443";
  return cloud;
}

beforeEach(() => {
  setActivePinia(createPinia());
  invokeMock.mockReset();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

describe("beacon store — refresh", () => {
  it("parses /beacon/all and drops invalid entries", async () => {
    loggedInCloud();
    invokeMock.mockResolvedValue({
      pins: [wirePin(3, "alice"), { junk: true }],
      zones: [WIRE_ZONE],
      routes: [WIRE_ROUTE, null],
    });
    const store = useBeaconStore();
    await store.refresh();
    expect(invokeMock).toHaveBeenCalledWith("beacon_all", { serverUrl: "https://localhost:8443" });
    expect(store.pins).toHaveLength(1);
    expect(store.zones).toHaveLength(1);
    expect(store.routes).toHaveLength(1);
    expect(store.error).toBeNull();
  });

  it("no-ops when the cloud session is logged out", async () => {
    const store = useBeaconStore();
    await store.refresh();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("flips the cloud store logged-out on an unauthorized error", async () => {
    const cloud = loggedInCloud();
    invokeMock.mockRejectedValue("unauthorized: session expired (HTTP 401)");
    const store = useBeaconStore();
    await store.refresh();
    expect(cloud.loggedIn).toBe(false);
    expect(store.pins).toHaveLength(0);
  });

  it("keeps other errors visible without logging out", async () => {
    const cloud = loggedInCloud();
    invokeMock.mockRejectedValue("server error (HTTP 500)");
    const store = useBeaconStore();
    await store.refresh();
    expect(cloud.loggedIn).toBe(true);
    expect(store.error).toBe("server error (HTTP 500)");
  });
});

describe("beacon store — publish and delete", () => {
  it("publishPin replaces my previous pin in place", async () => {
    loggedInCloud();
    invokeMock.mockResolvedValue({
      pins: [wirePin(3, "alice"), wirePin(4, "bob")],
      zones: [],
      routes: [],
    });
    const store = useBeaconStore();
    await store.refresh();
    invokeMock.mockResolvedValue({ ok: true, pin: wirePin(3, "alice", { comment: "moved" }) });
    await store.publishPin(52.3, 21.1, 21600, "moved");
    expect(invokeMock).toHaveBeenLastCalledWith("beacon_publish_pin", {
      serverUrl: "https://localhost:8443",
      lat: 52.3,
      lng: 21.1,
      ttlSeconds: 21600,
      comment: "moved",
    });
    expect(store.pins).toHaveLength(2);
    expect(store.pins.find((p) => p.user === "alice")!.comment).toBe("moved");
  });

  it("deletePin removes only my pin locally", async () => {
    loggedInCloud();
    invokeMock.mockResolvedValue({
      pins: [wirePin(3, "alice"), wirePin(4, "bob")],
      zones: [],
      routes: [],
    });
    const store = useBeaconStore();
    await store.refresh();
    invokeMock.mockResolvedValue({ ok: true, deleted: true });
    await store.deletePin();
    expect(store.pins.map((p) => p.user)).toEqual(["bob"]);
  });

  it("publishZone/publishRoute prepend the validated response object", async () => {
    loggedInCloud();
    const store = useBeaconStore();
    invokeMock.mockResolvedValue({ ok: true, zone: WIRE_ZONE });
    await store.publishZone("camp", [[52.2, 21.0], [52.2, 21.1], [52.3, 21.1]], 3600, "");
    expect(store.zones).toHaveLength(1);
    invokeMock.mockResolvedValue({ ok: true, route: WIRE_ROUTE });
    await store.publishRoute("leg 1", [[52.2, 21.0], [52.3, 21.1]], 3600, "");
    expect(store.routes).toHaveLength(1);
  });

  it("deleteZone rethrows a normalized error (owner-only 404 stays visible)", async () => {
    loggedInCloud();
    const store = useBeaconStore();
    invokeMock.mockRejectedValue("Not found.");
    await expect(store.deleteZone(7)).rejects.toThrow("Not found.");
  });
});

describe("beacon store — near mode", () => {
  it("stores near results and center, and clears them", async () => {
    loggedInCloud();
    const store = useBeaconStore();
    invokeMock.mockResolvedValue({
      center: { lat: 52.23, lon: 21.01 },
      radius_m: 25000,
      pins: [wirePin(4, "bob", { distance_m: 1234.5 })],
    });
    await store.near(52.23, 21.01, 25000);
    expect(invokeMock).toHaveBeenCalledWith("beacon_near", {
      serverUrl: "https://localhost:8443",
      lat: 52.23,
      lon: 21.01,
      radiusM: 25000,
    });
    expect(store.nearPins).toHaveLength(1);
    expect(store.nearPins![0]!.distanceM).toBe(1234.5);
    expect(store.nearCenter).toEqual({ lat: 52.23, lng: 21.01 });
    store.clearNear();
    expect(store.nearPins).toBeNull();
    expect(store.nearCenter).toBeNull();
  });
});
