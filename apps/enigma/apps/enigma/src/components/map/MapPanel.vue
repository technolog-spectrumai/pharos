<script setup lang="ts">
// The MapLibre canvas: offline-first tiles through the `enigma-map://` custom
// protocol (one Rust command resolves local regions, then the gated remote
// source), private pins + hand-drawn routes (sealed kv), and "Share to room"
// actions over the MLS seam. Style assets (glyphs/sprites) are bundled under
// public/map/ — the map itself never fetches from a CDN.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import layersFn from "protomaps-themes-base";
import {
  isTauri,
  invoke,
  buildLocationShare,
  buildPinShare,
  buildRouteShare,
  MAP_LOC_TTL_MS,
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
import PinEditModal from "./PinEditModal.vue";
import SharedSharesCard from "./SharedSharesCard.vue";
import { sharedItemName, type SharedItem } from "./sharedLayerModel";
import { useSharedMapLayer } from "./useSharedMapLayer";

const props = defineProps<{ darkMode?: boolean }>();

const { t } = useI18n({ useScope: "global" });
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
type Mode = "idle" | "add-pin" | "draw-route" | "share-loc";
const mode = ref<Mode>("idle");
const draftPoints = ref<[number, number][]>([]); // [lat, lng]
const nameModal = ref<null | { kind: "route" }>(null);
const nameInput = ref("");

// The pin editor: creating (a tapped point) or editing (an existing pin).
const pinModal = ref<null | { lat: number; lng: number; pin: MapPin | null }>(null);

// Sharing a location: the user taps a spot, confirms, and only then does
// anything leave the device. Nothing is ever stored locally by this flow.
const locModal = ref<null | { lat: number; lng: number }>(null);
const locLabel = ref("");
const locNote = ref("");
const locBusy = ref(false);
/** Shows the tapped point while the modal is open, so the tap visibly landed. */
let pendingLocMarker: maplibregl.Marker | null = null;

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
  // Shared routes sit between own routes and the in-progress draft, so the
  // draft always stays on top.
  map.addSource("shared-routes", { type: "geojson", data: sharedRoutesGeoJson() });
  map.addLayer({
    id: "shared-routes-line",
    type: "line",
    source: "shared-routes",
    paint: {
      "line-color": ["coalesce", ["get", "color"], SHARED_COLOR],
      "line-width": 3,
      "line-opacity": 0.9,
      "line-dasharray": [2, 2],
    },
  });
  map.addSource("draft-route", { type: "geojson", data: draftGeoJson(draftPoints.value) });
  map.addLayer({
    id: "draft-route-line",
    type: "line",
    source: "draft-route",
    paint: { "line-color": "#f59e0b", "line-width": 3, "line-dasharray": [2, 1] },
  });
}
/** Own pins. The signature guards against the repaint bug: a marker's colour
 *  is baked in at construction, so an edited colour needs a NEW marker. */
const pinMarkers = new Map<string, { marker: maplibregl.Marker; sig: string }>();
/** What room members shared, keyed by message id (stable across reloads). */
const sharedMarkers = new Map<string, { marker: maplibregl.Marker; sig: string }>();
let focusMarker: maplibregl.Marker | null = null;

// Shared items are drawn in their own colours so "mine" and "theirs" never
// blur together: own pin #2563eb, own route #dc2626, draft #f59e0b, focus
// preview #16a34a.
const SHARED_COLOR = "#7c3aed";
const SHARED_LOC_COLOR = "#ea580c";

const layer = useSharedMapLayer();
/** The shared item whose detail banner is open. */
const selectedShared = ref<SharedItem | null>(null);

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

function sharedRoutesGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: layer.onMap.value
      .filter((i) => i.kind === "route")
      .map((i) => {
        const share = i.share as { points: [number, number][]; color?: string };
        return {
          type: "Feature" as const,
          properties: { key: i.key, color: share.color ?? null },
          geometry: {
            type: "LineString" as const,
            coordinates: share.points.map(([lat, lng]) => [lng, lat]),
          },
        };
      }),
  };
}

