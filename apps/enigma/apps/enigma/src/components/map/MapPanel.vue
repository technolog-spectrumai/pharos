<script setup lang="ts">
// The MapLibre canvas: offline-first tiles through the `enigma-map://` custom
// protocol (one Rust command resolves local regions, then the gated remote
// source), private pins + hand-drawn routes (sealed kv), and "Share to room"
// actions over the MLS seam. Style assets (glyphs/sprites) are bundled under
// public/map/ — the map itself never fetches from a CDN.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import layersFn from "protomaps-themes-base";
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

const props = defineProps<{ darkMode?: boolean }>();

const store = useMapStore();
const chatStore = useChatStore();

const container = ref<HTMLDivElement | null>(null);
/** True once unmount begins — boot must not touch the DOM past this point. */
let disposed = false;
const ready = ref(false);
const webglOk = ref(true);
const tauri = isTauri();
/** First few distinct map failures (style/tile/GL) — rendered as an inline
 *  overlay so a blank canvas is never silent. Console gets the full objects. */
const mapErrors = ref<string[]>([]);
/** Echo a lifecycle line to console AND the app's stderr (see maps.rs
 *  map_debug_log) so a dark canvas can be diagnosed from the run_dev.sh
 *  terminal alone. Fire-and-forget: tracing must never break the boot. */
function trace(msg: string) {
  console.info(`[map] ${msg}`);
  if (tauri) void invoke("map_debug_log", { message: msg }).catch(() => {});
}

function pushDiag(msg: string) {
  trace(`DIAG: ${msg}`);
  if (!mapErrors.value.includes(msg) && mapErrors.value.length < 6) {
    mapErrors.value = [...mapErrors.value, msg];
  }
}

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
/** Source maxzoom resolved at boot — kept so a theme switch can rebuild the
 *  style without re-querying the backend. */
let sourceMaxZoom: number = policy.map.fallbackSourceMaxZoom;

/** The protomaps flavor matching the app theme: a night basemap in dark mode.
 *  (The reference implementation in toto/locations swaps to CARTO dark raster
 *  tiles; Enigma renders vector tiles offline, so it swaps the theme flavor
 *  instead — same result, no tile server involved.) */
const flavor = computed(() => (props.darkMode ? "dark" : "light"));

/** Style for a flavor. Assets are bundled per flavor under public/map/. */
function buildStyle(themeFlavor: string, maxZoom: number): maplibregl.StyleSpecification {
  // Offline style assets under public/map/, resolved against the app origin
  // (tauri://localhost in the bundle, the Vite port in dev). No trailing slash.
  const assetBase = new URL("/map", location.href).toString().replace(/\/$/, "");
  return {
    version: 8,
    // NOTE: build these by concatenation, NOT `new URL(...)` — the URL
    // constructor percent-encodes the braces ("%7Bfontstack%7D") and MapLibre
    // then rejects the style for missing its {fontstack}/{range} tokens,
    // which aborts the whole style load (blank canvas).
    glyphs: `${assetBase}/glyphs/{fontstack}/{range}.pbf`,
    sprite: `${assetBase}/sprites/v4/${themeFlavor}`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: ["enigma-map://tile/{z}/{x}/{y}"],
        maxzoom: maxZoom,
        attribution: "© OpenStreetMap contributors, Protomaps",
      },
    },
    // `layers()` ALREADY includes the label layers — spreading `labels()` on
    // top duplicates every id, which fails style validation outright.
    layers: layersFn("protomaps", themeFlavor, "en"),
  } as maplibregl.StyleSpecification;
}

/** Route overlays live outside the theme style, so they must be re-added
 *  whenever the style is replaced (setStyle drops user sources/layers).
 *  Pin markers are DOM overlays and survive untouched. */
