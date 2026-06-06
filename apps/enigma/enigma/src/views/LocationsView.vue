<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useLocationsStore } from "../stores/locations";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const props = defineProps<{ darkMode: boolean }>();

type Tab = "map" | "zones" | "addresses" | "route";
const tab = ref<Tab>("map");

const store = useLocationsStore();
const { zones, addresses, loading, error, mapLocations, mapLayers, mapLoading, mapError } = storeToRefs(store);

// ── Leaflet DOM refs ─────────────────────────────────────────────────────────
const mapEl = ref<HTMLElement | null>(null);
const routeMapEl = ref<HTMLElement | null>(null);

let map: L.Map | null = null;
let routeMap: L.Map | null = null;
let activeTileMain: L.TileLayer | null = null;
let activeTileRoute: L.TileLayer | null = null;

let featureLayers: { type: string; name: string; layer: L.GeoJSON }[] = [];
let featuresDict: Record<string, { layer: L.GeoJSON; type: string }> = {};
let allBounds: L.LatLngBounds | null = null;
let mapLayerGroup: L.GeoJSON | null = null;
let mapLayerLabelGroup: L.LayerGroup | null = null;
let mapSearchMarker: L.CircleMarker | null = null;
let routeLayer: L.GeoJSON | null = null;
let mapSearchDebounce: ReturnType<typeof setTimeout> | null = null;

// ── UI state ─────────────────────────────────────────────────────────────────
const sidebarOpen = ref(false);
const routeFormOpen = ref(true);
const sidebarSearch = ref("");
const mapSearch = ref("");
const mapSearchResults = ref<any[]>([]);
const mapSearchLoading = ref(false);
const selectedName = ref("");
const activeType = ref("All");
const visibleTypes = ref<Record<string, boolean>>({});
const selectedLayerSlug = ref("");
const overlayOpacity = ref(0.35);

// ── Address form ─────────────────────────────────────────────────────────────
const newStreet = ref("");
const newBuilding = ref("");
const newLocality = ref("");
const newCountry = ref("");
const creating = ref(false);
const createError = ref<string | null>(null);

// ── Route search ─────────────────────────────────────────────────────────────
const routeMode = ref("car");
const startAddressId = ref("");
const endAddressId = ref("");
const startLat = ref("52.0000");
const startLng = ref("19.0000");
const endLat = ref("52.2000");
const endLng = ref("19.5000");
const routeSearching = ref(false);
const routeError = ref<string | null>(null);
const routeResult = ref<any>(null);

const routeModeOptions = [
  { value: "car", label: "Car", icon: "car-side" },
  { value: "bicycle", label: "Bicycle", icon: "bicycle" },
  { value: "foot", label: "Foot", icon: "person-walking" },
];

// ── Computed ─────────────────────────────────────────────────────────────────
const availableTypes = computed(() => {
  const s = new Set(mapLocations.value.map((l) => l.type).filter(Boolean));
  return ["All", ...Array.from(s)];
});

const visibleLocations = computed(() => {
  const q = sidebarSearch.value.trim().toLowerCase();
  return mapLocations.value.filter((loc) => {
    const typeOk = activeType.value === "All" || loc.type === activeType.value;
    const typeVisible = visibleTypes.value[loc.type] !== false;
    const searchOk = !q || `${loc.name} ${loc.type} ${loc.detail ?? ""}`.toLowerCase().includes(q);
    return typeOk && typeVisible && searchOk;
  });
});

const mappedCount = computed(() => mapLocations.value.filter((l) => l.geometry).length);

const selectedLayer = computed(() => mapLayers.value.find((l) => l.slug === selectedLayerSlug.value) ?? null);

const geoAddresses = computed(() => addresses.value.filter((a) => a.lat != null && a.lng != null));

// ── Colors ───────────────────────────────────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  Territory: "#4f5fa1",
  Zone: "#6b7280",
  "Route Chain": "#f59e0b",
  Route: "#3b82f6",
  Address: "#10b981",
  Travel: "#ef4444",
  Visit: "#f97316",
};

function locColor(type: string): string {
  return TYPE_COLORS[type] ?? "#4f5fa1";
}

function locStyle(type: string): L.CircleMarkerOptions & L.PathOptions {
  const color = locColor(type);
  return {
    color,
    fillColor: color,
    fillOpacity: ["Territory", "Zone"].includes(type) ? 0.16 : 0.7,
    opacity: 0.95,
    radius: 7,
    weight: type === "Route Chain" ? 6 : ["Route", "Travel"].includes(type) ? 4 : 2,
  };
}

// ── Map tile layers ───────────────────────────────────────────────────────────
function makeTiles(dark: boolean): L.TileLayer {
  if (dark) {
    return L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> © CARTO',
    });
  }
  return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  });
}


// ── Main map init ─────────────────────────────────────────────────────────────
function initMainMap() {
  if (!mapEl.value || map) return;

  map = L.map(mapEl.value, { zoomControl: false, scrollWheelZoom: true }).setView([52.0, 19.0], 5);
  activeTileMain = makeTiles(props.darkMode).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  renderLocations();
}

