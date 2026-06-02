import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type Zone, type Address, type MapLocation, type MapLayer, type RouteResult } from "../services/api";

export type { MapLocation, MapLayer, RouteResult };

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
      zones.value = res.zones;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load zones";
    } finally {
      loading.value = false;
    }
  }

  async function fetchAddresses() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.getAddresses();
      addresses.value = res.addresses;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load addresses";
    } finally {
      loading.value = false;
    }
  }

  async function addAddress(data: { street: string; building: string; locality_name: string; country_name: string; state_or_province_name?: string }) {
    const addr = await api.createAddress(data);
    addresses.value.unshift(addr);
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
      mapLocations.value = locRes.locations;
      mapLayers.value = layerRes.layers;
    } catch (e: any) {
      mapError.value = e.message ?? "Failed to load map data";
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
