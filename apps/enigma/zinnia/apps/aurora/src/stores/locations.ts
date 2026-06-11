import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type Zone, type Address, type MapLocation, type MapLayer, type RouteResult } from "../services/api";
import * as yStore from "../services/yStore";

export type { MapLocation, MapLayer, RouteResult };

// Locations are a P2P-synced domain: a single y_store doc holds each collection in its
// own map, so the whole domain syncs under the "locations" prefix.
const DOC = "locations";

export const useLocationsStore = defineStore("locations", () => {
  const zones = ref<Zone[]>([]);
  const addresses = ref<Address[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const mapLocations = ref<MapLocation[]>([]);
  const mapLayers = ref<MapLayer[]>([]);
  const mapLoading = ref(false);
  const mapError = ref<string | null>(null);

  async function fetchZones() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.getZones();
      zones.value = await yStore.persist<Zone>(DOC, "zones", res.zones);
    } catch (e: any) {
      const cached = await yStore.cached<Zone>(DOC, "zones");
      if (cached) zones.value = cached;
      else error.value = e.message ?? "Failed to load zones";
    } finally {
      loading.value = false;
    }
  }

  async function fetchAddresses() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.getAddresses();
      addresses.value = await yStore.persist<Address>(DOC, "addresses", res.addresses);
    } catch (e: any) {
      const cached = await yStore.cached<Address>(DOC, "addresses");
      if (cached) addresses.value = cached;
      else error.value = e.message ?? "Failed to load addresses";
    } finally {
      loading.value = false;
    }
  }

  async function addAddress(data: { street: string; building: string; locality_name: string; country_name: string; state_or_province_name?: string }) {
    const addr = await api.createAddress(data);
    addresses.value.unshift(addr);
    // Mirror into the synced doc so the new address is included in p2p sync.
    void yStore.persist<Address>(DOC, "addresses", [addr]);
    return addr;
  }

  async function fetchMapData() {
    mapLoading.value = true;
    mapError.value = null;
    try {
      const [locRes, layerRes] = await Promise.all([
        api.getMapData(),
        api.getMapLayers(),
      ]);
      mapLocations.value = await yStore.persist<MapLocation>(DOC, "mapLocations", locRes.locations);
      mapLayers.value = await yStore.persist<MapLayer>(DOC, "mapLayers", layerRes.layers);
    } catch (e: any) {
      const [cl, cy] = await Promise.all([
        yStore.cached<MapLocation>(DOC, "mapLocations"),
        yStore.cached<MapLayer>(DOC, "mapLayers"),
      ]);
      if (cl) mapLocations.value = cl;
      if (cy) mapLayers.value = cy;
      if (!cl && !cy) mapError.value = e.message ?? "Failed to load map data";
    } finally {
      mapLoading.value = false;
    }
  }

  async function searchRoute(data: { mode: string; start_lat: number; start_lng: number; end_lat: number; end_lng: number }): Promise<RouteResult> {
    return api.searchRoute(data);
  }

  return {
    zones, addresses, loading, error,
    mapLocations, mapLayers, mapLoading, mapError,
    fetchZones, fetchAddresses, addAddress, fetchMapData, searchRoute,
  };
});
