// Map data — per-profile pins and region manifests in the encrypted
// kv store (same single-JSON-array-per-key pattern as `contacts` / `p2p:rooms`;
// the kv API has no key enumeration by design).
//
// Coordinates persist ONLY here (sealed at rest by protasius) — never in
// filenames, logs, or plaintext files. Region manifests are WRITTEN by the
// Rust map_* commands (download/import/remove own the blob lifecycle); this
// module only reads them. Pins are owned here.

import { kvGet, kvPut } from "./localDb";
import type { MapPin, MapRegionManifest } from "../mapModel";
import { validateManifest } from "../mapModel";

const SCOPE = "default";
const KEY = "";
const NS_PINS = "map:pins";
const NS_REGIONS = "map:regions";

async function readList<T>(ns: string): Promise<T[]> {
  try {
    const raw = await kvGet(ns, SCOPE, KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function persist(ns: string, list: unknown[]): Promise<void> {
  await kvPut(ns, SCOPE, KEY, JSON.stringify(list)).catch(() => {});
}

// ── Pins ──────────────────────────────────────────────────────────────────────

export async function listPins(): Promise<MapPin[]> {
  return readList<MapPin>(NS_PINS);
}

/** Add or update (by id); new pins go to the top. Returns the new list. */
export async function upsertPin(pin: MapPin): Promise<MapPin[]> {
  const pins = await listPins();
  const i = pins.findIndex((p) => p.id === pin.id);
  if (i === -1) pins.unshift(pin);
  else pins[i] = { ...pins[i], ...pin };
  await persist(NS_PINS, pins);
  return pins;
}

export async function removePin(id: string): Promise<MapPin[]> {
  const pins = (await listPins()).filter((p) => p.id !== id);
  await persist(NS_PINS, pins);
  return pins;
}


// ── Region manifests (read-only mirror of what the Rust side maintains) ───────

export async function listRegionManifests(): Promise<MapRegionManifest[]> {
  const raw = await readList<unknown>(NS_REGIONS);
  return raw
    .map((m) => validateManifest(m))
    .filter((m): m is MapRegionManifest => m !== null);
}
