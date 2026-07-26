// Beacon model — pure types and validation for server-side location shares.
// No Vue/Tauri imports (mirrors mapModel.ts). "Beacon" is the faros server's
// location-sharing API (see the faros repo's for_enigma.md): logged-in users
// publish one live pin, plus zones (polygons) and routes (linestrings), each
// with a MANDATORY expiry chosen by the publisher. The server filters expired
// shares out of every response and hard-deletes them shortly after.
//
// Wire safety: server responses are untrusted input like any wire object —
// every item is re-validated here and invalid entries are dropped silently.
// Wire geometry is GeoJSON ([lng, lat] order); the client model normalizes to
// the app-wide [lat, lng] convention at the validation boundary.

import { isValidLat, isValidLng, MAP_NAME_MAX_LEN } from "./mapModel";

// ── Caps (defensive receive caps; the server enforces its own) ───────────────

export const BEACON_COMMENT_MAX_LEN = 2000;
export const BEACON_MAX_POINTS = 2000;
/** Sanity ceiling for timestamps (year 2100), mirroring MAP_LOC_AT_CEILING. */
const BEACON_TS_CEILING = 4102444800000;

/** Publish TTL presets, in seconds: 15 min / 1 h / 6 h. */
export const BEACON_TTL_PRESETS = [900, 3600, 21600] as const;

// ── Types ([lat, lng] internally, unix ms timestamps) ────────────────────────

export interface BeaconPin {
  id: number;
  user: string;
  lat: number;
  lng: number;
  comment: string;
  /** Unix ms — server-set from the publisher's mandatory TTL. */
  expiresAt: number;
  createdAt: number;
  /** Present only on /beacon/near responses (great-circle metres). */
  distanceM?: number;
}

export interface BeaconZone {
  id: number;
  user: string;
  name: string;
  /** Outer ring, [lat, lng], WITHOUT the GeoJSON closing duplicate. Holes in
   *  the wire polygon are ignored (drawn as the outer ring only). */
  ring: [number, number][];
  comment: string;
  expiresAt: number;
  createdAt: number;
}

export interface BeaconRoute {
  id: number;
  user: string;
  name: string;
  /** [lat, lng] waypoints. */
  points: [number, number][];
  comment: string;
  expiresAt: number;
  createdAt: number;
}

export interface BeaconAll {
  pins: BeaconPin[];
  zones: BeaconZone[];
  routes: BeaconRoute[];
}

// ── Expiry (render decision, like isLocationLive) ────────────────────────────

/** Should this share still be drawn/listed? The server is authoritative (it
 *  never returns expired rows), but between refreshes the client culls with
 *  its own clock. */
export function isBeaconLive(expiresAt: number, now: number): boolean {
  return expiresAt > now;
}

/** Milliseconds until expiry, clamped at 0. */
export function beaconTtlLeftMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now);
}

/** Great-circle distance in metres between two [lat, lng] points (mean Earth
 *  radius; matches the server's /beacon/near math within ±0.5%). Used to turn
 *  the visible viewport into a search radius. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const phi1 = rad(aLat);
  const phi2 = rad(bLat);
  const dPhi = rad(bLat - aLat);
  const dLam = rad(bLng - aLng);
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

// ── Validation ───────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseIsoMs(x: unknown): number | null {
  if (typeof x !== "string" || x.length === 0) return null;
  const ms = Date.parse(x);
  if (!Number.isFinite(ms) || ms <= 0 || ms > BEACON_TS_CEILING) return null;
  return ms;
}

function parseId(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x > 0 ? x : null;
}

function parseUser(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 && x.length <= 150 ? x : null;
}

function parseComment(x: unknown): string {
  return typeof x === "string" ? x.slice(0, BEACON_COMMENT_MAX_LEN) : "";
}

function parseName(x: unknown): string {
  return typeof x === "string" ? x.trim().slice(0, MAP_NAME_MAX_LEN) : "";
}

/** One GeoJSON position ([lng, lat]) → [lat, lng], or null. */
function parsePosition(p: unknown): [number, number] | null {
  if (!Array.isArray(p) || p.length < 2) return null;
  const [lng, lat] = p;
  if (!isValidLat(lat) || !isValidLng(lng)) return null;
  return [lat, lng];
}

