<script setup lang="ts">
// The MapLibre canvas: offline-first tiles through the `enigma-map://` custom
// protocol (one Rust command resolves local regions, then the gated remote
// source), private pins + hand-drawn routes (sealed kv), and "Share to room"
// actions over the MLS seam. Style assets (glyphs/sprites) are bundled under
// public/map/ — the map itself never fetches from a CDN.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import layersFn, { labels as labelsFn } from "protomaps-themes-base";
import {
  isTauri,
  invoke,
  buildPinShare,
  buildRouteShare,
  OyaButton,
  OyaCard,
  OyaEmptyState,
  OyaModal,
  OyaTextField,
  type MapPin,
  type MapRoute,
  type MapShare,
} from "rakotis";
import { policy } from "../../config/app";
import { useChatStore } from "../../stores/chat";
import { useMapStore } from "../../stores/map";

defineProps<{ darkMode?: boolean }>();

const store = useMapStore();
const chatStore = useChatStore();

const container = ref<HTMLDivElement | null>(null);
const ready = ref(false);
const webglOk = ref(true);
const tauri = isTauri();

// Placement / drawing state machine (explicit user actions only).
type Mode = "idle" | "add-pin" | "draw-route";
const mode = ref<Mode>("idle");
const draftPoints = ref<[number, number][]>([]); // [lat, lng]
const nameModal = ref<null | { kind: "pin" | "route"; lat?: number; lng?: number }>(null);
const nameInput = ref("");

// A share opened from a chat card — previewed until the user saves/dismisses.
// Regions never land here (their cards download instead of focusing).
const focus = ref<Exclude<MapShare, { type: "map_region" }> | null>(null);

const canShare = computed(
  () =>
    chatStore.p2p.currentRoom.value !== null &&
    chatStore.p2p.isConnected.value &&
    chatStore.p2p.mlsStatus.value === "ready",
);

let map: maplibregl.Map | null = null;
const pinMarkers = new Map<string, maplibregl.Marker>();
let focusMarker: maplibregl.Marker | null = null;

// ── tile protocol (registered once per app lifetime) ─────────────────────────
let protocolRegistered = false;
function registerProtocol() {
  if (protocolRegistered) return;
  protocolRegistered = true;
  maplibregl.addProtocol("enigma-map", async (params) => {
    const m = /^enigma-map:\/\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
    if (!m) return { data: new Uint8Array(0) };
    try {
      const data = await invoke<ArrayBuffer>("map_get_tile", {
        z: Number(m[1]),
        x: Number(m[2]),
        y: Number(m[3]),
      });
      return { data: new Uint8Array(data) };
    } catch {
      // Source unreachable / policy-blocked: an empty tile, never a crash loop.
      return { data: new Uint8Array(0) };
    }
  });
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

// ── overlays ─────────────────────────────────────────────────────────────────
function routesGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: store.routes.map((r) => ({
      type: "Feature",
      properties: { id: r.id },
      geometry: {
        type: "LineString",
        coordinates: r.points.map(([lat, lng]) => [lng, lat]),
      },
    })),
  };
}

function draftGeoJson(points: [number, number][]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.length < 2 ? [] : [{
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: points.map(([lat, lng]) => [lng, lat]) },
    }],
  };
}

function refreshPins() {
  if (!map) return;
  const seen = new Set<string>();
  for (const pin of store.pins) {
    seen.add(pin.id);
    if (!pinMarkers.has(pin.id)) {
      const marker = new maplibregl.Marker({ color: pin.color ?? "#2563eb" })
        .setLngLat([pin.lng, pin.lat])
        .addTo(map);
      pinMarkers.set(pin.id, marker);
    } else {
      pinMarkers.get(pin.id)!.setLngLat([pin.lng, pin.lat]);
    }
  }
  for (const [id, marker] of pinMarkers) {
    if (!seen.has(id)) {
      marker.remove();
      pinMarkers.delete(id);
    }
  }
}

function refreshRoutes() {
  const src = map?.getSource("user-routes") as maplibregl.GeoJSONSource | undefined;
  src?.setData(routesGeoJson());
}

