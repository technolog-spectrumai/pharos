import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// The map store drives the `map_*` Tauri commands and folds the `file://`
// events into receive state. The Rust side (tile serving, BLAKE3 verification)
// is covered by its own cargo tests — here we verify the frontend state
// machine: import errors (storage-limit contract), the accept-share flow
// (transfer → verified import), and the focus handoff.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const backendListeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    backendListeners.set(name, cb);
    return () => backendListeners.delete(name);
  }),
}));

import { useMapStore } from "../../src/stores/map";
import type { MapRegionManifest, MapRegionShare } from "rakotis";

const MANIFEST: MapRegionManifest = {
  id: "r1",
  name: "Poznań",
  bbox: [16.8, 52.3, 17.1, 52.5],
  minZoom: 0,
  maxZoom: 12,
  size: 4096,
  blake3: "a".repeat(64),
  sourceUrl: "https://example.org/planet.pmtiles",
  version: 1,
};

function fire(event: string, payload: unknown) {
  backendListeners.get(event)?.({ payload });
}

function flushMicrotasks() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  backendListeners.clear();
  invokeMock.mockReset();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  // Default command handlers; individual tests override per command.
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "map_regions_list": return [MANIFEST];
      case "map_storage_usage": return { usedBytes: 4096, limitBytes: 512 * 1024 * 1024 };
      case "kv_get": return null;
      case "kv_put": return undefined;
      default: return undefined;
    }
  });
});

describe("map store — reload", () => {
  it("loads regions + storage through the map_* commands", async () => {
    const store = useMapStore();
    await store.reload();
    expect(store.regions).toHaveLength(1);
    expect(store.regions[0]!.blake3).toBe(MANIFEST.blake3);
    expect(store.usedBytes).toBe(4096);
    expect(store.limitBytes).toBe(512 * 1024 * 1024);
  });
});

describe("map store — importing a package", () => {
  it("surfaces a storage-limit rejection as lastError (contract prefix)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "map_region_import")
        throw "MAPS_STORAGE_LIMIT: import would exceed the map storage limit";
      if (cmd === "map_regions_list") return [];
      if (cmd === "map_storage_usage") return { usedBytes: 0, limitBytes: 1 };
      return null;
    });
    const store = useMapStore();
    await store.reload();
    await expect(store.importRegion("/tmp/x.pmtiles")).rejects.toBeTruthy();
    expect(store.lastError).toContain("MAPS_STORAGE_LIMIT");
  });

  it("a successful import clears the error and reloads the region list", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "map_region_import") return MANIFEST;
      if (cmd === "map_regions_list") return [MANIFEST];
      if (cmd === "map_storage_usage") return { usedBytes: 4096, limitBytes: 1024 ** 3 };
      return null;
    });
    const store = useMapStore();
    await store.importRegion("/tmp/poznan.pmtiles");
    expect(store.lastError).toBeNull();
    expect(store.regions).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("map_region_import", {
      path: "/tmp/poznan.pmtiles",
      manifestJson: null,
    });
  });
});

describe("map store — accepting a shared region", () => {
  const SHARE: MapRegionShare = {
    type: "map_region",
    v: 1,
    manifest: MANIFEST,
    offerId: "offer-9",
    addr: "b32addr",
  };

  it("transfers over file_xfer, then imports WITH the manifest for verification", async () => {
    const calls: Array<[string, unknown]> = [];
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "map_region_recv_path") return "/tmp/maps/tmp/recv-offer-9.pmtiles";
      if (cmd === "map_regions_list") return [MANIFEST];
      if (cmd === "map_storage_usage") return { usedBytes: 0, limitBytes: 1 };
      if (cmd === "map_region_import") return MANIFEST;
      return null;
    });
    const store = useMapStore();
    await store.acceptRegionShare(SHARE);
    expect(store.receives.get("offer-9")).toMatchObject({ state: "transferring", total: 4096 });
    expect(calls.map(([c]) => c)).toContain("file_download");

    fire("file://progress", { offerId: "offer-9", dir: "recv", transferred: 2048, total: 4096 });
    expect(store.receives.get("offer-9")).toMatchObject({ transferred: 2048 });

    fire("file://done", { offerId: "offer-9", dir: "recv" });
    await flushMicrotasks();
    const importCall = calls.find(([c]) => c === "map_region_import");
    expect(importCall).toBeTruthy();
    expect((importCall![1] as { manifestJson: string }).manifestJson).toContain(MANIFEST.blake3);
    expect(store.receives.get("offer-9")?.state).toBe("done");
  });

  it("a failed verification surfaces on the receive row", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "map_region_recv_path") return "/tmp/recv.pmtiles";
      if (cmd === "map_region_import") {
        throw new Error("region file failed verification: BLAKE3 mismatch");
      }
      return null;
    });
    const store = useMapStore();
    await store.acceptRegionShare(SHARE);
    fire("file://done", { offerId: "offer-9", dir: "recv" });
    await flushMicrotasks();
    expect(store.receives.get("offer-9")?.state).toBe("error");
    expect(store.receives.get("offer-9")?.error).toContain("BLAKE3");
  });
});

