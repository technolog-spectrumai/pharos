// Map model — pure types, validation, and tile math for the Maps feature.
// No Vue/Tauri imports (mirrors the app's meetingModel.ts): everything here is
// wire- and storage-shape logic shared by the chat share cards, the Maps UI,
// and (field-for-field, independently re-verified) the Rust import path.
//
// Wire safety: every payload that can arrive over the MLS seam is re-validated
// here on receive — never trust a wire object. Map BYTES never ride MLS; only
// these small JSON payloads do (regions transfer over the file_xfer QUIC path).

// ── Caps (shared by send + receive validation) ────────────────────────────────

export const MAP_SHARE_VERSION = 1;
export const MAP_NAME_MAX_LEN = 120;
export const MAP_NOTE_MAX_LEN = 500;
export const MAP_ROUTE_MIN_POINTS = 2;
export const MAP_ROUTE_MAX_POINTS = 2000;
export const MAP_MIN_ZOOM = 0;
export const MAP_MAX_ZOOM = 22;

// ── Core types ────────────────────────────────────────────────────────────────

/** [west, south, east, north] in degrees. Antimeridian-crossing boxes are
 *  rejected (west < east required) — split such downloads into two regions. */
export type MapBbox = [number, number, number, number];

/** Manifest of one immutable PMTiles region blob (content-addressed by
 *  `blake3`). Persisted ONLY in the encrypted kv store (`map:regions`);
 *  travels inside `map_region` share payloads. */
export interface MapRegionManifest {
  /** uuid — local identity, stable across re-shares of the same download. */
  id: string;
  name: string;
  bbox: MapBbox;
  minZoom: number;
  maxZoom: number;
  /** Exact byte size of the .pmtiles blob — verified before import. */
  size: number;
  /** Lowercase hex BLAKE3 of the blob — content address, verified before import. */
  blake3: string;
  /** Origin archive URL ("" for manual imports). */
  sourceUrl: string;
  /** Manifest schema version. */
  version: 1;
}

export interface MapPin {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Optional #rgb/#rrggbb accent; invalid values are dropped on validation. */
  color?: string;
  note?: string;
  /** Unix ms. */
  createdAt: number;
}

/** A user-drawn polyline of waypoints — never the output of a routing engine. */
export interface MapRoute {
  id: string;
  name: string;
  color?: string;
  /** [lat, lng] waypoints, MAP_ROUTE_MIN_POINTS..=MAP_ROUTE_MAX_POINTS. */
  points: [number, number][];
  /** Unix ms. */
  createdAt: number;
}

// ── Share payloads (MLS inner types — compact, versioned) ─────────────────────

export interface MapPinShare {
  type: "map_pin";
  v: typeof MAP_SHARE_VERSION;
  name: string;
  lat: number;
  lng: number;
  color?: string;
  note?: string;
}

export interface MapRouteShare {
  type: "map_route";
  v: typeof MAP_SHARE_VERSION;
  name: string;
  color?: string;
  points: [number, number][];
}

export interface MapRegionShare {
  type: "map_region";
  v: typeof MAP_SHARE_VERSION;
  manifest: MapRegionManifest;
  /** file_xfer offer handle on the sender's ephemeral QUIC endpoint. */
  offerId: string;
  /** Sender's EndpointAddr (base32 postcard, as minted by file_offer_create). */
  addr: string;
}

export function buildPinShare(pin: MapPin): MapPinShare {
  const share: MapPinShare = {
    type: "map_pin",
    v: MAP_SHARE_VERSION,
    name: clampName(pin.name),
    lat: pin.lat,
    lng: pin.lng,
  };
  if (pin.color && isHexColor(pin.color)) share.color = pin.color;
  if (pin.note) share.note = pin.note.slice(0, MAP_NOTE_MAX_LEN);
  return share;
}

export function buildRouteShare(route: MapRoute): MapRouteShare {
  const share: MapRouteShare = {
    type: "map_route",
    v: MAP_SHARE_VERSION,
    name: clampName(route.name),
    points: route.points.slice(0, MAP_ROUTE_MAX_POINTS),
  };
  if (route.color && isHexColor(route.color)) share.color = route.color;
  return share;
}

export function buildRegionShare(
  manifest: MapRegionManifest,
  offerId: string,
  addr: string,
): MapRegionShare {
  return { type: "map_region", v: MAP_SHARE_VERSION, manifest, offerId, addr };
}

// ── Validation (defensive narrowing — wire objects are untrusted) ─────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFinite_(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function isValidLat(lat: unknown): lat is number {
  return isFinite_(lat) && lat >= -90 && lat <= 90;
}

export function isValidLng(lng: unknown): lng is number {
  return isFinite_(lng) && lng >= -180 && lng <= 180;
}

export function isHexColor(x: unknown): x is string {
  return typeof x === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(x);
}

function isValidName(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0 && x.length <= MAP_NAME_MAX_LEN;
}

function clampName(name: string): string {
  return name.trim().slice(0, MAP_NAME_MAX_LEN);
}