function refreshDraft() {
  const src = map?.getSource("draft-route") as maplibregl.GeoJSONSource | undefined;
  src?.setData(draftGeoJson(draftPoints.value));
}

// ── boot ─────────────────────────────────────────────────────────────────────
onMounted(async () => {
  if (!tauri) return;
  webglOk.value = webglAvailable();
  if (!webglOk.value || !container.value) return;
  registerProtocol();
  await store.reload();

  let maxZoom: number = policy.map.fallbackSourceMaxZoom;
  try {
    const info = await invoke<{ maxZoom: number } | null>("map_source_info");
    if (info) maxZoom = info.maxZoom;
  } catch { /* no source yet — regions/remote may come later */ }

  map = new maplibregl.Map({
    container: container.value,
    attributionControl: { compact: true },
    center: policy.map.defaultCenter,
    zoom: policy.map.defaultZoom,
    maxZoom: 20,
    style: {
      version: 8,
      glyphs: new URL("/map/glyphs/{fontstack}/{range}.pbf", location.href).toString(),
      sprite: new URL("/map/sprites/v4/light", location.href).toString(),
      sources: {
        protomaps: {
          type: "vector",
          tiles: ["enigma-map://tile/{z}/{x}/{y}"],
          maxzoom: maxZoom,
          attribution: "© OpenStreetMap contributors, Protomaps",
        },
      },
      layers: [
        ...layersFn("protomaps", "light", "en"),
        ...labelsFn("protomaps", "light", "en"),
      ],
    },
  });

  map.on("load", () => {
    if (!map) return;
    map.addSource("user-routes", { type: "geojson", data: routesGeoJson() });
    map.addLayer({
      id: "user-routes-line",
      type: "line",
      source: "user-routes",
      paint: { "line-color": "#dc2626", "line-width": 3, "line-opacity": 0.85 },
    });
    map.addSource("draft-route", { type: "geojson", data: draftGeoJson([]) });
    map.addLayer({
      id: "draft-route-line",
      type: "line",
      source: "draft-route",
      paint: { "line-color": "#f59e0b", "line-width": 3, "line-dasharray": [2, 1] },
    });
    refreshPins();
    ready.value = true;
    applyPendingFocus();
  });

  map.on("click", onMapClick);
});

onBeforeUnmount(() => {
  for (const marker of pinMarkers.values()) marker.remove();
  pinMarkers.clear();
  focusMarker?.remove();
  map?.remove();
  map = null;
});

watch(() => store.pins, refreshPins, { deep: true });
watch(() => store.routes, refreshRoutes, { deep: true });
watch(draftPoints, refreshDraft, { deep: true });
watch(() => store.pendingFocus, applyPendingFocus);

// ── interactions ─────────────────────────────────────────────────────────────
function onMapClick(e: maplibregl.MapMouseEvent) {
  if (mode.value === "add-pin") {
    nameModal.value = { kind: "pin", lat: e.lngLat.lat, lng: e.lngLat.lng };
    nameInput.value = "";
    mode.value = "idle";
  } else if (mode.value === "draw-route") {
    draftPoints.value = [...draftPoints.value, [e.lngLat.lat, e.lngLat.lng]];
  }
}

function startRoute() {
  mode.value = "draw-route";
  draftPoints.value = [];
}

function finishRoute() {
  if (draftPoints.value.length < 2) {
    cancelDraw();
    return;
  }
  nameModal.value = { kind: "route" };
  nameInput.value = "";
}

function cancelDraw() {
  mode.value = "idle";
  draftPoints.value = [];
}

async function confirmName() {
  const modal = nameModal.value;
  const name = nameInput.value.trim();
  if (!modal || !name) return;
  if (modal.kind === "pin" && modal.lat !== undefined && modal.lng !== undefined) {
    await store.addPin(name, modal.lat, modal.lng);
  } else if (modal.kind === "route") {
    await store.addRoute(name, draftPoints.value);
    draftPoints.value = [];
    mode.value = "idle";
  }
  nameModal.value = null;
}

function showPin(pin: MapPin) {
  map?.flyTo({ center: [pin.lng, pin.lat], zoom: Math.max(map.getZoom(), 13) });
}

