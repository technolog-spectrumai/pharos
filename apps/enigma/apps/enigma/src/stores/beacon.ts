// Beacon — expiring location shares on the user's own faros server, bridged
// through the `beacon_*` Tauri commands and rendered on the Maps tab.
// Server contract: the faros repo's for_enigma.md. Everything here is
// volatile: beacon data is never persisted at rest (no kv namespace) — a
// fresh fetch replaces it, expiry culling happens at render time via
// isBeaconLive, and the server itself never returns expired shares.
//
// Same wire conventions as stores/cloud.ts (invoke args camelCase, results
// re-validated through rakotis beaconModel — server JSON is untrusted input).
// Any "unauthorized…" error means the shared cloud session died: Rust already
// cleared the kv token, so we flip the cloud store to logged-out too.

import { ref } from "vue";
import { defineStore } from "pinia";
import {
  isTauri,
  invoke,
  getBuildConfig,
  parseBeaconAll,
  parseBeaconNear,
  validateBeaconPin,
  validateBeaconZone,
  validateBeaconRoute,
  type BeaconPin,
  type BeaconZone,
  type BeaconRoute,
} from "rakotis";

import { useCloudStore } from "./cloud";

export const useBeaconStore = defineStore("beacon", () => {
  const cloud = useCloudStore();

  const pins = ref<BeaconPin[]>([]);
  const zones = ref<BeaconZone[]>([]);
  const routes = ref<BeaconRoute[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** View preference — deliberately not persisted (sharedLayerVisible precedent). */
  const layerVisible = ref(true);
  /** Near-mode: pins sorted by distance around a queried center; null = off. */
  const nearPins = ref<BeaconPin[] | null>(null);
  const nearCenter = ref<{ lat: number; lng: number } | null>(null);

  // Beacon needs the cloud client AND the Maps tab; a build without either has
  // no beacon (Rust rejects direct invokes with BEACON_DISABLED regardless).
  const beaconAvailable =
    isTauri() && getBuildConfig().cloud_allow_connections && getBuildConfig().maps_enabled;

  function asMessage(e: unknown): string {
    if (typeof e === "string") return e;
    return (e as Error)?.message ?? String(e);
  }

  /** "unauthorized…" ⇒ the shared cloud session died (kv already cleared by
   *  Rust): mirror cloud.ts by flipping its store logged-out and drop our data. */
  function sessionExpired(msg: string): boolean {
    if (!msg.startsWith("unauthorized")) return false;
    cloud.loggedIn = false;
    cloud.username = "";
    clear();
    return true;
  }

  function clear() {
    pins.value = [];
    zones.value = [];
    routes.value = [];
    nearPins.value = null;
    nearCenter.value = null;
  }

  // Also behind the Cloud tab's runtime master switch (cloud.md): with the
  // knob off, Rust refuses beacon calls — the UI must not even try.
  const active = () => beaconAvailable && cloud.enabled && cloud.loggedIn;

  /** Fetch everything (GET /beacon/all). Best-effort: errors land in `error`. */
  async function refresh(): Promise<void> {
    if (!active()) return;
    loading.value = true;
    try {
      const res = await invoke<unknown>("beacon_all", { serverUrl: cloud.serverUrl });
      const all = parseBeaconAll(res);
      pins.value = all.pins;
      zones.value = all.zones;
      routes.value = all.routes;
      error.value = null;
    } catch (e) {
      const msg = asMessage(e);
      if (!sessionExpired(msg)) error.value = msg;
    } finally {
      loading.value = false;
    }
  }

  /** Publish (or move) my live pin; the server keeps one per user. */
  async function publishPin(
    lat: number,
    lng: number,
    ttlSeconds: number,
    comment: string,
  ): Promise<void> {
    if (!active()) return;
    return guarded(async () => {
      const res = await invoke<{ pin?: unknown }>("beacon_publish_pin", {
        serverUrl: cloud.serverUrl,
        lat,
        lng,
        ttlSeconds,
        comment,
      });
      const pin = validateBeaconPin(res?.pin);
      if (pin) {
        pins.value = [pin, ...pins.value.filter((p) => p.user !== pin.user)];
      } else {
        void refresh();
      }
    });
  }

  /** Retract my pin (idempotent server-side). */
  async function deletePin(): Promise<void> {
    if (!active()) return;
    return guarded(async () => {
      await invoke("beacon_delete_pin", { serverUrl: cloud.serverUrl });
      pins.value = pins.value.filter((p) => p.user !== cloud.username);
    });
  }

  /** Publish a zone from open [lat, lng] corners (Rust closes the ring). */
  async function publishZone(
    name: string,
    points: [number, number][],
    ttlSeconds: number,
    comment: string,
  ): Promise<void> {
    if (!active()) return;
    return guarded(async () => {
      const res = await invoke<{ zone?: unknown }>("beacon_publish_zone", {
        serverUrl: cloud.serverUrl,
        name,
        points,
        ttlSeconds,
        comment,
      });
      const zone = validateBeaconZone(res?.zone);
      if (zone) zones.value = [zone, ...zones.value];
      else void refresh();
    });
  }

  /** Publish a route from [lat, lng] waypoints. */
  async function publishRoute(
    name: string,
    points: [number, number][],
    ttlSeconds: number,
    comment: string,
  ): Promise<void> {
    if (!active()) return;
    return guarded(async () => {
      const res = await invoke<{ route?: unknown }>("beacon_publish_route", {
        serverUrl: cloud.serverUrl,
        name,
        points,
        ttlSeconds,
        comment,
      });
      const route = validateBeaconRoute(res?.route);
      if (route) routes.value = [route, ...routes.value];
      else void refresh();
    });
  }

  async function deleteZone(id: number): Promise<void> {
    if (!active()) return;
    return guarded(async () => {
      await invoke("beacon_delete_zone", { serverUrl: cloud.serverUrl, id });
      zones.value = zones.value.filter((z) => z.id !== id);
    });
  }

  async function deleteRoute(id: number): Promise<void> {
    if (!active()) return;
    return guarded(async () => {
      await invoke("beacon_delete_route", { serverUrl: cloud.serverUrl, id });
      routes.value = routes.value.filter((r) => r.id !== id);
    });
  }

  /** GET /beacon/near — pins around a point, sorted by distance server-side. */
  async function near(lat: number, lng: number, radiusM: number): Promise<void> {
    if (!active()) return;
    return guarded(async () => {
      const res = await invoke<unknown>("beacon_near", {
        serverUrl: cloud.serverUrl,
        lat,
        lon: lng,
        radiusM,
      });
      nearPins.value = parseBeaconNear(res);
      nearCenter.value = { lat, lng };
    });
  }

  function clearNear() {
    nearPins.value = null;
    nearCenter.value = null;
  }

  /** Flip to logged-out on "unauthorized…", then rethrow a normalized Error so
   *  the calling modal/card can show the message (cloud.ts guarded precedent). */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const msg = asMessage(e);
      sessionExpired(msg);
      throw new Error(msg);
    }
  }

  return {
    beaconAvailable,
    pins,
    zones,
    routes,
    loading,
    error,
    layerVisible,
    nearPins,
    nearCenter,
    refresh,
    publishPin,
    deletePin,
    publishZone,
    publishRoute,
    deleteZone,
    deleteRoute,
    near,
    clearNear,
    clear,
  };
});