export function isValidBbox(x: unknown): x is MapBbox {
  if (!Array.isArray(x) || x.length !== 4) return false;
  const [west, south, east, north] = x;
  return (
    isValidLng(west) && isValidLat(south) && isValidLng(east) && isValidLat(north) &&
    west < east && south < north
  );
}

function isValidZoom(x: unknown): x is number {
  return isFinite_(x) && Number.isInteger(x) && x >= MAP_MIN_ZOOM && x <= MAP_MAX_ZOOM;
}

const BLAKE3_HEX = /^[0-9a-f]{64}$/;

/** Narrow an untrusted value to a MapRegionManifest (null = reject). */
export function validateManifest(x: unknown): MapRegionManifest | null {
  if (!isRecord(x)) return null;
  const { id, name, bbox, minZoom, maxZoom, size, blake3, sourceUrl, version } = x;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  if (!isValidName(name)) return null;
  if (!isValidBbox(bbox)) return null;
  if (!isValidZoom(minZoom) || !isValidZoom(maxZoom) || minZoom > maxZoom) return null;
  if (!isFinite_(size) || !Number.isInteger(size) || size <= 0) return null;
  if (typeof blake3 !== "string" || !BLAKE3_HEX.test(blake3)) return null;
  if (typeof sourceUrl !== "string" || sourceUrl.length > 2048) return null;
  if (version !== MAP_SHARE_VERSION) return null;
  return {
    id, name: clampName(name), bbox, minZoom, maxZoom, size, blake3, sourceUrl,
    version: MAP_SHARE_VERSION,
  };
}

export function validatePinShare(x: unknown): MapPinShare | null {
  if (!isRecord(x)) return null;
  if (x.type !== "map_pin" || x.v !== MAP_SHARE_VERSION) return null;
  if (!isValidName(x.name) || !isValidLat(x.lat) || !isValidLng(x.lng)) return null;
  const share: MapPinShare = {
    type: "map_pin", v: MAP_SHARE_VERSION,
    name: clampName(x.name), lat: x.lat, lng: x.lng,
  };
  if (isHexColor(x.color)) share.color = x.color;
  if (typeof x.note === "string" && x.note.length > 0) {
    share.note = x.note.slice(0, MAP_NOTE_MAX_LEN);
  }
  return share;
}

export function validateRouteShare(x: unknown): MapRouteShare | null {
  if (!isRecord(x)) return null;
  if (x.type !== "map_route" || x.v !== MAP_SHARE_VERSION) return null;
  if (!isValidName(x.name)) return null;
  const pts = x.points;
  if (!Array.isArray(pts) || pts.length < MAP_ROUTE_MIN_POINTS || pts.length > MAP_ROUTE_MAX_POINTS) {
    return null;
  }
  const points: [number, number][] = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !isValidLat(p[0]) || !isValidLng(p[1])) return null;
    points.push([p[0], p[1]]);
  }
  const share: MapRouteShare = {
    type: "map_route", v: MAP_SHARE_VERSION, name: clampName(x.name), points,
  };
  if (isHexColor(x.color)) share.color = x.color;
  return share;
}

export function validateRegionShare(x: unknown): MapRegionShare | null {
  if (!isRecord(x)) return null;
  if (x.type !== "map_region" || x.v !== MAP_SHARE_VERSION) return null;
  const manifest = validateManifest(x.manifest);
  if (!manifest) return null;
  const { offerId, addr } = x;
  if (typeof offerId !== "string" || offerId.length === 0 || offerId.length > 128) return null;
  if (typeof addr !== "string" || addr.length === 0 || addr.length > 2048) return null;
  return { type: "map_region", v: MAP_SHARE_VERSION, manifest, offerId, addr };
}

// ── Tile math (Web Mercator / XYZ) ────────────────────────────────────────────

/** Web Mercator latitude limit — tiles don't exist beyond it. */
export const MERCATOR_MAX_LAT = 85.05112878;

/** XYZ tile containing (lon, lat) at zoom z. Lat is clamped to the Mercator
 *  range; results are clamped into 0..2^z-1. */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
  return { x: clamp(x), y: clamp(y) };
}

/** Inclusive XYZ tile range covering a bbox at zoom z. */
export function bboxTileRange(
  bbox: MapBbox,
  z: number,
): { xMin: number; xMax: number; yMin: number; yMax: number } {
  const [west, south, east, north] = bbox;
  const a = lonLatToTile(west, north, z); // north-west → smallest x,y
  const b = lonLatToTile(east, south, z); // south-east → largest x,y
  return { xMin: a.x, xMax: b.x, yMin: a.y, yMax: b.y };
}

/** Total tiles covering a bbox across minZoom..=maxZoom (UI estimate + cap
 *  checks; the Rust side recomputes authoritatively). */
export function bboxTileCount(bbox: MapBbox, minZoom: number, maxZoom: number): number {
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = bboxTileRange(bbox, z);
    count += (r.xMax - r.xMin + 1) * (r.yMax - r.yMin + 1);
  }
  return count;
}