function showRoute(route: MapRoute) {
  if (!map || route.points.length === 0) return;
  const lats = route.points.map((p) => p[0]);
  const lngs = route.points.map((p) => p[1]);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 60, maxZoom: 15 },
  );
}

async function sharePin(pin: MapPin) {
  await chatStore.p2p.sendMapShare(buildPinShare(pin));
}

async function shareRoute(route: MapRoute) {
  await chatStore.p2p.sendMapShare(buildRouteShare(route));
}

// ── chat-card focus preview (explicit open → explicit save) ──────────────────
function applyPendingFocus() {
  if (!ready.value || !map) return;
  const share = store.consumeFocus();
  if (!share || share.type === "map_region") return;
  focus.value = share;
  focusMarker?.remove();
  focusMarker = null;
  if (share.type === "map_pin") {
    focusMarker = new maplibregl.Marker({ color: "#16a34a" })
      .setLngLat([share.lng, share.lat])
      .addTo(map);
    map.flyTo({ center: [share.lng, share.lat], zoom: Math.max(map.getZoom(), 13) });
  } else {
    draftPoints.value = [...share.points];
    const lats = share.points.map((p) => p[0]);
    const lngs = share.points.map((p) => p[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, maxZoom: 15 },
    );
  }
}

async function saveFocus() {
  const share = focus.value;
  if (!share) return;
  if (share.type === "map_pin") {
    const pin = await store.addPin(share.name, share.lat, share.lng, share.note);
    if (share.color) await store.savePin({ ...pin, color: share.color });
  } else if (share.type === "map_route") {
    await store.addRoute(share.name, share.points);
  }
  dismissFocus();
}

