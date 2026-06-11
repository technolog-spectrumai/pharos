// Small, framework-free GeoJSON helpers for the Locations GeoJSON editor.
// Kept separate from the Vue component so the parse/validate/naming logic is
// unit-testable without a DOM, Leaflet, or Tauri.

const GEOMETRY_TYPES = [
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
] as const;

/** True for any top-level GeoJSON object: Feature, FeatureCollection, or a Geometry. */
export function isGeoJson(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return false;
  return type === "FeatureCollection" || type === "Feature" || (GEOMETRY_TYPES as readonly string[]).includes(type);
}

export type ParseResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** Parse text into a GeoJSON object, distinguishing JSON errors from shape errors. */
export function parseGeoJson(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (!isGeoJson(data)) {
    return { ok: false, error: "Not GeoJSON — expected a Feature, FeatureCollection, or Geometry." };
  }
  return { ok: true, data };
}

/** Number of top-level features (FeatureCollection → length; Feature/Geometry → 1). */
export function featureCount(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const obj = data as { type?: string; features?: unknown[] };
  if (obj.type === "FeatureCollection") return Array.isArray(obj.features) ? obj.features.length : 0;
  if (obj.type === "Feature") return 1;
  return (GEOMETRY_TYPES as readonly string[]).includes(obj.type ?? "") ? 1 : 0;
}

/** Ensure a filename carries a .geojson/.json extension (defaults to .geojson). */
export function ensureGeojsonName(name: string): string {
  const trimmed = name.trim() || "untitled";
  return /\.(geo)?json$/i.test(trimmed) ? trimmed : `${trimmed}.geojson`;
}

/** Heuristic: does this vault file look like editable GeoJSON/JSON we can open? */
export function isGeoJsonVaultFile(file: { title: string; file_type: string }): boolean {
  const title = file.title.toLowerCase();
  return (
    title.endsWith(".geojson") ||
    title.endsWith(".json") ||
    file.file_type === "json" ||
    file.file_type === "geojson"
  );
}

/** Pretty-print GeoJSON text (2-space indent); returns the parse error if invalid. */
export function formatGeoJson(text: string): ParseResult & { text?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  return { ok: true, data, text: JSON.stringify(data, null, 2) };
}

/** A minimal starter document shown in an empty editor. */
export const SAMPLE_GEOJSON = `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "name": "Warsaw" },
      "geometry": { "type": "Point", "coordinates": [21.0122, 52.2297] }
    }
  ]
}`;
