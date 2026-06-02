<script setup lang="ts">
import { ref, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useLocationsStore } from "../stores/locations";

defineProps<{ darkMode: boolean }>();

const store = useLocationsStore();
const { zones, addresses, loading, error } = storeToRefs(store);

const tab = ref<"zones" | "addresses">("zones");

const newStreet = ref("");
const newBuilding = ref("");
const newLocality = ref("");
const newCountry = ref("");
const creating = ref(false);
const createError = ref<string | null>(null);

onMounted(() => {
  store.fetchZones();
  store.fetchAddresses();
});

async function createAddress() {
  if (!newStreet.value.trim() && !newLocality.value.trim()) return;
  creating.value = true;
  createError.value = null;
  try {
    await store.addAddress({
      street: newStreet.value.trim(),
      building: newBuilding.value.trim(),
      locality_name: newLocality.value.trim(),
      country_name: newCountry.value.trim().toUpperCase().slice(0, 2),
    });
    newStreet.value = "";
    newBuilding.value = "";
    newLocality.value = "";
    newCountry.value = "";
  } catch (e: any) {
    createError.value = e.message ?? "Failed to create address";
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="flex w-full flex-col gap-4">

    <!-- Tab toggle -->
    <div class="flex gap-1">
      <button
        @click="tab = 'zones'"
        :class="[
          'rounded-lg px-4 py-2 text-sm font-semibold border transition',
          tab === 'zones'
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'
        ]"
      >
        <font-awesome-icon icon="map" class="mr-1.5" />Zones
      </button>
      <button
        @click="tab = 'addresses'"
        :class="[
          'rounded-lg px-4 py-2 text-sm font-semibold border transition',
          tab === 'addresses'
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'
        ]"
      >
        <font-awesome-icon icon="location-dot" class="mr-1.5" />Addresses
      </button>
    </div>

    <div v-if="error" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ error }}</div>

    <!-- Zones tab -->
    <template v-if="tab === 'zones'">
      <div v-if="loading" class="flex items-center justify-center py-16 opacity-50">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>
      <div v-else-if="zones.length === 0" class="flex flex-col items-center justify-center py-16 opacity-40 gap-3">
        <font-awesome-icon icon="map" class="text-4xl" />
        <p class="text-sm">No zones found</p>
      </div>
      <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="zone in zones"
          :key="zone.id"
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border p-4 shadow-sm"
        >
          <div class="flex items-start gap-2">
            <font-awesome-icon icon="map" class="mt-0.5 opacity-50 shrink-0" />
            <div>
              <p class="font-semibold text-sm">{{ zone.name }}</p>
              <p v-if="zone.territory_name" class="text-xs opacity-50 mt-0.5">{{ zone.territory_name }}</p>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Addresses tab -->
    <template v-else>
      <!-- Create form -->
      <div
        :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="rounded-xl border p-4 shadow-sm"
      >
        <h3 class="mb-3 text-sm font-bold opacity-70">Add Address</h3>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input v-model="newStreet" type="text" placeholder="Street"
            :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
            class="rounded-lg border px-3 py-2 text-sm outline-none col-span-2" />
          <input v-model="newBuilding" type="text" placeholder="Building #"
            :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
            class="rounded-lg border px-3 py-2 text-sm outline-none" />
          <input v-model="newLocality" type="text" placeholder="City"
            :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
            class="rounded-lg border px-3 py-2 text-sm outline-none" />
          <input v-model="newCountry" type="text" placeholder="CC (e.g. PL)" maxlength="2"
            :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
            class="rounded-lg border px-3 py-2 text-sm outline-none uppercase" />
          <button
            @click="createAddress"
            :disabled="creating"
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="col-span-2 sm:col-span-1 rounded-lg px-4 py-2 text-sm font-bold transition hover:opacity-90 disabled:opacity-50"
          >
            {{ creating ? "Adding…" : "Add" }}
          </button>
        </div>
        <p v-if="createError" class="mt-2 text-xs text-red-400">{{ createError }}</p>
      </div>

      <!-- Address list -->
      <div v-if="addresses.length === 0" class="flex flex-col items-center justify-center py-10 opacity-40 gap-3">
        <font-awesome-icon icon="location-dot" class="text-4xl" />
        <p class="text-sm">No addresses yet</p>
      </div>
      <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="addr in addresses"
          :key="addr.id"
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border p-4 shadow-sm"
        >
          <div class="flex items-start gap-2">
            <font-awesome-icon icon="location-dot" class="mt-0.5 opacity-50 shrink-0" />
            <div>
              <p class="font-semibold text-sm">{{ addr.display }}</p>
              <p v-if="addr.lat && addr.lng" class="text-xs opacity-40 font-mono mt-0.5">
                {{ addr.lat.toFixed(4) }}, {{ addr.lng.toFixed(4) }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