function dismissFocus() {
  focus.value = null;
  focusMarker?.remove();
  focusMarker = null;
  if (mode.value !== "draw-route") draftPoints.value = [];
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
    <!-- Honest degraded states: no Tauri runtime / no WebGL. -->
    <OyaCard v-if="!tauri" class="flex flex-1 items-center justify-center">
      <OyaEmptyState icon="map" size="lg">
        <p class="font-semibold">{{ $t('map.desktopOnlyTitle') }}</p>
        <p>{{ $t('map.desktopOnlyHint') }}</p>
      </OyaEmptyState>
    </OyaCard>
    <OyaCard v-else-if="!webglOk" class="flex flex-1 items-center justify-center">
      <OyaEmptyState icon="map" size="lg">
        <p class="font-semibold">{{ $t('map.noWebglTitle') }}</p>
        <p>{{ $t('map.noWebglHint') }}</p>
      </OyaEmptyState>
    </OyaCard>

    <template v-else>
      <div class="relative min-h-[24rem] flex-1 overflow-hidden rounded-xl border border-accent-2 dark:border-accent-1">
        <div ref="container" class="absolute inset-0" data-testid="map-canvas" />

        <!-- Toolbar -->
        <div class="absolute left-3 top-3 z-10 flex flex-col gap-2">
          <OyaButton
            :variant="mode === 'add-pin' ? 'primary' : 'secondary'"
            @click="mode = mode === 'add-pin' ? 'idle' : 'add-pin'"
          >
            <font-awesome-icon icon="location-dot" /> {{ $t('map.addPin') }}
          </OyaButton>
          <OyaButton v-if="mode !== 'draw-route'" variant="secondary" @click="startRoute">
            <font-awesome-icon icon="route" /> {{ $t('map.drawRoute') }}
          </OyaButton>
          <template v-else>
            <OyaButton variant="primary" :disabled="draftPoints.length < 2" @click="finishRoute">
              {{ $t('map.finishRoute', { n: draftPoints.length }) }}
            </OyaButton>
            <OyaButton variant="secondary" @click="cancelDraw">
              {{ $t('common.cancel') }}
            </OyaButton>
          </template>
        </div>

        <!-- Hint while placing -->
        <p
          v-if="mode !== 'idle'"
          class="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-primary-bg-light/90 px-3 py-1.5 text-xs shadow dark:bg-primary-bg-dark/90"
        >
          {{ mode === 'add-pin' ? $t('map.clickToPlace') : $t('map.clickToExtend') }}
        </p>

        <!-- Received-share preview banner: nothing is saved until the user says so. -->
        <div
          v-if="focus"
          class="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-accent-2 bg-primary-bg-light/95 px-3 py-2 text-sm shadow dark:border-accent-1 dark:bg-primary-bg-dark/95"
        >
          <font-awesome-icon :icon="focus.type === 'map_pin' ? 'location-dot' : 'route'" />
          <span class="max-w-[14rem] truncate font-semibold">{{ focus.name }}</span>
          <OyaButton variant="primary" @click="saveFocus">{{ $t('map.saveShared') }}</OyaButton>
          <OyaButton variant="secondary" @click="dismissFocus">{{ $t('common.close') }}</OyaButton>
        </div>
      </div>

      <!-- Pins / routes sidebar -->
      <div class="flex w-full flex-col gap-3 overflow-y-auto lg:w-80">
        <OyaCard>
          <h3 class="mb-2 text-sm font-bold"><font-awesome-icon icon="location-dot" /> {{ $t('map.pinsTitle') }}</h3>
          <p v-if="store.pins.length === 0" class="text-xs opacity-60">{{ $t('map.noPins') }}</p>
          <ul class="space-y-1">
            <li v-for="pin in store.pins" :key="pin.id" class="flex items-center gap-2 text-sm">
              <button type="button" class="min-w-0 flex-1 truncate text-left hover:opacity-70" @click="showPin(pin)">
                {{ pin.name }}
              </button>
              <button
                type="button"
                class="opacity-60 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-25"
                :disabled="!canShare"
                :title="canShare ? $t('map.sharePin') : $t('map.shareNeedsRoom')"
                @click="sharePin(pin)"
              >
                <font-awesome-icon icon="share-nodes" />
              </button>
              <button
                type="button"
                class="opacity-60 transition hover:opacity-100"
                :title="$t('common.delete')"
                @click="store.deletePin(pin.id)"
              >
                <font-awesome-icon icon="trash" />
              </button>
            </li>
          </ul>
        </OyaCard>

        <OyaCard>
          <h3 class="mb-2 text-sm font-bold"><font-awesome-icon icon="route" /> {{ $t('map.routesTitle') }}</h3>
          <p v-if="store.routes.length === 0" class="text-xs opacity-60">{{ $t('map.noRoutes') }}</p>
          <ul class="space-y-1">
            <li v-for="route in store.routes" :key="route.id" class="flex items-center gap-2 text-sm">
              <button type="button" class="min-w-0 flex-1 truncate text-left hover:opacity-70" @click="showRoute(route)">
                {{ route.name }}
                <span class="opacity-50">({{ $t('map.pointCount', { n: route.points.length }) }})</span>
              </button>
              <button
                type="button"
                class="opacity-60 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-25"
                :disabled="!canShare"
                :title="canShare ? $t('map.shareRoute') : $t('map.shareNeedsRoom')"
                @click="shareRoute(route)"
              >
                <font-awesome-icon icon="share-nodes" />
              </button>
              <button
                type="button"
                class="opacity-60 transition hover:opacity-100"
                :title="$t('common.delete')"
                @click="store.deleteRoute(route.id)"
              >
                <font-awesome-icon icon="trash" />
              </button>
            </li>
          </ul>
        </OyaCard>
      </div>

      <!-- Name prompt for a new pin / finished route -->
      <OyaModal :open="nameModal !== null" @close="nameModal = null">
        <form
          class="w-full max-w-md space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
          @submit.prevent="confirmName"
        >
          <h3 class="text-lg font-bold">
            {{ nameModal?.kind === 'pin' ? $t('map.namePinTitle') : $t('map.nameRouteTitle') }}
          </h3>
          <OyaTextField v-model="nameInput" :placeholder="$t('map.nameLabel')" :maxlength="120" @enter="confirmName" />
          <div class="flex justify-end gap-2">
            <OyaButton variant="secondary" type="button" @click="nameModal = null">{{ $t('common.cancel') }}</OyaButton>
            <OyaButton variant="primary" type="submit" :disabled="!nameInput.trim()">{{ $t('common.save') }}</OyaButton>
          </div>
        </form>
      </OyaModal>
    </template>
  </div>
</template>
