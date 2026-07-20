<script setup lang="ts">
import { ref } from "vue";
import MapPanel from "../components/map/MapPanel.vue";
import RegionsPanel from "../components/map/RegionsPanel.vue";
import { useMapStore } from "../stores/map";

const mapStore = useMapStore();

// darkMode is class-based (`.dark` on <html>); the prop also drives the
// segmented pill borders (mirroring EnigmaFilesView's tab pill).
defineProps<{ darkMode?: boolean }>();

// Map (canvas + pins/routes) vs Regions (offline downloads, import/export,
// sharing, storage budget).
type MapTab = "map" | "regions";
const activeTab = ref<MapTab>("map");
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <h1 class="sr-only">{{ $t('map.title') }}</h1>
    <!-- Map / Regions tabs -->
    <div
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex gap-1 rounded-xl border p-1 text-sm font-semibold"
    >
      <button
        type="button"
        :class="activeTab === 'map'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'map'"
      >
        <font-awesome-icon icon="map" />{{ $t('map.mapTab') }}
      </button>
      <button
        type="button"
        :class="activeTab === 'regions'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'regions'"
      >
        <font-awesome-icon icon="download" />{{ $t('map.regionsTab') }}
      </button>
    </div>

    <div class="min-h-0 flex-1">
      <!-- The MapLibre canvas + private pins/routes. The :key forces a fresh
           MapLibre instance when the active region changes: MapLibre caches
           parsed tiles in the GL source, so a priority switch would otherwise
           not repaint. (Lighter alternative if a full re-init ever proves too
           heavy: map.refreshTiles("protomaps") — reloads tiles but cannot
           change source maxzoom.) -->
      <MapPanel
        v-if="activeTab === 'map'"
        :key="mapStore.activeRegionId ?? 'none'"
        :dark-mode="darkMode"
      />
      <!-- Offline regions: import / export / share / activate / remove. -->
      <RegionsPanel v-else @show-map="activeTab = 'map'" />
    </div>
  </div>
</template>