function geometryOf(x: Record<string, unknown>, type: string): Record<string, unknown> | null {
  const g = x.geometry;
  if (!isRecord(g) || g.type !== type) return null;
  return g;
}

interface CommonFields {
  id: number;
  user: string;
  comment: string;
  expiresAt: number;
  createdAt: number;
}

function parseCommon(x: Record<string, unknown>): CommonFields | null {
  const id = parseId(x.id);
  const user = parseUser(x.user);
  const expiresAt = parseIsoMs(x.expires_at);
  const createdAt = parseIsoMs(x.created_at);
  if (id === null || user === null || expiresAt === null || createdAt === null) return null;
  return { id, user, comment: parseComment(x.comment), expiresAt, createdAt };
}

/** Narrow one untrusted /beacon pin object (null = reject). */
export function validateBeaconPin(x: unknown): BeaconPin | null {
  if (!isRecord(x)) return null;
  const common = parseCommon(x);
  if (!common) return null;
  const g = geometryOf(x, "Point");
  if (!g) return null;
  const pos = parsePosition(g.coordinates);
  if (!pos) return null;
  const pin: BeaconPin = { ...common, lat: pos[0], lng: pos[1] };
  if (typeof x.distance_m === "number" && Number.isFinite(x.distance_m) && x.distance_m >= 0) {
    pin.distanceM = x.distance_m;
  }
  return pin;
}

/** Narrow one untrusted /beacon zone object. Only the outer ring is kept; the
 *  GeoJSON closing duplicate is dropped (renderers re-close). */
export function validateBeaconZone(x: unknown): BeaconZone | null {
  if (!isRecord(x)) return null;
  const common = parseCommon(x);
  if (!common) return null;
  const g = geometryOf(x, "Polygon");
  if (!g) return null;
  const rings = g.coordinates;
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const outer = rings[0];
  // A valid GeoJSON ring has >= 4 positions with first === last.
  if (!Array.isArray(outer) || outer.length < 4 || outer.length > BEACON_MAX_POINTS + 1) return null;
  const ring: [number, number][] = [];
  for (const p of outer) {
    const pos = parsePosition(p);
    if (!pos) return null;
    ring.push(pos);
  }
  const [firstLat, firstLng] = ring[0];
  const [lastLat, lastLng] = ring[ring.length - 1];
  if (firstLat !== lastLat || firstLng !== lastLng) return null;
  ring.pop();
  return { ...common, name: parseName(x.name), ring };
}

/** Narrow one untrusted /beacon route object. */
export function validateBeaconRoute(x: unknown): BeaconRoute | null {
  if (!isRecord(x)) return null;
  const common = parseCommon(x);
  if (!common) return null;
  const g = geometryOf(x, "LineString");
  if (!g) return null;
  const coords = g.coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || coords.length > BEACON_MAX_POINTS) return null;
  const points: [number, number][] = [];
  for (const p of coords) {
    const pos = parsePosition(p);
    if (!pos) return null;
    points.push(pos);
  }
  return { ...common, name: parseName(x.name), points };
}

function collect<T>(x: unknown, validate: (item: unknown) => T | null): T[] {
  if (!Array.isArray(x)) return [];
  const out: T[] = [];
  for (const item of x) {
    const v = validate(item);
    if (v) out.push(v);
  }
  return out;
}

/** Parse a GET /beacon/all response; invalid entries are dropped silently. */
export function parseBeaconAll(x: unknown): BeaconAll {
  if (!isRecord(x)) return { pins: [], zones: [], routes: [] };
  return {
    pins: collect(x.pins, validateBeaconPin),
    zones: collect(x.zones, validateBeaconZone),
    routes: collect(x.routes, validateBeaconRoute),
  };
}

/** Parse a GET /beacon/near response (pins sorted by distance server-side —
 *  the order is preserved; entries without a distance are still kept). */
export function parseBeaconNear(x: unknown): BeaconPin[] {
  if (!isRecord(x)) return [];
  return collect(x.pins, validateBeaconPin);
}
