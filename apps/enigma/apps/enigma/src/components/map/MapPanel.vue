<script setup lang="ts">
// The MapLibre canvas: offline-first tiles through the `enigma-map://` custom
// protocol (one Rust command resolves local regions, then the gated remote
// source), private pins (sealed kv), and "Share to room"
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
  haversineMeters,
  isBeaconLive,
  getUseTor,
  MAP_LOC_TTL_MS,
  OyaButton,
  OyaCard,
  OyaEmptyState,
  OyaModal,
  OyaTextField,
  type BeaconPin,
  type BeaconRoute,
  type BeaconZone,
  type MapPin,
  type MapShare,
} from "rakotis";
import { policy } from "../../config/app";
import { useBeaconStore } from "../../stores/beacon";
import { useChatStore } from "../../stores/chat";
import { useCloudStore } from "../../stores/cloud";
import { useMapStore } from "../../stores/map";
import BeaconCard from "./BeaconCard.vue";
import BeaconPublishModal from "./BeaconPublishModal.vue";
import PinEditModal from "./PinEditModal.vue";
import { BEACON_COLOR } from "./pinColors";
import SharedSharesCard from "./SharedSharesCard.vue";
import { sharedItemName, type SharedItem } from "./sharedLayerModel";
import { useSharedMapLayer } from "./useSharedMapLayer";

const props = defineProps<{ darkMode?: boolean }>();

const { t } = useI18n({ useScope: "global" });
const store = useMapStore();
const chatStore = useChatStore();
const beaconStore = useBeaconStore();
const cloudStore = useCloudStore();

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
type Mode = "idle" | "add-pin" | "share-loc"
  | "beacon-pin" | "beacon-zone" | "beacon-route";
const mode = ref<Mode>("idle");
const draftPoints = ref<[number, number][]>([]); // [lat, lng]

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

/** Tor-exclusive mode drops LOCATION sharing (cloud.md D9): hiding your network
 *  location while broadcasting a geographic one is incoherent. Sending is what
 *  is blocked — locations peers already shared still render, because receiving
 *  leaks nothing and dropping them would silently lose data. */
const torMode = ref(false);

/** Can this room take a share at all — used by the pin share button,
 *  which push a SAVED map object over the encrypted seam and reveal nothing
 *  about where the sender is. Deliberately NOT Tor-gated. */
const canShare = computed(
  () =>
    chatStore.p2p.currentRoom.value !== null &&
    chatStore.p2p.isConnected.value &&
    chatStore.p2p.mlsStatus.value === "ready",
);

/** Sharing "where I am" specifically — the one thing Tor mode withdraws. */
const canShareLoc = computed(() => canShare.value && !torMode.value);

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

/** Map overlays live outside the theme style, so they must be re-added
 *  whenever the style is replaced (setStyle drops user sources/layers).
 *  Pin markers are DOM overlays and survive untouched. */
