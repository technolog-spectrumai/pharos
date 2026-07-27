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
export const MAP_MIN_ZOOM = 0;
export const MAP_MAX_ZOOM = 22;

/** How long a shared location keeps rendering on the map. "Where I am" goes
 *  stale, so the marker disappears — the chat card stays as a permanent record.
 *  Expiry is a RENDER decision only; see validateLocationShare. */
export const MAP_LOC_TTL_MS = 6 * 60 * 60 * 1000;
/** A peer's clock may be ahead of ours. Inside this window a future `at` is
 *  treated as live (fail open — a "meet me here" should show); beyond it the
 *  share is ignored, so a wildly wrong clock can't pin a marker forever. */
export const MAP_LOC_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
/** Sanity ceiling for `at` (year 2100). Deliberately a CONSTANT, not `now` —
 *  see validateLocationShare. */
const MAP_LOC_AT_CEILING = 4102444800000;

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

/** A place the user tapped and deliberately pushed to a room ("I'm here", "meet
 *  me here"). Its own type rather than a pin with a timestamp: an older build's
 *  validatePinShare ignores unknown keys, so reusing map_pin would render an
 *  EPHEMERAL location as a permanent pin. Old builds must drop this — and do,
 *  via the receive ternary's null fallthrough. */
export interface MapLocationShare {
  type: "map_loc";
  v: typeof MAP_SHARE_VERSION;
  lat: number;
  lng: number;
  /** Unix ms on the SENDER's clock when the point was shared. On the wire (not
   *  derived from the message timestamp, which is receive time): sender,
   *  receiver and a linked-device replay would otherwise each age it
   *  differently. Drives expiry. */
  at: number;
  label?: string;
  note?: string;
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

export function buildLocationShare(
  lat: number,
  lng: number,
  opts: { at?: number; label?: string; note?: string } = {},
): MapLocationShare {
  const share: MapLocationShare = {
    type: "map_loc",
    v: MAP_SHARE_VERSION,
    lat,
    lng,
    at: opts.at ?? Date.now(),
  };
  const label = opts.label?.trim();
  if (label) share.label = label.slice(0, MAP_NAME_MAX_LEN);
  if (opts.note) share.note = opts.note.slice(0, MAP_NOTE_MAX_LEN);
  return share;
}

export function buildRegionShare(
  manifest: MapRegionManifest,
  offerId: string,
  addr: string,
): MapRegionShare {
  return { type: "map_region", v: MAP_SHARE_VERSION, manifest, offerId, addr };
}

// ── Location expiry (render-time only) ────────────────────────────────────────

/** Age of a shared location, clamped at 0 for a future `at` (clock skew). */
export function locationAgeMs(share: MapLocationShare, now: number): number {
  return Math.max(0, now - share.at);
}

/** Should this location still be drawn? Past the TTL it is stale; further ahead
 *  than MAP_LOC_MAX_FUTURE_SKEW_MS it is a broken clock and also ignored. */
export function isLocationLive(
  share: MapLocationShare,
  now: number,
  ttlMs: number = MAP_LOC_TTL_MS,
): boolean {
  if (share.at - now > MAP_LOC_MAX_FUTURE_SKEW_MS) return false;
  return locationAgeMs(share, now) <= ttlMs;
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

/** Narrow an untrusted location share.
 *
 *  TIME-INDEPENDENT BY DESIGN: `at` is only checked against a fixed ceiling,
 *  never against `now`. chatLog re-validates every stored message on every
 *  load, and validatePersistedMessage keeps a message while dropping an invalid
 *  `map` field — so a time-dependent validator would turn an expired card into
 *  an empty bubble on the next restart. Expiry belongs to the renderer
 *  (isLocationLive), which is also what keeps the card as a permanent record. */
export function validateLocationShare(x: unknown): MapLocationShare | null {
  if (!isRecord(x)) return null;
  if (x.type !== "map_loc" || x.v !== MAP_SHARE_VERSION) return null;
  if (!isValidLat(x.lat) || !isValidLng(x.lng)) return null;
  const { at } = x;
  if (!isFinite_(at) || !Number.isInteger(at) || at <= 0 || at > MAP_LOC_AT_CEILING) return null;
  const share: MapLocationShare = {
    type: "map_loc", v: MAP_SHARE_VERSION, lat: x.lat, lng: x.lng, at,
  };
  if (isValidName(x.label)) share.label = clampName(x.label);
  if (typeof x.note === "string" && x.note.length > 0) {
    share.note = x.note.slice(0, MAP_NOTE_MAX_LEN);
  }
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

// ── Coverage (which shared items can actually be drawn) ──────────────────────
// A share is only worth putting on the canvas if some IMPORTED region covers
// it — otherwise the marker floats over blank space. The predicate is per
// region on purpose: the union bbox from map_source_info would report the empty
// gap between two disjoint regions (say Poznań + Berlin) as covered, which is
// exactly the tempting shortcut to avoid.
//
// bbox only, never the zoom band: map_get_tile checks min/maxZoom per tile
// request, and a point inside a bbox is reachable at some zoom in that band —
// gating here would make a pin blink out as the user zooms in.
//
// Antimeridian needs no special case: isValidBbox demands west < east (and the
// Rust manifest validator rejects the same), so no stored region can cross the
// seam. The honest consequence is that a share at 179.9° will not match a
// region ending at -179.9°; such downloads are split into two regions.

/** Inclusive on all four edges. */
export function pointInBbox(bbox: MapBbox, lat: number, lng: number): boolean {
  const [west, south, east, north] = bbox;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

export function regionCovers(manifest: MapRegionManifest, lat: number, lng: number): boolean {
  return pointInBbox(manifest.bbox, lat, lng);
}

export function coveredByAny(
  regions: readonly MapRegionManifest[],
  lat: number,
  lng: number,
): boolean {
  return regions.some((r) => regionCovers(r, lat, lng));
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