function initRouteMap() {
  if (!routeMapEl.value || routeMap) return;

  routeMap = L.map(routeMapEl.value, { zoomControl: false, scrollWheelZoom: true }).setView([52.0, 19.0], 5);
  activeTileRoute = makeTiles(props.darkMode).addTo(routeMap);
  L.control.zoom({ position: "bottomright" }).addTo(routeMap);
}

// ── Render features ───────────────────────────────────────────────────────────
function renderLocations() {
  if (!map) return;

  featureLayers.forEach((item) => { try { map!.removeLayer(item.layer); } catch {} });
  featureLayers = [];
  featuresDict = {};
  allBounds = null;

  mapLocations.value.forEach((item) => {
    if (!item.geometry) return;

    const style = locStyle(item.type);
    const layer = L.geoJSON(item.geometry as any, {
      style: () => style,
      pointToLayer: (_f, latlng) => L.circleMarker(latlng, style as L.CircleMarkerOptions),
    });

    const popup = `<strong style="font-size:13px">${item.type}</strong><br>${item.name}` +
      (item.detail ? `<br><small style="opacity:.7">${item.detail}</small>` : "");
    layer.bindPopup(popup);
    layer.addTo(map!);

    const bounds = layer.getBounds();
    if (bounds.isValid()) {
      allBounds = allBounds ? allBounds.extend(bounds) : bounds;
    }

    featureLayers.push({ type: item.type, name: item.name, layer });
    featuresDict[item.name] = { layer, type: item.type };
  });

  // Init visible types
  availableTypes.value.forEach((t) => {
    if (t !== "All" && visibleTypes.value[t] === undefined) {
      visibleTypes.value[t] = true;
    }
  });

  // Load default layer overlay
  if (mapLayers.value.length && !selectedLayerSlug.value) {
    selectedLayerSlug.value = mapLayers.value[0].slug;
  }
  updateLayerOverlay();

  fitAll();
}