function addOverlayLayers() {
  // Guard keyed on the DRAFT source: it is the first one added below and the
  // one that always exists, so a theme switch cannot double-add beacon layers.
  if (!map || map.getSource("draft-route")) return;
  // Beacon (server) zones/routes render under the draft so drawing stays on top.
  map.addSource("beacon-zones", { type: "geojson", data: beaconZonesGeoJson() });
  map.addLayer({
    id: "beacon-zones-fill",
    type: "fill",
    source: "beacon-zones",
    paint: { "fill-color": BEACON_COLOR, "fill-opacity": 0.15 },
  });
  map.addLayer({
    id: "beacon-zones-line",
    type: "line",
    source: "beacon-zones",
    paint: { "line-color": BEACON_COLOR, "line-width": 2, "line-dasharray": [3, 2] },
  });
  map.addSource("beacon-routes", { type: "geojson", data: beaconRoutesGeoJson() });
  map.addLayer({
    id: "beacon-routes-line",
    type: "line",
    source: "beacon-routes",
    paint: { "line-color": BEACON_COLOR, "line-width": 3, "line-dasharray": [4, 2] },
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
// blur together: own pin #2563eb, draft #f59e0b, focus
// preview #16a34a.
const SHARED_COLOR = "#7c3aed";
const SHARED_LOC_COLOR = "#ea580c";

const layer = useSharedMapLayer();
/** The shared item whose detail banner is open. */
const selectedShared = ref<SharedItem | null>(null);

// ── beacon (server shares) ───────────────────────────────────────────────────
/** Server pins are DOM markers like local pins; zones/routes are GeoJSON
 *  layers. Everything culls on expiry at render time (isBeaconLive). */
const beaconMarkers = new Map<number, { marker: maplibregl.Marker; sig: string }>();
type SelectedBeacon =
  | { kind: "pin"; pin: BeaconPin }
  | { kind: "zone"; zone: BeaconZone }
  | { kind: "route"; route: BeaconRoute };
const selectedBeacon = ref<SelectedBeacon | null>(null);
/** Minute tick so expiry culling/countdowns advance without data changes. */
const beaconNow = ref(Date.now());
let beaconTick: number | undefined;

const liveBeaconPins = computed(() =>
  beaconStore.layerVisible
    ? beaconStore.pins.filter((p) => isBeaconLive(p.expiresAt, beaconNow.value))
    : [],
);
const liveBeaconZones = computed(() =>
  beaconStore.layerVisible
    ? beaconStore.zones.filter((z) => isBeaconLive(z.expiresAt, beaconNow.value))
    : [],
);
const liveBeaconRoutes = computed(() =>
  beaconStore.layerVisible
    ? beaconStore.routes.filter((r) => isBeaconLive(r.expiresAt, beaconNow.value))
    : [],
);

/** Publish flow: tapped point (pin) or the current draft (zone/route). */
const beaconModal = ref<null | { kind: "pin" | "zone" | "route"; lat?: number; lng?: number }>(null);
const beaconModalRef = ref<InstanceType<typeof BeaconPublishModal> | null>(null);
/** Shows the tapped point while the pin modal is open (locModal pattern). */
let pendingBeaconMarker: maplibregl.Marker | null = null;
const beaconDrafting = computed(
  () => mode.value === "beacon-zone" || mode.value === "beacon-route",
);
const canPublishBeacon = computed(
  () => beaconStore.beaconAvailable && cloudStore.enabled && cloudStore.loggedIn,
);

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
  // A selected item that just expired or left coverage must not keep its banner.
  if (selectedShared.value && !layer.onMap.value.some((i) => i.key === selectedShared.value!.key)) {
    selectedShared.value = null;
  }
}



// ── beacon overlays ──────────────────────────────────────────────────────────
function beaconZonesGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: liveBeaconZones.value.map((z) => ({
      type: "Feature",
      properties: { id: z.id },
      geometry: {
        type: "Polygon",
        // The model stores the open ring; GeoJSON wants it closed again.
        coordinates: [[...z.ring, z.ring[0]!].map(([lat, lng]) => [lng, lat])],
      },
    })),
  };
}

function beaconRoutesGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: liveBeaconRoutes.value.map((r) => ({
      type: "Feature",
      properties: { id: r.id },
      geometry: {
        type: "LineString",
        coordinates: r.points.map(([lat, lng]) => [lng, lat]),
      },
    })),
  };
}

/** A server pin badge: the publisher's initial on the beacon accent, so server
 *  shares never read as local pins or room shares. */
function beaconMarkerEl(pin: BeaconPin): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className =
    "flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[10px] " +
    "font-bold text-white shadow transition hover:scale-110";
  el.style.backgroundColor = BEACON_COLOR;
  const label = pin.user === cloudStore.username ? t("map.beaconYou") : pin.user;
  el.textContent = label.slice(0, 1).toUpperCase();
  el.title = `${label}${pin.comment ? ` · ${pin.comment}` : ""}`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedBeacon.value = { kind: "pin", pin };
  });
  return el;
}

function refreshBeaconPins() {
  if (!map) return;
  const seen = new Set<number>();
  for (const pin of liveBeaconPins.value) {
    seen.add(pin.id);
    const sig = `${pin.lat}|${pin.lng}|${pin.user}|${pin.comment}`;
    const existing = beaconMarkers.get(pin.id);
    if (existing && existing.sig === sig) continue;
    existing?.marker.remove();
    const marker = new maplibregl.Marker({ element: beaconMarkerEl(pin) })
      .setLngLat([pin.lng, pin.lat])
      .addTo(map);
    beaconMarkers.set(pin.id, { marker, sig });
  }
  for (const [id, entry] of beaconMarkers) {
    if (!seen.has(id)) {
      entry.marker.remove();
      beaconMarkers.delete(id);
    }
  }
}

