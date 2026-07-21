// Maps — imported offline PMTiles regions, private pins/routes, and share
// handoff, bridged through the `map_*` Tauri commands (src-tauri/src/maps.rs).
// The app never downloads tiles (map.md Part II): region packages come from
// the standalone tools/map_packager and enter via import / P2P share only.
// Desktop-only for anything touching tiles/blobs: every invoke is gated by
// isTauri(); pins/routes ride the kv layer (rakotis mapData) and therefore
// degrade to localStorage in the browser like every other feature.
//
// Wire conventions (mirroring cloud.ts):
//   invoke args    → camelCase (Tauri v2 maps minZoom → min_zoom)
//   map_* results  → camelCase (the Rust structs opt into rename_all)
//   file_* results → snake_case (offer_id, …) — file_xfer.rs structs don't
//   event payloads → camelCase keys (offerId, transferred, total)
// Any Err string starting with "MAPS_STORAGE_LIMIT" means the storage budget
// blocked an import — surfaced verbatim under the usage bar.

import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import { nanoid } from "nanoid";
import {
  isTauri,
  invoke,
  getBuildConfig,
  getMapActiveRegion,
  setMapActiveRegion,
  listPins,
  listRoutes,
  upsertPin,
  upsertRoute,
  removePin,
  removeRoute,
  type MapPin,
  type MapRegionManifest,
  type MapRegionShare,
  type MapRoute,
  type MapShare,
} from "rakotis";

export interface RegionReceive {
  offerId: string;
  state: "transferring" | "importing" | "done" | "error";
  transferred: number;
  total: number; // bytes
  error?: string;
}

interface OfferCreatedWire {
  offer_id: string;
  addr: string;
  name: string;
  size: number;
  mime: string;
}