function refreshPins() {
  if (!map) return;
  const seen = new Set<string>();
  for (const pin of store.pins) {
    seen.add(pin.id);
    const color = pin.color ?? "#2563eb";
    const sig = `${pin.lat}|${pin.lng}|${color}`;
    const existing = pinMarkers.get(pin.id);
    if (existing && existing.sig === sig) continue;
    // A colour lives in the marker's SVG, so a recolour means a new marker —
    // setLngLat alone would silently keep the old paint.
    existing?.marker.remove();
    const marker = new maplibregl.Marker({ color })
      .setLngLat([pin.lng, pin.lat])
      .addTo(map);
    pinMarkers.set(pin.id, { marker, sig });
  }
  for (const [id, entry] of pinMarkers) {
    if (!seen.has(id)) {
      entry.marker.remove();
      pinMarkers.delete(id);
    }
  }
}

/** A shared pin/location badge: the sender's initial in a ring, so ownership is
 *  readable at a glance without a label layer (which would need sprite work in
 *  both theme flavours). The click handler is attached BEFORE the element goes
 *  to MapLibre, so we never read it back off the marker. */
function sharedMarkerEl(item: SharedItem): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className =
    "flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[10px] " +
    "font-bold text-white shadow transition hover:scale-110";
  el.style.backgroundColor = item.kind === "loc" ? SHARED_LOC_COLOR : SHARED_COLOR;
  el.textContent = (item.self ? t("map.sharedYou") : item.sender).slice(0, 1).toUpperCase();
  el.title = `${item.self ? t("map.sharedYou") : item.sender} · ${sharedItemName(item, t("map.locCardDefault"))}`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedShared.value = item;
  });
  return el;
}

function refreshShared() {
  if (!map) return;
  const seen = new Set<string>();
  for (const item of layer.onMap.value) {
    if (item.kind === "route") continue; // drawn by the line layer
    const share = item.share as { lat: number; lng: number };
    seen.add(item.key);
    const sig = `${share.lat}|${share.lng}|${item.kind}|${item.sender}`;
    const existing = sharedMarkers.get(item.key);
    if (existing && existing.sig === sig) continue;
    existing?.marker.remove();
    const marker = new maplibregl.Marker({ element: sharedMarkerEl(item) })
      .setLngLat([share.lng, share.lat])
      .addTo(map);
    sharedMarkers.set(item.key, { marker, sig });
  }
  for (const [key, entry] of sharedMarkers) {
    if (!seen.has(key)) {
      entry.marker.remove();
      sharedMarkers.delete(key);
    }
  }
  refreshSharedRoutes();
  // A selected item that just expired or left coverage must not keep its banner.
  if (selectedShared.value && !layer.onMap.value.some((i) => i.key === selectedShared.value!.key)) {
    selectedShared.value = null;
  }
}

function refreshSharedRoutes() {
  const src = map?.getSource("shared-routes") as maplibregl.GeoJSONSource | undefined;
  src?.setData(sharedRoutesGeoJson());
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
      refreshShared();
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
  for (const entry of pinMarkers.values()) entry.marker.remove();
  pinMarkers.clear();
  for (const entry of sharedMarkers.values()) entry.marker.remove();
  sharedMarkers.clear();
  pendingLocMarker?.remove();
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
    refreshSharedRoutes();
  });
});

watch(() => layer.onMap.value, refreshShared, { deep: true });
watch(
  () => layer.roomSlug.value,
  () => {
    selectedShared.value = null;
  },
);
watch(() => store.pins, refreshPins, { deep: true });
watch(() => store.routes, refreshRoutes, { deep: true });
watch(draftPoints, refreshDraft, { deep: true });
watch(() => store.pendingFocus, applyPendingFocus);

// ── interactions ─────────────────────────────────────────────────────────────
function onMapClick(e: maplibregl.MapMouseEvent) {
  if (mode.value === "add-pin") {
    pinModal.value = { lat: e.lngLat.lat, lng: e.lngLat.lng, pin: null };
    mode.value = "idle";
  } else if (mode.value === "draw-route") {
    draftPoints.value = [...draftPoints.value, [e.lngLat.lat, e.lngLat.lng]];
  } else if (mode.value === "share-loc") {
    openLocModal(e.lngLat.lat, e.lngLat.lng);
  }
}