function refreshBeaconShapes() {
  const zones = map?.getSource("beacon-zones") as maplibregl.GeoJSONSource | undefined;
  zones?.setData(beaconZonesGeoJson());
  const routes = map?.getSource("beacon-routes") as maplibregl.GeoJSONSource | undefined;
  routes?.setData(beaconRoutesGeoJson());
  // A selected share that expired or was deleted must not keep its banner.
  const sel = selectedBeacon.value;
  if (!sel) return;
  const still =
    sel.kind === "pin"
      ? liveBeaconPins.value.some((p) => p.id === sel.pin.id)
      : sel.kind === "zone"
        ? liveBeaconZones.value.some((z) => z.id === sel.zone.id)
        : liveBeaconRoutes.value.some((r) => r.id === sel.route.id);
  if (!still) selectedBeacon.value = null;
}

function refreshDraft() {
  const src = map?.getSource("draft-route") as maplibregl.GeoJSONSource | undefined;
  src?.setData(draftGeoJson(draftPoints.value));
}

// ── boot ─────────────────────────────────────────────────────────────────────
onMounted(async () => {
  if (!tauri) return;               // honest desktop-only state renders instead
  trace("boot: mounted (tauri)");
  torMode.value = await getUseTor().catch(() => false);
  beaconStore.torBlocked = torMode.value;
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
      refreshBeaconPins();
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
    // Tapping a beacon zone/route opens its banner (only outside placement
    // modes — a placement click must never double as a selection).
    map.on("click", "beacon-zones-fill", (e) => {
      if (mode.value !== "idle") return;
      const id = e.features?.[0]?.properties?.id as number | undefined;
      const zone = liveBeaconZones.value.find((z) => z.id === id);
      if (zone) selectedBeacon.value = { kind: "zone", zone };
    });
    map.on("click", "beacon-routes-line", (e) => {
      if (mode.value !== "idle") return;
      const id = e.features?.[0]?.properties?.id as number | undefined;
      const route = liveBeaconRoutes.value.find((r) => r.id === id);
      if (route) selectedBeacon.value = { kind: "route", route };
    });

    beaconTick = window.setInterval(() => {
      beaconNow.value = Date.now();
    }, 60_000);
  } catch (e) {
    console.error("[map] startup failed:", e);
    pushDiag(`startup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  if (beaconTick !== undefined) window.clearInterval(beaconTick);
  pendingBeaconMarker?.remove();
  for (const entry of pinMarkers.values()) entry.marker.remove();
  pinMarkers.clear();
  for (const entry of sharedMarkers.values()) entry.marker.remove();
  sharedMarkers.clear();
  for (const entry of beaconMarkers.values()) entry.marker.remove();
  beaconMarkers.clear();
  pendingLocMarker?.remove();
  focusMarker?.remove();
  map?.remove();
  map = null;
});

// Follow the app theme live: setStyle keeps the camera and the DOM markers,
// but drops user sources/layers — so the overlays are re-added once the
// new style is in place.
watch(flavor, (next) => {
  if (!map || !ready.value) return;
  trace(`theme: switching basemap to ${next}`);
  map.setStyle(buildStyle(next, sourceMaxZoom));
  map.once("styledata", () => {
    addOverlayLayers();
    refreshDraft();
      refreshBeaconShapes();
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
watch(draftPoints, refreshDraft, { deep: true });
watch(() => store.pendingFocus, applyPendingFocus);
watch(liveBeaconPins, refreshBeaconPins);
watch([liveBeaconZones, liveBeaconRoutes], refreshBeaconShapes);

// ── interactions ─────────────────────────────────────────────────────────────
function onMapClick(e: maplibregl.MapMouseEvent) {
  if (mode.value === "add-pin") {
    pinModal.value = { lat: e.lngLat.lat, lng: e.lngLat.lng, pin: null };
    mode.value = "idle";
  } else if (beaconDrafting.value) {
    draftPoints.value = [...draftPoints.value, [e.lngLat.lat, e.lngLat.lng]];
  } else if (mode.value === "share-loc") {
    openLocModal(e.lngLat.lat, e.lngLat.lng);
  } else if (mode.value === "beacon-pin") {
    openBeaconPinModal(e.lngLat.lat, e.lngLat.lng);
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


// ── beacon publish flows (explicit action only — a tap, then a submit) ───────
function openBeaconPinModal(lat: number, lng: number) {
  mode.value = "idle";
  beaconModal.value = { kind: "pin", lat, lng };
  pendingBeaconMarker?.remove();
  if (map) {
    pendingBeaconMarker = new maplibregl.Marker({ color: BEACON_COLOR })
      .setLngLat([lng, lat])
      .addTo(map);
  }
}

function startBeaconDraft(kind: "zone" | "route") {
  mode.value = kind === "zone" ? "beacon-zone" : "beacon-route";
  draftPoints.value = [];
}

const beaconDraftMinPoints = computed(() => (mode.value === "beacon-zone" ? 3 : 2));

function finishBeaconDraft() {
  if (draftPoints.value.length < beaconDraftMinPoints.value) {
    cancelDraw();
    return;
  }
  beaconModal.value = { kind: mode.value === "beacon-zone" ? "zone" : "route" };
}

function closeBeaconModal() {
  const kind = beaconModal.value?.kind;
  beaconModal.value = null;
  pendingBeaconMarker?.remove();
  pendingBeaconMarker = null;
  // A cancelled zone/route publish keeps its draft (route-name modal pattern);
  // a cancelled pin tap just ends the flow.
  if (kind === "pin") mode.value = "idle";
}

async function submitBeaconPublish(fields: { name: string; comment: string; ttlSeconds: number }) {
  const modal = beaconModal.value;
  if (!modal) return;
  try {
    if (modal.kind === "pin") {
      await beaconStore.publishPin(modal.lat!, modal.lng!, fields.ttlSeconds, fields.comment);
    } else if (modal.kind === "zone") {
      await beaconStore.publishZone(fields.name, draftPoints.value, fields.ttlSeconds, fields.comment);
    } else {
      await beaconStore.publishRoute(fields.name, draftPoints.value, fields.ttlSeconds, fields.comment);
    }
  } catch (e) {
    beaconModalRef.value?.showError(e instanceof Error ? e.message : String(e));
    return;
  }
  beaconModal.value = null;
  pendingBeaconMarker?.remove();
  pendingBeaconMarker = null;
  draftPoints.value = [];
  mode.value = "idle";
}


function cancelDraw() {
  mode.value = "idle";
  draftPoints.value = [];
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


async function sharePin(pin: MapPin) {
  await chatStore.p2p.sendMapShare(buildPinShare(pin));
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
  focusMarker = new maplibregl.Marker({ color: "#16a34a" })
    .setLngLat([share.lng, share.lat])
    .addTo(map);
  map.flyTo({ center: [share.lng, share.lat], zoom: Math.max(map.getZoom(), 13) });
}

const focusIcon = computed(() =>
  focus.value?.type === "map_loc" ? "location-crosshairs" : "location-dot",
);

const focusName = computed(() => {
  const f = focus.value;
  if (!f) return "";
  return f.type === "map_loc" ? f.label || t("map.locCardDefault") : f.name;
});

/** Fly to a shared item (a point, or the bounds of a shared route). */
function focusShared(item: SharedItem) {
  if (!map) return;
  const pt = item.share as { lat: number; lng: number };
  map.flyTo({ center: [pt.lng, pt.lat], zoom: Math.max(map.getZoom(), 13) });
}

// ── beacon focus / banner ────────────────────────────────────────────────────
function focusBeaconPin(pin: BeaconPin) {
  selectedBeacon.value = { kind: "pin", pin };
  map?.flyTo({ center: [pin.lng, pin.lat], zoom: Math.max(map.getZoom(), 13) });
}

function fitLatLngBounds(points: readonly [number, number][]) {
  if (!map || points.length === 0) return;
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 60, maxZoom: 15 },
  );
}

function focusBeaconZone(zone: BeaconZone) {
  selectedBeacon.value = { kind: "zone", zone };
  fitLatLngBounds(zone.ring);
}

function focusBeaconRoute(route: BeaconRoute) {
  selectedBeacon.value = { kind: "route", route };
  fitLatLngBounds(route.points);
}

const selectedBeaconName = computed(() => {
  const sel = selectedBeacon.value;
  if (!sel) return "";
  if (sel.kind === "pin") {
    return sel.pin.user === cloudStore.username ? t("map.beaconYou") : sel.pin.user;
  }
  const named = sel.kind === "zone" ? sel.zone : sel.route;
  return named.name || t(sel.kind === "zone" ? "map.beaconZonesGroup" : "map.beaconRoutesGroup");
});

const selectedBeaconShare = computed(() => {
  const sel = selectedBeacon.value;
  if (!sel) return null;
  return sel.kind === "pin" ? sel.pin : sel.kind === "zone" ? sel.zone : sel.route;
});

const selectedBeaconOwn = computed(() => {
  const share = selectedBeaconShare.value;
  return !!share && share.user === cloudStore.username;
});

function beaconLeftText(expiresAt: number): string {
  const minutes = Math.round(Math.max(0, expiresAt - beaconNow.value) / 60_000);
  if (minutes <= 0) return t("map.beaconExpired");
  if (minutes < 60) return t("map.beaconLeftMinutes", { n: Math.max(1, minutes) });
  return t("map.beaconLeftHours", { n: Math.round(minutes / 60) });
}

/** "Near here": ask the server for pins around the visible map center, radius
 *  = distance to the viewport's NE corner (min 1 km — a fully zoomed-in view
 *  should still find the neighbourhood). The server caps oversized radii. */
async function beaconNearHere() {
  if (!map) return;
  const center = map.getCenter();
  const bounds = map.getBounds();
  const radius = Math.max(
    1000,
    haversineMeters(center.lat, center.lng, bounds.getNorth(), bounds.getEast()),
  );
  try {
    await beaconStore.near(center.lat, center.lng, radius);
  } catch { /* surfaced via beaconStore.error on the card */ }
}

/** Delete the banner's share from the server (own shares only — the button is
 *  hidden otherwise; a raced 404 just closes the banner). */
async function deleteSelectedBeacon() {
  const sel = selectedBeacon.value;
  if (!sel) return;
  try {
    if (sel.kind === "pin") await beaconStore.deletePin();
    else if (sel.kind === "zone") await beaconStore.deleteZone(sel.zone.id);
    else await beaconStore.deleteRoute(sel.route.id);
  } catch { /* stale row disappears on the next refresh */ }
  selectedBeacon.value = null;
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
    }
  dismissFocus();
}

function dismissFocus() {
  focus.value = null;
  focusMarker?.remove();
  focusMarker = null;
  if (!beaconDrafting.value) draftPoints.value = [];
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
          <template v-if="beaconDrafting">
            <OyaButton
              variant="primary"
              :disabled="draftPoints.length < beaconDraftMinPoints"
              data-testid="beacon-finish"
              @click="finishBeaconDraft"
            >
              {{ $t('map.finishRoute', { n: draftPoints.length }) }}
            </OyaButton>
            <OyaButton variant="secondary" @click="cancelDraw">
              {{ $t('common.cancel') }}
            </OyaButton>
          </template>
          <template v-else>
            <OyaButton
              :variant="mode === 'add-pin' ? 'primary' : 'secondary'"
              @click="mode = mode === 'add-pin' ? 'idle' : 'add-pin'"
            >
              <font-awesome-icon icon="location-dot" /> {{ $t('map.addPin') }}
            </OyaButton>
            <OyaButton
              v-if="!torMode"
              :variant="mode === 'share-loc' ? 'primary' : 'secondary'"
              :disabled="!canShareLoc"
              :title="canShareLoc ? $t('map.shareLocHint') : $t('map.shareNeedsRoom')"
              data-testid="share-loc-button"
              @click="mode = mode === 'share-loc' ? 'idle' : 'share-loc'"
            >
              <font-awesome-icon icon="location-crosshairs" /> {{ $t('map.shareLoc') }}
            </OyaButton>
            <template v-if="canPublishBeacon">
              <OyaButton
                :variant="mode === 'beacon-pin' ? 'primary' : 'secondary'"
                :title="$t('map.beaconClickToPlace')"
                data-testid="beacon-pin-button"
                @click="mode = mode === 'beacon-pin' ? 'idle' : 'beacon-pin'"
              >
                <font-awesome-icon icon="bullseye" /> {{ $t('map.beaconPublishPin') }}
              </OyaButton>
              <OyaButton variant="secondary" data-testid="beacon-zone-button" @click="startBeaconDraft('zone')">
                <font-awesome-icon icon="object-group" /> {{ $t('map.beaconPublishZone') }}
              </OyaButton>
              <OyaButton variant="secondary" data-testid="beacon-route-button" @click="startBeaconDraft('route')">
                <font-awesome-icon icon="route" /> {{ $t('map.beaconPublishRoute') }}
              </OyaButton>
            </template>
          </template>
        </div>

        <!-- Hint while placing -->
        <p
          v-if="mode !== 'idle'"
          class="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-primary-bg-light/90 px-3 py-1.5 text-xs shadow dark:bg-primary-bg-dark/90"
        >
          {{ mode === 'add-pin' ? $t('map.clickToPlace')
            : mode === 'share-loc' ? $t('map.clickToShareLoc')
            : mode === 'beacon-pin' ? $t('map.beaconClickToPlace')
            : mode === 'beacon-zone' ? $t('map.beaconClickToZone')
            : $t('map.beaconClickToRoute') }}
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
              :icon="selectedShared.kind === 'loc' ? 'location-crosshairs' : 'location-dot'"
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

        <!-- Detail for the beacon (server) share the user tapped. -->
        <div
          v-if="selectedBeacon && selectedBeaconShare"
          data-testid="beacon-detail"
          class="absolute bottom-3 left-1/2 z-10 flex max-w-[90%] -translate-x-1/2 flex-col gap-2 rounded-lg border border-accent-2 bg-primary-bg-light/95 px-3 py-2 text-sm shadow dark:border-accent-1 dark:bg-primary-bg-dark/95"
        >
          <p class="flex items-center gap-2">
            <font-awesome-icon
              :icon="selectedBeacon.kind === 'route' ? 'route'
                : selectedBeacon.kind === 'zone' ? 'object-group' : 'location-dot'"
              :style="{ color: BEACON_COLOR }"
            />
            <span class="truncate font-semibold">{{ selectedBeaconName }}</span>
            <span v-if="selectedBeacon.kind !== 'pin'" class="shrink-0 text-xs opacity-60">
              {{ selectedBeaconOwn ? $t('map.beaconYou')
                : $t('map.sharedFrom', { name: selectedBeaconShare.user }) }}
            </span>
            <span class="shrink-0 text-xs opacity-50">
              {{ beaconLeftText(selectedBeaconShare.expiresAt) }}
            </span>
          </p>
          <p v-if="selectedBeaconShare.comment" class="text-xs opacity-70">
            {{ selectedBeaconShare.comment }}
          </p>
          <div class="flex flex-wrap gap-2">
            <OyaButton
              v-if="selectedBeaconOwn"
              variant="secondary"
              data-testid="beacon-detail-delete"
              @click="deleteSelectedBeacon"
            >
              <font-awesome-icon icon="trash" /> {{ $t('map.beaconDeleteShare') }}
            </OyaButton>
            <OyaButton variant="secondary" @click="selectedBeacon = null">
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
        <!-- Server shares (beacon) — only in builds with cloud + maps. -->
        <BeaconCard
          v-if="beaconStore.beaconAvailable"
          @focus-pin="focusBeaconPin"
          @focus-zone="focusBeaconZone"
          @focus-route="focusBeaconRoute"
          @near="beaconNearHere"
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

      <!-- Publish to the server: mandatory TTL, optional comment/name. -->
      <BeaconPublishModal
        ref="beaconModalRef"
        :open="beaconModal !== null"
        :kind="beaconModal?.kind ?? 'pin'"
        :point-count="beaconModal && beaconModal.kind !== 'pin' ? draftPoints.length : undefined"
        @submit="submitBeaconPublish"
        @close="closeBeaconModal"
      />

      <!-- Name prompt for a finished route -->
    </template>
  </div>
</template>