function addOverlayLayers() {
  if (!map || map.getSource("user-routes")) return;
  map.addSource("user-routes", { type: "geojson", data: routesGeoJson() });
  map.addLayer({
    id: "user-routes-line",
    type: "line",
    source: "user-routes",
    paint: { "line-color": "#dc2626", "line-width": 3, "line-opacity": 0.85 },
  });
  map.addSource("draft-route", { type: "geojson", data: draftGeoJson(draftPoints.value) });
  map.addLayer({
    id: "draft-route-line",
    type: "line",
    source: "draft-route",
    paint: { "line-color": "#f59e0b", "line-width": 3, "line-dasharray": [2, 1] },
  });
}
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
    } catch (e) {
      // An empty tile, never a crash loop — but do NOT stay silent about it:
      // if map_get_tile rejects for every tile (locked vault, unreadable blob)
      // the map is blank with nothing else reporting why. pushDiag dedupes, so
      // a repeated failure surfaces once. Safe to capture: this closure is
      // re-registered per mount (`protocolRegistered` is per-instance).
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[map] tile request failed:", e);
      pushDiag(`tile request failed: ${msg}`);
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
  if (!tauri) return;               // honest desktop-only state renders instead
  trace("boot: mounted (tauri)");
  webglOk.value = webglAvailable();
  trace(`boot: webgl=${webglOk.value}`);
  if (!webglOk.value) return;       // honest no-WebGL state renders instead
  if (!container.value) {
    pushDiag("map container was not available at mount");
    return;
  }

  // Arm the watchdog BEFORE the first await. Everything below can fail in a way
  // that leaves the canvas permanently dark — a rejected store load, a mid-boot
  // unmount, a constructor throw — and without this the failure is reported
  // nowhere at all (the exact "no overlay, still dark" symptom).
  window.setTimeout(() => {
    if (!disposed && !ready.value && mapErrors.value.length === 0) {
      pushDiag("map did not finish loading within 8s (and reported no error)");
    }
  }, 8000);

  try {
    registerProtocol();

    // Region/pin data is BEST-EFFORT: the basemap must still render when the
    // sealed store is unavailable (e.g. the vault is not unlocked yet). This
    // await used to be unguarded, so one rejected kv read killed the whole boot.
    trace("boot: protocol registered, loading regions…");
    try {
      await store.reload();
      trace(`boot: regions=${store.regions.length} active=${store.activeRegion?.name ?? "none"}`);
    } catch (e) {
      console.error("[map] region/pin load failed:", e);
      pushDiag(`data load failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const info = await invoke<{ maxZoom: number } | null>("map_source_info");
      if (info) sourceMaxZoom = info.maxZoom;
    } catch { /* no source yet — more regions may be imported later */ }

    // A sub-tab flip (or a late :key change) can unmount us mid-boot; the
    // replacement instance performs the real init, so bail quietly.
    if (disposed) {
      trace("boot: aborted — component unmounted mid-startup (a remount will retry)");
      return;
    }
    if (!container.value) {
      pushDiag("map container disappeared during startup");
      return;
    }

    trace(`boot: constructing MapLibre (maxZoom=${sourceMaxZoom}, theme=${flavor.value})`);
    map = new maplibregl.Map({
      container: container.value,
      attributionControl: { compact: true },
      center: policy.map.defaultCenter,
      zoom: policy.map.defaultZoom,
      maxZoom: 20,
      style: buildStyle(flavor.value, sourceMaxZoom),
    });

    trace("boot: MapLibre constructed, awaiting style load…");
    // A blank canvas must never be silent: surface style/tile/GL failures both
    // to the console (full objects) and to the inline diagnostics overlay.
    map.on("error", (e) => {
      const raw = (e as { error?: unknown }).error;
      console.error("[map] error:", raw ?? e);
      pushDiag(raw instanceof Error ? raw.message : String(raw ?? "unknown map error"));
    });

    map.on("load", () => {
      if (!map) return;
      addOverlayLayers();
      refreshPins();
      ready.value = true;

      // GL ground truth for bug reports: which device actually renders, is the
      // canvas non-degenerate, and does a readback show painted pixels? (The
      // WebKitGTK compositing failure mode is a valid context that never
      // reaches the screen — pixels present here but a dark window.)
      const canvas = map.getCanvas();
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      const renderer = gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
      trace(`loaded; canvas ${canvas.width}x${canvas.height}; GL: ${renderer}`);
      if (!canvas.width || !canvas.height) {
        pushDiag(`canvas has zero size (${canvas.width}x${canvas.height})`);
      }

      const active = store.activeRegion;
      if (active) {
        // Region bboxes are [west, south, east, north] — maplibre lng/lat order.
        map.fitBounds(
          [[active.bbox[0], active.bbox[1]], [active.bbox[2], active.bbox[3]]],
          { padding: 60, maxZoom: 15, animate: false },
        );
      }
      applyPendingFocus();
    });

    map.on("click", onMapClick);
  } catch (e) {
    console.error("[map] startup failed:", e);
    pushDiag(`startup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  for (const marker of pinMarkers.values()) marker.remove();
  pinMarkers.clear();
  focusMarker?.remove();
  map?.remove();
  map = null;
});

// Follow the app theme live: setStyle keeps the camera and the DOM markers,
// but drops user sources/layers — so the route overlays are re-added once the
// new style is in place.
watch(flavor, (next) => {
  if (!map || !ready.value) return;
  trace(`theme: switching basemap to ${next}`);
  map.setStyle(buildStyle(next, sourceMaxZoom));
  map.once("styledata", () => {
    addOverlayLayers();
    refreshRoutes();
    refreshDraft();
  });
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
        <!-- `map-canvas-host` is load-bearing, not cosmetic: see style.css —
             MapLibre's unlayered `.maplibregl-map { position: relative }` beats
             Tailwind v4's layered `.absolute`, so the box needs an unlayered
             rule of its own to keep filling the wrapper. -->
        <div
          ref="container"
          class="map-canvas-host absolute inset-0 h-full w-full"
          data-testid="map-canvas"
        />

        <!-- Active-region chip (D9) — read-only; deactivation lives in Regions. -->
        <div
          v-if="store.activeRegion"
          class="absolute right-3 top-3 z-10 max-w-[50%] truncate rounded-full bg-accent-light/85 px-3 py-1 text-xs font-semibold text-white dark:bg-accent-dark/85"
          :title="$t('map.activeBadge')"
        >
          <font-awesome-icon icon="layer-group" /> {{ store.activeRegion.name }}
        </div>

        <!-- Inline diagnostics: a blank map explains itself. -->
        <div
          v-if="mapErrors.length"
          class="absolute bottom-3 left-3 right-3 z-20 rounded-lg bg-primary-bg-light/95 p-2 text-xs shadow dark:bg-primary-bg-dark/95"
        >
          <p class="font-bold">{{ $t('map.diagTitle') }}</p>
          <p v-for="err in mapErrors" :key="err" class="truncate text-warn-dark" :title="err">{{ err }}</p>
        </div>

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