// ── Map overlay (map layers) ──────────────────────────────────────────────────
function hexToRgb(h: string) {
  const n = parseInt(h.replace("#", "").padStart(6, "0"), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mixHex(a: string, b: string, t: number) {
  const fa = hexToRgb(a), fb = hexToRgb(b);
  const r = Math.round(fa.r + (fb.r - fa.r) * t);
  const g = Math.round(fa.g + (fb.g - fa.g) * t);
  const bl = Math.round(fa.b + (fb.b - fa.b) * t);
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function layerHeatColor(layer: any, value: number): string {
  const palette = ["#5f7fc9", "#5fa38c", "#ff4455"];
  const vals = (layer.polygons as any[]).map((p) => Number(p.value));
  let min = layer.min_value ?? Math.min(...vals);
  let max = layer.max_value ?? Math.max(...vals);
  let t = max === min ? 0.5 : (value - min) / (max - min);
  if (layer.inverted_importance) t = 1 - t;
  if (layer.half_range) t = t * 0.5;
  t = Math.max(0, Math.min(1, t));
  return t <= 0.5 ? mixHex(palette[0], palette[1], t * 2) : mixHex(palette[1], palette[2], (t - 0.5) * 2);
}

function updateLayerOverlay() {
  if (!map) return;

  if (mapLayerGroup) { map.removeLayer(mapLayerGroup); mapLayerGroup = null; }
  if (mapLayerLabelGroup) { map.removeLayer(mapLayerLabelGroup); mapLayerLabelGroup = null; }

  const layer = selectedLayer.value;
  if (!layer || !layer.polygons.length) return;

  const opacity = overlayOpacity.value;
  const labels: L.Marker[] = [];

  mapLayerGroup = L.geoJSON(
    layer.polygons.map((p) => ({ type: "Feature", properties: { name: p.name, value: p.value }, geometry: p.geometry })) as any,
    {
      style: (feature) => {
        const color = layerHeatColor(layer, feature?.properties?.value ?? 0);
        return { color, fillColor: color, fillOpacity: opacity, opacity: Math.min(0.95, opacity + 0.25), weight: 2 };
      },
      onEachFeature: (feature, lyr) => {
        const unit = layer.unit ? ` ${layer.unit}` : "";
        lyr.bindPopup(`<strong>${layer.name}</strong><br>${feature.properties?.name}<br>${feature.properties?.value}${unit}`);

        const bounds = (lyr as L.Polygon).getBounds?.();
        const center = bounds?.getCenter();
        if (!center) return;

        const color = layerHeatColor(layer, feature?.properties?.value ?? 0);
        const unit2 = layer.unit ? ` ${layer.unit}` : "";
        labels.push(
          L.marker(center, {
            interactive: false,
            icon: L.divIcon({
              className: "",
              html: `<span style="display:inline-flex;align-items:center;gap:3px;background:${color};color:#fff;border:2px solid #fff;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:800;box-shadow:0 4px 10px rgba(0,0,0,.2)">${feature.properties?.value}${unit2}</span>`,
            }),
          })
        );
      },
    }
  ).addTo(map);

  if (labels.length) {
    mapLayerLabelGroup = L.layerGroup(labels).addTo(map);
  }
}

// ── Map actions ───────────────────────────────────────────────────────────────
function fitAll() {
  if (!map || !allBounds?.isValid()) return;
  map.fitBounds(allBounds, { padding: [28, 28], maxZoom: 14 });
}

function resetView() {
  selectedName.value = "";
  clearHighlight();
  fitAll();
}

function selectLocation(loc: any) {
  selectedName.value = loc.name;
  zoomToFeature(loc.name);
  highlightFeature(loc.name);
}

function zoomToFeature(name: string) {
  const item = featuresDict[name];
  if (!item || !map) return;
  const bounds = item.layer.getBounds();
  if (bounds.isValid()) {
    const maxZoom = ["Address", "Visit"].includes(item.type) ? 16 : 13;
    map.fitBounds(bounds, { padding: [36, 36], maxZoom });
    item.layer.openPopup();
  }
}

function highlightFeature(name: string) {
  featureLayers.forEach((item) => {
    const active = item.name === name;
    const base = locStyle(item.type);
    if ((item.layer as any).setStyle) {
      (item.layer as any).setStyle({
        ...base,
        opacity: active ? 1 : 0.18,
        fillOpacity: active ? 0.7 : 0.06,
        weight: active ? 7 : (base.weight as number),
      });
    }
    if (active && (item.layer as any).bringToFront) {
      (item.layer as any).bringToFront();
    }
  });
}

function clearHighlight() {
  featureLayers.forEach((item) => {
    if ((item.layer as any).setStyle) {
      (item.layer as any).setStyle(locStyle(item.type));
    }
  });
}

function toggleType(type: string) {
  visibleTypes.value = { ...visibleTypes.value, [type]: !(visibleTypes.value[type] ?? true) };
  applyVisibility();
}

function showAllTypes() {
  const updated: Record<string, boolean> = {};
  Object.keys(visibleTypes.value).forEach((t) => { updated[t] = true; });
  visibleTypes.value = updated;
  applyVisibility();
}

function hideAllTypes() {
  const updated: Record<string, boolean> = {};
  Object.keys(visibleTypes.value).forEach((t) => { updated[t] = false; });
  visibleTypes.value = updated;
  activeType.value = "All";
  applyVisibility();
}

function applyVisibility() {
  if (!map) return;
  featureLayers.forEach((item) => {
    const show = visibleTypes.value[item.type] !== false;
    if (show && !map!.hasLayer(item.layer)) item.layer.addTo(map!);
    if (!show && map!.hasLayer(item.layer)) map!.removeLayer(item.layer);
  });
}

// ── Map search ────────────────────────────────────────────────────────────────
watch(mapSearch, (val) => {
  if (mapSearchDebounce) clearTimeout(mapSearchDebounce);
  if (!val.trim()) { mapSearchResults.value = []; return; }
  mapSearchDebounce = setTimeout(() => doMapSearch(val.trim()), 350);
});

async function doMapSearch(q: string) {
  if (q.length < 2) { mapSearchResults.value = []; return; }

  const local = mapLocations.value
    .filter((l) => l.geometry && `${l.name} ${l.type}`.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 4)
    .map((l) => ({ ...l, source: "db", label: l.name }));

  mapSearchResults.value = local;
  mapSearchLoading.value = true;

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=4`;
    const res = await fetch(url, { headers: { "Accept-Language": "en" } });
    const data = await res.json();
    const remote = data.map((item: any) => ({
      name: item.display_name.split(",")[0],
      label: item.display_name.split(",")[0],
      detail: item.display_name.split(",").slice(1, 3).join(",").trim(),
      type: "Place",
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
      geometry: null,
      source: "web",
    }));
    const seen = new Set(local.map((r: any) => r.label));
    mapSearchResults.value = [...local, ...remote.filter((r: any) => !seen.has(r.label))].slice(0, 8);
  } catch {
    // keep local results
  } finally {
    mapSearchLoading.value = false;
  }
}

function goToResult(result: any) {
  mapSearch.value = "";
  mapSearchResults.value = [];

  if (result.geometry) {
    selectedName.value = result.name;
    zoomToFeature(result.name);
    highlightFeature(result.name);
    return;
  }

  if (result.lat && result.lng && map) {
    if (mapSearchMarker) map.removeLayer(mapSearchMarker);
    mapSearchMarker = L.circleMarker([result.lat, result.lng], {
      radius: 9, color: "#4f5fa1", fillColor: "#4f5fa1", fillOpacity: 0.85, weight: 3,
    })
      .bindPopup(`<strong>${result.label}</strong><br>${(result.lat as number).toFixed(5)}, ${(result.lng as number).toFixed(5)}`)
      .addTo(map);
    mapSearchMarker.openPopup();
    map.setView([result.lat, result.lng], 13);
    selectedName.value = result.label;
  }
}

// ── Layer selection ───────────────────────────────────────────────────────────
watch(selectedLayerSlug, () => updateLayerOverlay());
watch(overlayOpacity, () => updateLayerOverlay());

// ── Address form ───────────────────────────────────────────────────────────────
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

// ── Route search ───────────────────────────────────────────────────────────────
watch(startAddressId, (id) => {
  const a = geoAddresses.value.find((a) => String(a.id) === id);
  if (a) { startLat.value = a.lat!.toFixed(6); startLng.value = a.lng!.toFixed(6); }
});

watch(endAddressId, (id) => {
  const a = geoAddresses.value.find((a) => String(a.id) === id);
  if (a) { endLat.value = a.lat!.toFixed(6); endLng.value = a.lng!.toFixed(6); }
});

watch(geoAddresses, (addrs) => {
  if (!startAddressId.value && addrs.length > 0) startAddressId.value = String(addrs[0].id);
  if (!endAddressId.value && addrs.length > 1) endAddressId.value = String(addrs[1].id);
}, { immediate: true });

async function searchRoute() {
  routeSearching.value = true;
  routeError.value = null;
  routeResult.value = null;
  try {
    const result = await store.searchRoute({
      mode: routeMode.value,
      start_lat: parseFloat(startLat.value),
      start_lng: parseFloat(startLng.value),
      end_lat: parseFloat(endLat.value),
      end_lng: parseFloat(endLng.value),
    });
    routeResult.value = result;
    if (routeMap && result.geometry) {
      if (routeLayer) { routeMap.removeLayer(routeLayer); routeLayer = null; }
      routeLayer = L.geoJSON(result.geometry as any, {
        style: { color: "#3b82f6", weight: 5, opacity: 0.9 },
      }).addTo(routeMap);
      const bounds = routeLayer.getBounds();
      if (bounds.isValid()) routeMap.fitBounds(bounds, { padding: [36, 36] });
    }
  } catch (e: any) {
    routeError.value = e.message ?? "Route search failed";
  } finally {
    routeSearching.value = false;
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────
onMounted(async () => {
  store.fetchZones();
  store.fetchAddresses();
  await store.fetchMapData();
  await nextTick();
  initMainMap();
});

onBeforeUnmount(() => {
  if (map) { map.remove(); map = null; }
  if (routeMap) { routeMap.remove(); routeMap = null; }
});

watch(() => mapLocations.value.length, () => {
  if (map) renderLocations();
});

watch(tab, async (newTab) => {
  await nextTick();
  if (newTab === "map" && map) map.invalidateSize();
  if (newTab === "route") {
    if (!routeMap) initRouteMap();
    else routeMap.invalidateSize();
  }
});

watch(sidebarOpen, async () => {
  await nextTick();
  if (map) map.invalidateSize();
});

watch(() => props.darkMode, (dark) => {
  if (map) {
    if (activeTileMain) { map.removeLayer(activeTileMain); }
    activeTileMain = makeTiles(dark).addTo(map);
  }
  if (routeMap) {
    if (activeTileRoute) { routeMap.removeLayer(activeTileRoute); }
    activeTileRoute = makeTiles(dark).addTo(routeMap);
  }
});

function tabCls(t: Tab) {
  const active = tab.value === t;
  const base = "rounded-lg px-4 py-2 text-sm font-semibold border transition";
  if (active) {
    return `${base} ${props.darkMode ? "bg-accent-dark text-primary-bg-dark border-transparent" : "bg-accent-light text-primary-bg-light border-transparent"}`;
  }
  return `${base} border-current/20 opacity-60 hover:opacity-100`;
}

function innerPanelStyle() {
  return props.darkMode
    ? { background: "#1a1f2e", color: "#fff", borderColor: "#2a3050" }
    : { background: "#f9fafb", color: "#111827", borderColor: "#e5e7eb" };
}

function cardCls() {
  return `rounded-xl border p-4 shadow-sm ${props.darkMode ? "bg-bubble-bg-dark border-accent-1" : "bg-bubble-bg-light border-accent-2"}`;
}

function panelCls() {
  return `rounded-xl border shadow-sm ${props.darkMode ? "bg-bubble-bg-dark border-accent-1" : "bg-bubble-bg-light border-accent-2"}`;
}

</script>

<template>
  <div
    class="flex w-full flex-col gap-4"
    :style="{
      '--fm-bg':     darkMode ? '#1a1f2e' : '#ffffff',
      '--fm-color':  darkMode ? '#ffffff' : '#111827',
      '--fm-border': darkMode ? '#2a3050' : '#d1d5db',
      '--fm-ph':     darkMode ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)',
    }"
  >

    <!-- Tab bar -->
    <div class="flex flex-wrap gap-1">
      <button :class="tabCls('map')" @click="tab = 'map'">
        <font-awesome-icon icon="map" class="mr-1.5" />Map
      </button>
      <button :class="tabCls('zones')" @click="tab = 'zones'">
        <font-awesome-icon icon="layer-group" class="mr-1.5" />Zones
      </button>
      <button :class="tabCls('addresses')" @click="tab = 'addresses'">
        <font-awesome-icon icon="location-dot" class="mr-1.5" />Addresses
      </button>
      <button :class="tabCls('route')" @click="tab = 'route'">
        <font-awesome-icon icon="route" class="mr-1.5" />Route Search
      </button>
    </div>

    <!-- ── MAP TAB ── -->
    <!-- Explicit height on all sizes so absolute inset-y-0 resolves correctly -->
    <div v-show="tab === 'map'" class="relative flex lg:flex-row h-[70vh] lg:h-[76vh] gap-3">

      <!-- Mobile backdrop — absolute, covers only the map area (not the header) -->
      <Transition name="loc-fade">
        <div
          v-if="sidebarOpen"
          class="lg:hidden absolute inset-0 z-[40] bg-black/50 rounded-xl"
          @click="sidebarOpen = false"
        ></div>
      </Transition>

      <!-- ── Sidebar: absolute slide-in on mobile, static column on desktop ── -->
      <div
        :class="[
          panelCls(),
          'flex flex-col overflow-hidden w-72',
          // Mobile: absolute within the tab container, slides in/out from left
          'absolute inset-y-0 left-0 z-[50] transition-transform duration-300 ease-in-out rounded-xl',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop: back to normal flow
          'lg:static lg:inset-auto lg:z-auto lg:shrink-0 lg:translate-x-0 lg:transition-none',
        ]"
      >
        <!-- Sidebar header -->
        <div class="px-4 pt-4 pb-3 border-b border-current/10">
          <div class="flex items-center justify-between mb-1">
            <div>
              <p class="text-xs font-bold uppercase tracking-wide opacity-50">Location index</p>
              <p class="text-xs opacity-50 mt-0.5">{{ mapLocations.length }} total · {{ mappedCount }} mapped</p>
            </div>
            <!-- Close button mobile only -->
            <button @click="sidebarOpen = false" class="lg:hidden p-1.5 opacity-50 hover:opacity-100 transition">
              <font-awesome-icon icon="xmark" />
            </button>
          </div>
          <div class="relative mt-3">
            <font-awesome-icon icon="magnifying-glass" class="absolute left-3 top-1/2 -translate-y-1/2 text-xs opacity-40 pointer-events-none" />
            <input v-model="sidebarSearch" type="text" placeholder="Search by name or type" class="rounded-lg border px-3 py-2 text-sm outline-none w-full pl-8" />
          </div>
        </div>

        <!-- Type filter chips -->
        <div class="px-3 pt-3 pb-2 border-b border-current/10">
          <div class="flex flex-wrap gap-1">
            <button
              v-for="type in availableTypes" :key="type" @click="activeType = type"
              :class="['rounded-full px-2.5 py-0.5 text-xs font-semibold border transition', activeType === type ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent') : 'border-current/20 opacity-60 hover:opacity-100']"
            >{{ type }}</button>
          </div>
          <div class="flex gap-2 mt-2">
            <button @click="fitAll" :class="panelCls()" class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-semibold border rounded-lg hover:opacity-80 transition">
              <font-awesome-icon icon="compress" />Fit all
            </button>
            <button @click="resetView" :class="panelCls()" class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-semibold border rounded-lg hover:opacity-80 transition">
              <font-awesome-icon icon="rotate-left" />Reset
            </button>
          </div>
        </div>

        <!-- Visibility -->
        <div class="px-3 py-2 border-b border-current/10">
          <div class="flex items-center justify-between mb-1.5">
            <p class="text-xs font-semibold opacity-60">Visible on map</p>
            <div class="flex gap-1">
              <button @click="showAllTypes" class="text-[10px] opacity-50 hover:opacity-100 transition px-1"><font-awesome-icon icon="eye" /></button>
              <button @click="hideAllTypes" class="text-[10px] opacity-50 hover:opacity-100 transition px-1"><font-awesome-icon icon="eye-slash" /></button>
            </div>
          </div>
          <div class="flex flex-wrap gap-x-3 gap-y-1">
            <button v-for="(visible, type) in visibleTypes" :key="type" @click="toggleType(type)" class="flex items-center gap-1 text-xs opacity-70 hover:opacity-100 transition">
              <span class="h-2 w-2 rounded-full shrink-0" :style="{ background: locColor(type), opacity: visible ? 1 : 0.25 }"></span>
              <span :style="{ opacity: visible ? 1 : 0.4 }">{{ type }}</span>
            </button>
          </div>
        </div>

        <!-- Layers -->
        <div v-if="mapLayers.length" class="px-3 py-2 border-b border-current/10">
          <p class="text-xs font-semibold opacity-60 mb-1.5"><font-awesome-icon icon="layer-group" class="mr-1" />Layers</p>
          <select v-model="selectedLayerSlug" class="rounded-lg border px-3 py-1.5 text-xs outline-none w-full">
            <option value="">— None —</option>
            <option v-for="layer in mapLayers" :key="layer.slug" :value="layer.slug">{{ layer.name }}</option>
          </select>
          <div v-if="selectedLayer" class="mt-2">
            <label class="flex items-center justify-between text-xs opacity-60 mb-1"><span>Opacity</span><span>{{ Math.round(overlayOpacity * 100) }}%</span></label>
            <input type="range" min="0.05" max="0.85" step="0.05" v-model.number="overlayOpacity" class="w-full accent-current" />
          </div>
        </div>

        <!-- Location list -->
        <div class="flex-1 overflow-y-auto min-h-0">
          <div v-if="mapLoading" class="flex items-center justify-center py-8 opacity-40"><font-awesome-icon icon="spinner" spin class="text-xl" /></div>
          <div v-else-if="mapError" class="p-3 text-xs text-red-400">{{ mapError }}</div>
          <div v-else-if="visibleLocations.length === 0" class="flex flex-col items-center justify-center py-8 opacity-40 gap-2">
            <font-awesome-icon icon="map" class="text-2xl" /><p class="text-xs">No locations found</p>
          </div>
          <div v-else>
            <button
              v-for="loc in visibleLocations" :key="`${loc.type}-${loc.name}`"
              @click="selectLocation(loc); sidebarOpen = false"
              class="w-full flex items-start gap-3 px-4 py-2.5 text-left text-xs hover:bg-current/5 transition border-b border-current/5"
              :class="{ 'bg-current/10': selectedName === loc.name }"
            >
              <span class="h-2 w-2 rounded-full shrink-0 mt-1" :style="{ background: locColor(loc.type) }"></span>
              <span class="min-w-0 flex-1">
                <span class="block font-semibold truncate leading-tight">{{ loc.name }}</span>
                <span class="block opacity-50 truncate">{{ loc.type }}</span>
              </span>
              <span v-if="!loc.geometry" class="shrink-0 opacity-30 text-[9px] mt-0.5">no geom</span>
            </button>
          </div>
        </div>
      </div><!-- /sidebar -->

      <!-- ── Map: flex-1, z-[1] creates stacking context so internal z-indices (1001)
           don't bleed out above the sidebar (z-[50]) in the parent context ── -->
      <div :class="panelCls()" class="relative overflow-hidden flex-1 z-[1]">
        <div ref="mapEl" class="absolute inset-0" :class="{ 'dark-map': darkMode }"></div>

        <!-- Floating "Locations" button — mobile only, opens side panel -->
        <div class="pointer-events-auto absolute bottom-3 left-3 z-[1001] lg:hidden">
          <button
            @click="sidebarOpen = true"
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold shadow-lg transition hover:opacity-90"
          >
            <font-awesome-icon icon="layer-group" />Locations
          </button>
        </div>

        <!-- Status badge (desktop) -->
        <div class="pointer-events-none absolute left-3 top-3 z-[1001] hidden lg:block">
          <div :class="darkMode ? 'bg-[#1a1f2e]/95 text-white border-white/10' : 'bg-white/95 text-gray-900 border-gray-200'" class="rounded-lg border px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur">
            <span class="opacity-50">{{ selectedName ? (featuresDict[selectedName]?.type ?? "Place") : "Overview" }}</span>
            <span class="opacity-30 mx-1">/</span>
            <span>{{ selectedName || "All mapped locations" }}</span>
          </div>
        </div>

        <!-- Map search -->
        <div class="pointer-events-auto absolute right-3 top-3 z-[1001]" style="width: min(280px, calc(100% - 1.5rem))">
          <div :class="darkMode ? 'border-[#2a3050] bg-[#1a1f2e]/95 text-white' : 'border-gray-200 bg-white/95 text-gray-900'" class="rounded-lg border p-2 shadow-sm backdrop-blur">
            <label class="relative block">
              <font-awesome-icon icon="magnifying-glass" class="absolute left-3 top-1/2 -translate-y-1/2 text-xs opacity-40 pointer-events-none" />
              <input v-model="mapSearch" type="search" placeholder="Move map to …" autocomplete="off" @keydown.enter.prevent="mapSearchResults.length && goToResult(mapSearchResults[0])" class="w-full rounded-lg border py-1.5 pl-8 pr-3 text-xs font-semibold outline-none" />
            </label>
            <div v-show="mapSearch.trim().length > 0" class="mt-2 max-h-48 overflow-y-auto space-y-1">
              <div v-if="mapSearchLoading" class="px-3 py-1.5 text-xs opacity-60">Searching…</div>
              <template v-else>
                <div v-if="mapSearchResults.length === 0" class="px-3 py-1.5 text-xs opacity-60">No results found.</div>
                <button v-for="r in mapSearchResults" :key="`${r.source}-${r.label}-${r.lat}`" @click="goToResult(r)" :class="darkMode ? 'hover:bg-white/10' : 'hover:bg-black/5'" class="w-full rounded-lg px-3 py-1.5 text-left text-xs transition">
                  <span class="flex items-start justify-between gap-2">
                    <span class="font-bold">{{ r.label }}</span>
                    <span class="shrink-0 rounded-full border border-current/15 px-1.5 py-0.5 text-[10px] opacity-60">{{ r.source }}</span>
                  </span>
                  <span class="opacity-55">{{ r.type }}<template v-if="r.detail"> · {{ r.detail }}</template></span>
                </button>
              </template>
            </div>
          </div>
        </div>

        <!-- Legend (desktop only) -->
        <div :class="darkMode ? 'bg-[#1a1f2e]/90 text-white border-white/10' : 'bg-white/90 text-gray-900 border-gray-200'" class="pointer-events-none absolute bottom-10 right-3 z-[1001] hidden lg:block rounded-lg border px-3 py-2.5 text-[11px] shadow-sm backdrop-blur">
          <p class="font-bold mb-1.5 opacity-70">Legend</p>
          <div class="space-y-1">
            <div v-for="(color, type) in TYPE_COLORS" :key="type" class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full shrink-0" :style="{ background: color }"></span>
              <span class="opacity-70">{{ type }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── ZONES TAB ──────────────────────────────────────────────────────── -->
    <template v-if="tab === 'zones'">
      <div v-if="loading" class="flex items-center justify-center py-16 opacity-50">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>
      <div v-else-if="zones.length === 0" class="flex flex-col items-center justify-center py-16 opacity-40 gap-3">
        <font-awesome-icon icon="layer-group" class="text-4xl" />
        <p class="text-sm">No zones found</p>
      </div>
      <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="zone in zones" :key="zone.id" :class="cardCls()">
          <div class="flex items-start gap-2">
            <span class="h-2 w-2 rounded-full shrink-0 mt-1" :style="{ background: TYPE_COLORS['Zone'] }"></span>
            <div>
              <p class="font-semibold text-sm">{{ zone.name }}</p>
              <p v-if="zone.territory_name" class="text-xs opacity-50 mt-0.5">{{ zone.territory_name }}</p>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ── ADDRESSES TAB ──────────────────────────────────────────────────── -->
    <template v-if="tab === 'addresses'">
      <div v-if="error" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ error }}</div>

      <!-- Add form -->
      <div :class="cardCls()">
        <h3 class="mb-3 text-sm font-bold opacity-70">Add Address</h3>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input v-model="newStreet" type="text" placeholder="Street" class="rounded-lg border px-3 py-2 text-sm outline-none col-span-2" />
          <input v-model="newBuilding" type="text" placeholder="Building #" class="rounded-lg border px-3 py-2 text-sm outline-none" />
          <input v-model="newLocality" type="text" placeholder="City" class="rounded-lg border px-3 py-2 text-sm outline-none" />
          <input v-model="newCountry" type="text" placeholder="CC (e.g. PL)" maxlength="2" class="rounded-lg border px-3 py-2 text-sm outline-none uppercase" />
          <button
            @click="createAddress"
            :disabled="creating"
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="col-span-2 sm:col-span-1 rounded-lg px-4 py-2 text-sm font-bold transition hover:opacity-90 disabled:opacity-50"
          >{{ creating ? "Adding…" : "Add" }}</button>
        </div>
        <p v-if="createError" class="mt-2 text-xs text-red-400">{{ createError }}</p>
      </div>

      <!-- Address list -->
      <div v-if="addresses.length === 0" class="flex flex-col items-center justify-center py-10 opacity-40 gap-3">
        <font-awesome-icon icon="location-dot" class="text-4xl" />
        <p class="text-sm">No addresses yet</p>
      </div>
      <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="addr in addresses" :key="addr.id" :class="cardCls()">
          <div class="flex items-start gap-2">
            <span class="h-2 w-2 rounded-full shrink-0 mt-1" :style="{ background: TYPE_COLORS['Address'] }"></span>
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

    <!-- ── ROUTE SEARCH TAB ───────────────────────────────────────────────── -->
    <!-- Mobile: flex-col (form on top, map below). Desktop: flex-row side-by-side -->
    <div v-show="tab === 'route'" class="flex flex-col lg:flex-row gap-3">

      <!-- Form panel -->
      <div :class="panelCls()" class="lg:w-72 lg:shrink-0 flex flex-col lg:h-[76vh]">

        <!-- Collapsible header (mobile tap-to-toggle) -->
        <button
          @click="routeFormOpen = !routeFormOpen"
          class="flex items-center justify-between w-full p-4 border-b border-current/10 lg:cursor-default"
        >
          <div class="text-left">
            <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-bold uppercase tracking-wide">Traversable path</p>
            <h2 class="mt-0.5 text-lg font-bold flex items-center gap-2">
              <font-awesome-icon icon="route" />Route Search
            </h2>
          </div>
          <!-- Chevron — only visible on mobile -->
          <font-awesome-icon
            :icon="routeFormOpen ? 'chevron-up' : 'chevron-down'"
            class="lg:hidden opacity-50 text-sm"
          />
        </button>

        <!-- Collapsible body -->
        <div v-show="routeFormOpen" class="flex-1 overflow-y-auto p-4 space-y-5">
          <p class="text-xs opacity-60">Search a real route between two saved addresses or manual WGS84 points.</p>

          <!-- Mode -->
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wide opacity-60 mb-2">Mode</label>
            <select v-model="routeMode" class="rounded-lg border px-3 py-2 text-sm outline-none w-full">
              <option v-for="m in routeModeOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <div class="mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" :style="innerPanelStyle()">
              <font-awesome-icon :icon="routeModeOptions.find(m => m.value === routeMode)?.icon ?? 'route'" class="opacity-60" />
              <span class="opacity-60 text-xs">Selected mode</span>
              <span class="font-semibold ml-auto text-xs capitalize">{{ routeMode }}</span>
            </div>
          </div>

          <!-- Start point -->
          <div>
            <p class="text-xs font-bold mb-2">Start point</p>
            <label class="block text-xs opacity-60 mb-1">Saved address</label>
            <select v-model="startAddressId" class="rounded-lg border px-3 py-2 text-sm outline-none w-full mb-2">
              <option value="">— Manual coordinates —</option>
              <option v-for="a in geoAddresses" :key="a.id" :value="String(a.id)">{{ a.display }}</option>
            </select>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-xs opacity-60 mb-1">Latitude</label>
                <input v-model="startLat" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none w-full font-mono" />
              </div>
              <div>
                <label class="block text-xs opacity-60 mb-1">Longitude</label>
                <input v-model="startLng" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none w-full font-mono" />
              </div>
            </div>
          </div>

          <!-- End point -->
          <div>
            <p class="text-xs font-bold mb-2">End point</p>
            <label class="block text-xs opacity-60 mb-1">Saved address</label>
            <select v-model="endAddressId" class="rounded-lg border px-3 py-2 text-sm outline-none w-full mb-2">
              <option value="">— Manual coordinates —</option>
              <option v-for="a in geoAddresses" :key="a.id" :value="String(a.id)">{{ a.display }}</option>
            </select>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-xs opacity-60 mb-1">Latitude</label>
                <input v-model="endLat" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none w-full font-mono" />
              </div>
              <div>
                <label class="block text-xs opacity-60 mb-1">Longitude</label>
                <input v-model="endLng" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none w-full font-mono" />
              </div>
            </div>
          </div>

          <!-- Search button -->
          <button
            @click="searchRoute"
            :disabled="routeSearching"
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition hover:opacity-90 disabled:opacity-50"
          >
            <font-awesome-icon :icon="routeSearching ? 'spinner' : 'magnifying-glass'" :spin="routeSearching" />
            {{ routeSearching ? "Searching…" : "Search route" }}
          </button>

          <div v-if="routeError" class="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs text-red-400">{{ routeError }}</div>

          <div v-if="routeResult" class="rounded-xl border p-4 space-y-3" :style="innerPanelStyle()">
            <p class="text-xs font-bold uppercase tracking-wide opacity-60">Route result</p>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <p class="text-xs opacity-50">Distance</p>
                <p class="font-bold text-lg">{{ routeResult.properties.distance_km }} <span class="text-sm font-normal opacity-60">km</span></p>
              </div>
              <div>
                <p class="text-xs opacity-50">Duration</p>
                <p class="font-bold text-lg">{{ routeResult.properties.duration_min }} <span class="text-sm font-normal opacity-60">min</span></p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Route map — full height desktop, fixed height mobile -->
      <div :class="panelCls()" class="relative overflow-hidden flex-1 h-[50vh] lg:h-[76vh]">
        <div ref="routeMapEl" class="absolute inset-0" :class="{ 'dark-map': darkMode }"></div>
        <div v-if="!routeResult && !routeSearching" class="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div class="text-center opacity-30">
            <font-awesome-icon icon="route" class="text-4xl mb-3" />
            <p class="text-sm">Set start and end points, then search</p>
          </div>
        </div>
      </div>
    </div>

    <!-- logistics + incidents tabs removed (backed by limbo apps) -->



  </div>
</template>

<style scoped>
/* Mobile backdrop fade */
.loc-fade-enter-active, .loc-fade-leave-active { transition: opacity 0.25s ease; }
.loc-fade-enter-from, .loc-fade-leave-to { opacity: 0; }

/* Keep our overlays above Leaflet's internal panes (max z-index ~1000) */
.map-wrap :deep(.leaflet-control-container) { z-index: 900 !important; }

/* Force form element colours via CSS variables — overrides GTK/OS native theming */
select,
textarea,
input[type="text"],
input[type="search"],
input[type="number"] {
  background-color: var(--fm-bg) !important;
  color: var(--fm-color) !important;
  border-color: var(--fm-border) !important;
  -webkit-appearance: none;
  appearance: none;
}

select::placeholder,
input::placeholder {
  color: var(--fm-ph) !important;
}

/* Re-add a minimal dropdown arrow for selects */
select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px !important;
}

/* Option elements inside select */
select option {
  background-color: var(--fm-bg);
  color: var(--fm-color);
}
</style>

<style>
/* Dark-mode Leaflet popup — applied when map container has .dark-map class */
.dark-map .leaflet-popup-content-wrapper {
  background: #1a1f2e !important;
  color: #ffffff !important;
  border: 1px solid #2a3050 !important;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55) !important;
  border-radius: 10px !important;
}

.dark-map .leaflet-popup-tip {
  background: #1a1f2e !important;
}

.dark-map .leaflet-popup-content {
  color: #ffffff !important;
}

.dark-map .leaflet-popup-content a {
  color: #7d9ff5 !important;
}

.dark-map .leaflet-popup-close-button {
  color: rgba(255, 255, 255, 0.5) !important;
}

.dark-map .leaflet-popup-close-button:hover {
  color: #ffffff !important;
}
</style>
