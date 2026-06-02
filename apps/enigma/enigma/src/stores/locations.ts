import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type Zone, type Address } from "../services/api";

export const useLocationsStore = defineStore("locations", () => {
  const zones = ref<Zone[]>([]);
  const addresses = ref<Address[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

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

  return { zones, addresses, loading, error, fetchZones, fetchAddresses, addAddress };
});