export const useMapStore = defineStore("map", () => {
  const mapsEnabled = getBuildConfig().maps_enabled;

  const regions = ref<MapRegionManifest[]>([]);
  const pins = ref<MapPin[]>([]);
  const routes = ref<MapRoute[]>([]);
  const usedBytes = ref(0);
  const limitBytes = ref(0);
  /** Incoming P2P region transfers by offerId (fed by file://* events). */
  const receives = reactive(new Map<string, RegionReceive>());
  /** A chat-card share the user chose to open — consumed by MapPanel. */
  const pendingFocus = ref<MapShare | null>(null);
  /** Latest storage/import error (MAPS_STORAGE_LIMIT etc.), shown in Regions. */
  const lastError = ref<string | null>(null);
  /** Active (priority) region id, or null — restored from the sealed setting
   *  on reload. Rust reads the same key for tile ordering; removing the
   *  region clears it Rust-side. */
  const activeRegionId = ref<string | null>(null);
  const activeRegion = computed(
    () => regions.value.find((r) => r.id === activeRegionId.value) ?? null,
  );

  // ── event wiring (once, lazily — pattern: chatTransport.ensureListeners) ────
  let listenersReady = false;
  async function ensureListeners(): Promise<void> {
    if (listenersReady || !isTauri()) return;
    listenersReady = true;
    const { listen } = await import("@tauri-apps/api/event");
    // Incoming region transfers ride the generic file_xfer events, filtered by
    // the offerIds we accepted (useFileShare owns its own offers, not these).
    await listen<{ offerId: string; dir: string; transferred: number; total: number }>(
      "file://progress",
      ({ payload }) => {
        const rx = receives.get(payload.offerId);
        if (rx && payload.dir === "recv") {
          rx.transferred = payload.transferred;
          rx.total = payload.total;
        }
      },
    );
    await listen<{ offerId: string; dir: string }>("file://done", ({ payload }) => {
      const rx = receives.get(payload.offerId);
      if (rx && payload.dir === "recv") void finishReceive(payload.offerId);
    });
    await listen<{ offerId: string; message: string }>("file://error", ({ payload }) => {
      const rx = receives.get(payload.offerId);
      if (rx) {
        rx.state = "error";
        rx.error = payload.message;
      }
    });
  }

  // ── loading ─────────────────────────────────────────────────────────────────
  /** True once a first reload has been ATTEMPTED (success or not). The Map view
   *  waits for this so MapLibre mounts with the resolved active region already
   *  in its :key — otherwise the key flips mid-boot and tears the instance down
   *  while it is still starting up. Outside Tauri there is no sealed store to
   *  resolve (and no map), so nothing is ever gated. */
  const loaded = ref(!isTauri());

  async function reload(): Promise<void> {
    // Every step is best-effort and independent: a failure loading pins (e.g. a
    // sealed-store read before the vault is unlocked) must never prevent the
    // regions from loading — or, upstream, the basemap from rendering at all.
    try {
      await ensureListeners();
    } catch (e) {
      console.error("[map] event listeners failed:", e);
    }
    try {
      pins.value = await listPins();
      routes.value = await listRoutes();
    } catch (e) {
      console.error("[map] pins/routes load failed:", e);
    }
    if (isTauri()) {
      try {
        regions.value = await invoke<MapRegionManifest[]>("map_regions_list");
        const usage = await invoke<{ usedBytes: number; limitBytes: number }>(
          "map_storage_usage",
        );
        usedBytes.value = usage.usedBytes;
        limitBytes.value = usage.limitBytes;
        // Fail soft: an id that no longer resolves means "no active region".
        // The kv is deliberately left alone — map_region_remove owns clearing
        // it, and a read must never mutate a setting.
        const stored = await getMapActiveRegion();
        activeRegionId.value =
          stored && regions.value.some((r) => r.id === stored) ? stored : null;
      } catch (e) {
        console.error("[map] regions load failed:", e);
        regions.value = [];
        // activeRegionId is intentionally untouched: a transient command
        // failure must not look like "the region is gone" and drop the choice.
      }
    }
    loaded.value = true;
  }

  // ── pins / routes (private, sealed at rest — never shared implicitly) ───────
  async function addPin(name: string, lat: number, lng: number, note?: string): Promise<MapPin> {
    const pin: MapPin = { id: nanoid(), name, lat, lng, createdAt: Date.now() };
    if (note) pin.note = note;
    pins.value = await upsertPin(pin);
    return pin;
  }

  async function savePin(pin: MapPin): Promise<void> {
    pins.value = await upsertPin(pin);
  }

  async function deletePin(id: string): Promise<void> {
    pins.value = await removePin(id);
  }

  async function addRoute(name: string, points: [number, number][]): Promise<MapRoute> {
    const route: MapRoute = { id: nanoid(), name, points, createdAt: Date.now() };
    routes.value = await upsertRoute(route);
    return route;
  }

  async function deleteRoute(id: string): Promise<void> {
    routes.value = await removeRoute(id);
  }

  // ── regions ─────────────────────────────────────────────────────────────────
  /** Activate (id) or deactivate (null) the priority region. Camera moves are
   *  the Map panel's business — it fits the active region on every mount. */
  async function setActiveRegion(id: string | null): Promise<void> {
    activeRegionId.value = id;
    await setMapActiveRegion(id ?? "");
  }

  async function removeRegion(id: string): Promise<void> {
    await invoke("map_region_remove", { id });
    await reload();
  }

  async function importRegion(path: string): Promise<void> {
    lastError.value = null;
    try {
      await invoke("map_region_import", { path, manifestJson: null });
      await reload();
    } catch (e) {
      lastError.value = String(e);
      throw e;
    }
  }

  async function exportRegion(id: string, destPath: string): Promise<void> {
    await invoke("map_region_export", { id, destPath });
  }

  /** Register the blob with file_xfer and return the wire fields for the MLS
   *  `map_region` card ({manifest, offerId, addr}). */
  async function offerRegion(id: string): Promise<{ offerId: string; addr: string } | null> {
    const offer = await invoke<OfferCreatedWire>("map_region_offer", { id });
    return { offerId: offer.offer_id, addr: offer.addr };
  }

  /** Accept a received `map_region` card: transfer the blob over file_xfer,
   *  then verify + register it (BLAKE3 + manifest checks happen in Rust). */
  async function acceptRegionShare(share: MapRegionShare): Promise<void> {
    await ensureListeners();
    const dest = await invoke<string>("map_region_recv_path", { offerId: share.offerId });
    receives.set(share.offerId, {
      offerId: share.offerId,
      state: "transferring",
      transferred: 0,
      total: share.manifest.size,
    });
    pendingImports.set(share.offerId, { dest, manifest: share.manifest });
    try {
      await invoke("file_download", { addr: share.addr, offerId: share.offerId, dest });
    } catch (e) {
      const rx = receives.get(share.offerId);
      if (rx) {
        rx.state = "error";
        rx.error = String(e);
      }
      pendingImports.delete(share.offerId);
      throw e;
    }
  }

  const pendingImports = new Map<string, { dest: string; manifest: MapRegionManifest }>();

  async function finishReceive(offerId: string): Promise<void> {
    const pending = pendingImports.get(offerId);
    const rx = receives.get(offerId);
    if (!pending || !rx) return;
    pendingImports.delete(offerId);
    rx.state = "importing";
    try {
      await invoke("map_region_import", {
        path: pending.dest,
        manifestJson: JSON.stringify(pending.manifest),
      });
      rx.state = "done";
      await reload();
    } catch (e) {
      rx.state = "error";
      rx.error = String(e);
    }
  }

  /** Hand a chat-card share to the Maps view (called on explicit user action —
   *  nothing ever opens automatically). */
  function focusShare(share: MapShare): void {
    pendingFocus.value = share;
  }

  function consumeFocus(): MapShare | null {
    const share = pendingFocus.value;
    pendingFocus.value = null;
    return share;
  }

  return {
    mapsEnabled,
    regions, pins, routes, usedBytes, limitBytes, receives,
    pendingFocus, lastError, activeRegionId, activeRegion, loaded,
    reload, setActiveRegion,
    addPin, savePin, deletePin, addRoute, deleteRoute,
    removeRegion, importRegion, exportRegion,
    offerRegion, acceptRegionShare,
    focusShare, consumeFocus,
  };
});