function openLocModal(lat: number, lng: number) {
  mode.value = "idle";
  locLabel.value = "";
  locNote.value = "";
  locModal.value = { lat, lng };
  pendingLocMarker?.remove();
  if (map) {
    pendingLocMarker = new maplibregl.Marker({ color: SHARED_LOC_COLOR })
      .setLngLat([lng, lat])
      .addTo(map);
  }
}

function closeLocModal() {
  locModal.value = null;
  pendingLocMarker?.remove();
  pendingLocMarker = null;
}

/** Push the tapped point to the room. This is the ONLY thing that shares a
 *  location, and it takes a deliberate press — the app never reads a device
 *  position and never sends anything on its own. */
async function shareLocation() {
  const at = locModal.value;
  if (!at || locBusy.value) return;
  locBusy.value = true;
  try {
    await chatStore.p2p.sendMapShare(
      buildLocationShare(at.lat, at.lng, { label: locLabel.value, note: locNote.value }),
    );
    chatStore.p2p.postSystemNotice(t("map.locSharedNotice"));
    closeLocModal();
  } finally {
    locBusy.value = false;
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
  const name = nameInput.value.trim();
  if (!nameModal.value || !name) return;
  await store.addRoute(name, draftPoints.value);
  draftPoints.value = [];
  mode.value = "idle";
  nameModal.value = null;
}

/** Create or update a pin from the editor. */
async function submitPin(fields: { name: string; note: string; color: string }) {
  const modal = pinModal.value;
  if (!modal) return;
  if (modal.pin) {
    // Pass "" through deliberately: upsertPin merges by id, so an emptied note
    // must overwrite the old one rather than be treated as "unchanged".
    await store.savePin({ ...modal.pin, name: fields.name, note: fields.note, color: fields.color });
  } else {
    await store.addPin(fields.name, modal.lat, modal.lng, fields.note, fields.color);
  }
  pinModal.value = null;
}

function editPin(pin: MapPin) {
  pinModal.value = { lat: pin.lat, lng: pin.lng, pin };
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
  // Already on the shared layer? Then it needs no preview marker and no Save
  // banner — select it and fly. `share` is the SAME object the layer holds
  // (both come from message.map), so identity is enough.
  const onLayer = layer.all.value.find((i) => i.share === share);
  if (onLayer && onLayer.covered && store.sharedLayerVisible) {
    selectedShared.value = onLayer;
    focusShared(onLayer);
    return;
  }
  focus.value = share;
  focusMarker?.remove();
  focusMarker = null;
  if (share.type === "map_pin" || share.type === "map_loc") {
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

const focusIcon = computed(() =>
  focus.value?.type === "map_route" ? "route"
  : focus.value?.type === "map_loc" ? "location-crosshairs"
  : "location-dot",
);

const focusName = computed(() => {
  const f = focus.value;
  if (!f) return "";
  return f.type === "map_loc" ? f.label || t("map.locCardDefault") : f.name;
});

/** Fly to a shared item (a point, or the bounds of a shared route). */
function focusShared(item: SharedItem) {
  if (!map) return;
  if (item.kind === "route") {
    const pts = (item.share as { points: [number, number][] }).points;
    const lats = pts.map((pt) => pt[0]);
    const lngs = pts.map((pt) => pt[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, maxZoom: 15 },
    );
    return;
  }
  const pt = item.share as { lat: number; lng: number };
  map.flyTo({ center: [pt.lng, pt.lat], zoom: Math.max(map.getZoom(), 13) });
}

/** Sidebar row → select it AND fly there (an out-of-coverage row flies to blank
 *  canvas on purpose: it shows the user where their maps stop). */
function onSharedRowFocus(item: SharedItem) {
  selectedShared.value = item.covered ? item : null;
  focusShared(item);
}

/** Adopt a shared item as your own pin/route. It becomes ordinary local map
 *  data (device-local — map:* never syncs), and an adopted location stops
 *  expiring: the user chose to keep it. */
async function saveShared(item: SharedItem) {
  const share = item.share;
  if (share.type === "map_pin") {
    await store.addPin(share.name, share.lat, share.lng, share.note, share.color);
  } else if (share.type === "map_loc") {
    await store.addPin(share.label || t("map.locSavedName"), share.lat, share.lng, share.note);
  } else {
    await store.addRoute(share.name, share.points, share.color);
  }
  selectedShared.value = null;
}

async function saveFocus() {
  const share = focus.value;
  if (!share) return;
  if (share.type === "map_pin") {
    await store.addPin(share.name, share.lat, share.lng, share.note, share.color);
  } else if (share.type === "map_loc") {
    // Adopting a location makes it an ordinary pin — no expiry from here on.
    await store.addPin(share.label || t("map.locSavedName"), share.lat, share.lng, share.note);
  } else if (share.type === "map_route") {
    await store.addRoute(share.name, share.points, share.color);
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
          <OyaButton
            v-if="mode !== 'draw-route'"
            :variant="mode === 'share-loc' ? 'primary' : 'secondary'"
            :disabled="!canShare"
            :title="canShare ? $t('map.shareLocHint') : $t('map.shareNeedsRoom')"
            data-testid="share-loc-button"
            @click="mode = mode === 'share-loc' ? 'idle' : 'share-loc'"
          >
            <font-awesome-icon icon="location-crosshairs" /> {{ $t('map.shareLoc') }}
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
          {{ mode === 'add-pin' ? $t('map.clickToPlace')
            : mode === 'share-loc' ? $t('map.clickToShareLoc')
            : $t('map.clickToExtend') }}
        </p>

        <!-- Shared-layer toggle: what room members shared, on your map. -->
        <button
          v-if="layer.all.value.length"
          type="button"
          data-testid="shared-layer-toggle"
          class="absolute right-3 z-10 flex items-center gap-2 rounded-full border border-accent-2 bg-primary-bg-light/90 px-3 py-1 text-xs font-semibold transition hover:opacity-80 dark:border-accent-1 dark:bg-primary-bg-dark/90"
          :class="store.activeRegion ? 'top-12' : 'top-3'"
          :title="$t('map.sharedLayerToggle')"
          @click="store.toggleSharedLayer()"
        >
          <font-awesome-icon :icon="store.sharedLayerVisible ? 'layer-group' : 'eye-slash'" />
          {{ layer.onMap.value.length }}
        </button>

        <!-- Detail for the shared item the user tapped. -->
        <div
          v-if="selectedShared"
          data-testid="shared-detail"
          class="absolute bottom-3 left-1/2 z-10 flex max-w-[90%] -translate-x-1/2 flex-col gap-2 rounded-lg border border-accent-2 bg-primary-bg-light/95 px-3 py-2 text-sm shadow dark:border-accent-1 dark:bg-primary-bg-dark/95"
        >
          <p class="flex items-center gap-2">
            <font-awesome-icon
              :icon="selectedShared.kind === 'route' ? 'route'
                : selectedShared.kind === 'loc' ? 'location-crosshairs' : 'location-dot'"
            />
            <span class="truncate font-semibold">
              {{ sharedItemName(selectedShared, $t('map.locCardDefault')) }}
            </span>
            <span class="shrink-0 text-xs opacity-60">
              {{ selectedShared.self ? $t('map.sharedYou')
                : $t('map.sharedFrom', { name: selectedShared.sender }) }}
            </span>
          </p>
          <p v-if="'note' in selectedShared.share && selectedShared.share.note" class="text-xs opacity-70">
            {{ selectedShared.share.note }}
          </p>
          <div class="flex flex-wrap gap-2">
            <OyaButton variant="secondary" @click="focusShared(selectedShared)">
              <font-awesome-icon icon="location-dot" /> {{ $t('map.openInMaps') }}
            </OyaButton>
            <OyaButton variant="primary" data-testid="shared-save" @click="saveShared(selectedShared)">
              {{ $t('map.saveToMyPins') }}
            </OyaButton>
            <OyaButton variant="secondary" @click="selectedShared = null">
              {{ $t('common.close') }}
            </OyaButton>
          </div>
        </div>

        <!-- Received-share preview banner: nothing is saved until the user says so. -->
        <div
          v-if="focus"
          class="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-accent-2 bg-primary-bg-light/95 px-3 py-2 text-sm shadow dark:border-accent-1 dark:bg-primary-bg-dark/95"
        >
          <font-awesome-icon :icon="focusIcon" />
          <span class="max-w-[14rem] truncate font-semibold">{{ focusName }}</span>
          <OyaButton variant="primary" @click="saveFocus">{{ $t('map.saveShared') }}</OyaButton>
          <OyaButton variant="secondary" @click="dismissFocus">{{ $t('common.close') }}</OyaButton>
        </div>
      </div>

      <!-- Pins / routes sidebar -->
      <div class="flex w-full flex-col gap-3 overflow-y-auto lg:w-80">
        <!-- What the room shared — above your own pins: it's the volatile part. -->
        <SharedSharesCard
          :on-map="layer.onMap.value"
          :outside="layer.outside.value"
          :visible="store.sharedLayerVisible"
          @focus="onSharedRowFocus"
          @save="saveShared"
          @toggle="store.toggleSharedLayer()"
        />
        <OyaCard>
          <h3 class="mb-2 text-sm font-bold"><font-awesome-icon icon="location-dot" /> {{ $t('map.pinsTitle') }}</h3>
          <p v-if="store.pins.length === 0" class="text-xs opacity-60">{{ $t('map.noPins') }}</p>
          <ul class="space-y-1">
            <li v-for="pin in store.pins" :key="pin.id" class="flex items-center gap-2 text-sm">
              <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-70" @click="showPin(pin)">
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  :style="{ backgroundColor: pin.color ?? '#2563eb' }"
                />
                <span class="min-w-0 truncate">{{ pin.name }}</span>
              </button>
              <button
                type="button"
                class="opacity-60 transition hover:opacity-100"
                :title="$t('map.editPin')"
                :data-testid="`pin-edit-${pin.id}`"
                @click="editPin(pin)"
              >
                <font-awesome-icon icon="pen" />
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

      <!-- Share a location: explicit, one-shot, and it says how long peers see it. -->
      <OyaModal :open="locModal !== null" @close="closeLocModal">
        <form
          class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
          @submit.prevent="shareLocation"
        >
          <p class="flex items-center gap-2 text-lg font-bold">
            <font-awesome-icon icon="location-crosshairs" />
            {{ $t('map.shareLocTitle') }}
          </p>
          <p v-if="locModal" class="text-xs opacity-60">
            {{ $t('map.locCoords', { lat: locModal.lat.toFixed(5), lng: locModal.lng.toFixed(5) }) }}
          </p>
          <label class="block text-xs font-semibold uppercase tracking-wide opacity-70">
            {{ $t('map.locLabelLabel') }}
            <OyaTextField v-model="locLabel" :maxlength="120" data-testid="loc-label" class="mt-1" />
          </label>
          <label class="block text-xs font-semibold uppercase tracking-wide opacity-70">
            {{ $t('map.locNoteLabel') }}
            <OyaTextField v-model="locNote" :maxlength="500" class="mt-1" />
          </label>
          <p class="text-xs opacity-60">
            {{ $t('map.locTtlNotice', { hours: Math.round(MAP_LOC_TTL_MS / 3600000) }) }}
          </p>
          <div class="flex justify-end gap-2 pt-1">
            <OyaButton variant="secondary" type="button" @click="closeLocModal">
              {{ $t('common.cancel') }}
            </OyaButton>
            <OyaButton type="submit" :disabled="locBusy" data-testid="loc-share-submit">
              <font-awesome-icon icon="share-nodes" /> {{ $t('map.shareAction') }}
            </OyaButton>
          </div>
        </form>
      </OyaModal>

      <!-- Pin editor: name, note and colour, for a new or an existing pin. -->
      <PinEditModal
        :open="pinModal !== null"
        :pin="pinModal?.pin ?? null"
        @submit="submitPin"
        @close="pinModal = null"
      />

      <!-- Name prompt for a finished route -->
      <OyaModal :open="nameModal !== null" @close="nameModal = null">
        <form
          class="w-full max-w-md space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
          @submit.prevent="confirmName"
        >
          <h3 class="text-lg font-bold">{{ $t('map.nameRouteTitle') }}</h3>
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