describe("map store — active region", () => {
  // __TAURI_INTERNALS__ is stubbed, so the rakotis accessors go through
  // invoke("kv_get"/"kv_put") and land in invokeMock like everything else.
  it("reload restores a stored id that resolves against the region list", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "map_regions_list") return [MANIFEST];
      if (cmd === "map_storage_usage") return { usedBytes: 0, limitBytes: 1 };
      if (cmd === "kv_get" && args?.k === "map_active_region") return MANIFEST.id;
      return null;
    });
    const store = useMapStore();
    await store.reload();
    expect(store.activeRegionId).toBe(MANIFEST.id);
    expect(store.activeRegion?.name).toBe(MANIFEST.name);
  });

  it("a dangling stored id fails soft to null WITHOUT writing kv", async () => {
    const kvPuts: unknown[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "map_regions_list") return [MANIFEST];
      if (cmd === "map_storage_usage") return { usedBytes: 0, limitBytes: 1 };
      if (cmd === "kv_get" && args?.k === "map_active_region") return "gone";
      if (cmd === "kv_put") kvPuts.push(args);
      return null;
    });
    const store = useMapStore();
    await store.reload();
    expect(store.activeRegionId).toBeNull();
    expect(kvPuts).toHaveLength(0); // a read must never mutate the setting
  });

  it("setActiveRegion persists the id; deactivating writes the empty string", async () => {
    const puts: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "kv_put") puts.push(args ?? {});
      if (cmd === "map_regions_list") return [MANIFEST];
      if (cmd === "map_storage_usage") return { usedBytes: 0, limitBytes: 1 };
      return null;
    });
    const store = useMapStore();
    await store.reload();
    await store.setActiveRegion(MANIFEST.id);
    expect(store.activeRegionId).toBe(MANIFEST.id);
    await store.setActiveRegion(null);
    expect(store.activeRegionId).toBeNull();
    const mapPuts = puts.filter((p) => p.k === "map_active_region");
    expect(mapPuts.map((p) => p.v)).toEqual([MANIFEST.id, ""]);
    expect(mapPuts[0]).toMatchObject({ ns: "p2p:settings", scope: "default" });
  });

  it("a throwing region list leaves the user's choice intact", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "map_regions_list") return [MANIFEST];
      if (cmd === "map_storage_usage") return { usedBytes: 0, limitBytes: 1 };
      if (cmd === "kv_get" && args?.k === "map_active_region") return MANIFEST.id;
      return null;
    });
    const store = useMapStore();
    await store.reload();
    expect(store.activeRegionId).toBe(MANIFEST.id);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "map_regions_list") throw "transient";
      return null;
    });
    await store.reload();
    expect(store.activeRegionId).toBe(MANIFEST.id); // not dropped by a hiccup
  });

  it("import and the P2P accept path never write the active-region key (D7)", async () => {
    const puts: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "kv_put") puts.push(args ?? {});
      if (cmd === "map_region_import") return MANIFEST;
      if (cmd === "map_regions_list") return [MANIFEST];
      if (cmd === "map_storage_usage") return { usedBytes: 0, limitBytes: 1 };
      if (cmd === "map_region_recv_path") return "/tmp/recv-x.pmtiles";
      return null;
    });
    const store = useMapStore();
    await store.importRegion("/tmp/pkg.pmtiles");
    await store.acceptRegionShare({
      type: "map_region", v: 1, manifest: MANIFEST, offerId: "o1", addr: "b32",
    });
    expect(puts.filter((p) => p.k === "map_active_region")).toHaveLength(0);
  });
});

describe("map store — chat-card focus handoff", () => {
  it("focusShare stores the share; consumeFocus hands it over exactly once", () => {
    const store = useMapStore();
    const share = { type: "map_pin", v: 1, name: "Meet", lat: 52.4, lng: 16.9 } as const;
    store.focusShare(share);
    expect(store.pendingFocus).toEqual(share);
    expect(store.consumeFocus()).toEqual(share);
    expect(store.consumeFocus()).toBeNull();
  });
});
