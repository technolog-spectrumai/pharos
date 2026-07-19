import { describe, it, expect } from "vitest";
import {
  MAP_NAME_MAX_LEN,
  MAP_NOTE_MAX_LEN,
  MAP_ROUTE_MAX_POINTS,
  MAP_SHARE_VERSION,
  bboxTileCount,
  bboxTileRange,
  buildPinShare,
  buildRegionShare,
  buildRouteShare,
  isValidBbox,
  lonLatToTile,
  validateManifest,
  validatePinShare,
  validateRegionShare,
  validateRouteShare,
  type MapBbox,
  type MapPin,
  type MapRegionManifest,
  type MapRoute,
} from "../../src/mapModel";

const BBOX: MapBbox = [16.8, 52.3, 17.1, 52.5]; // Poznań-ish
const HEX64 = "a".repeat(64);

function manifest(overrides: Partial<MapRegionManifest> = {}): MapRegionManifest {
  return {
    id: "r1",
    name: "Poznań",
    bbox: BBOX,
    minZoom: 0,
    maxZoom: 14,
    size: 1234,
    blake3: HEX64,
    sourceUrl: "https://example.org/planet.pmtiles",
    version: 1,
    ...overrides,
  };
}

describe("mapModel — manifest validation", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(manifest())).toEqual(manifest());
  });

  it("accepts empty sourceUrl (manual import)", () => {
    expect(validateManifest(manifest({ sourceUrl: "" }))).not.toBeNull();
  });

  it("rejects hostile junk", () => {
    for (const junk of [null, undefined, 42, "x", [], {}, { id: "a" }]) {
      expect(validateManifest(junk)).toBeNull();
    }
  });

  it("rejects wrong version", () => {
    expect(validateManifest({ ...manifest(), version: 2 })).toBeNull();
    expect(validateManifest({ ...manifest(), version: "1" })).toBeNull();
  });

  it("rejects bad blake3 (uppercase, short, non-hex)", () => {
    expect(validateManifest(manifest({ blake3: HEX64.toUpperCase() }))).toBeNull();
    expect(validateManifest(manifest({ blake3: "abc" }))).toBeNull();
    expect(validateManifest(manifest({ blake3: "z".repeat(64) }))).toBeNull();
  });

  it("rejects bad bbox (swapped, out of range, antimeridian)", () => {
    expect(validateManifest(manifest({ bbox: [17.1, 52.3, 16.8, 52.5] }))).toBeNull();
    expect(validateManifest(manifest({ bbox: [16.8, 52.5, 17.1, 52.3] }))).toBeNull();
    expect(validateManifest(manifest({ bbox: [-190, 52.3, 17.1, 52.5] }))).toBeNull();
    expect(validateManifest(manifest({ bbox: [170, -10, -170, 10] }))).toBeNull(); // crosses antimeridian
  });

  it("rejects bad zooms and sizes", () => {
    expect(validateManifest(manifest({ minZoom: 15, maxZoom: 14 }))).toBeNull();
    expect(validateManifest(manifest({ maxZoom: 23 }))).toBeNull();
    expect(validateManifest(manifest({ minZoom: 1.5 }))).toBeNull();
    expect(validateManifest(manifest({ size: 0 }))).toBeNull();
    expect(validateManifest(manifest({ size: -1 }))).toBeNull();
  });

  it("rejects oversized names and trims", () => {
    expect(validateManifest(manifest({ name: "x".repeat(MAP_NAME_MAX_LEN + 1) }))).toBeNull();
    expect(validateManifest(manifest({ name: "  " }))).toBeNull();
    expect(validateManifest(manifest({ name: "  ok  " }))?.name).toBe("ok");
  });
});

describe("mapModel — pin share", () => {
  const pin: MapPin = { id: "p1", name: "Meet here", lat: 52.4, lng: 16.9, createdAt: 1 };

  it("build → validate roundtrip", () => {
    const share = buildPinShare({ ...pin, color: "#ff0000", note: "back door" });
    expect(validatePinShare(share)).toEqual(share);
    expect(share.v).toBe(MAP_SHARE_VERSION);
  });

  it("strips local-only fields (id, createdAt)", () => {
    const share = buildPinShare(pin) as unknown as Record<string, unknown>;
    expect(share.id).toBeUndefined();
    expect(share.createdAt).toBeUndefined();
  });

  it("rejects out-of-range coordinates", () => {
    expect(validatePinShare({ type: "map_pin", v: 1, name: "x", lat: 91, lng: 0 })).toBeNull();
    expect(validatePinShare({ type: "map_pin", v: 1, name: "x", lat: 0, lng: -181 })).toBeNull();
    expect(validatePinShare({ type: "map_pin", v: 1, name: "x", lat: NaN, lng: 0 })).toBeNull();
  });

  it("drops invalid colors, clamps oversized notes", () => {
    const v = validatePinShare({
      type: "map_pin", v: 1, name: "x", lat: 1, lng: 2,
      color: "red", note: "n".repeat(MAP_NOTE_MAX_LEN + 50),
    });
    expect(v?.color).toBeUndefined();
    expect(v?.note?.length).toBe(MAP_NOTE_MAX_LEN);
  });

  it("rejects wrong type/version", () => {
    expect(validatePinShare({ type: "map_route", v: 1, name: "x", lat: 1, lng: 2 })).toBeNull();
    expect(validatePinShare({ type: "map_pin", v: 2, name: "x", lat: 1, lng: 2 })).toBeNull();
  });
});

describe("mapModel — route share", () => {
  const route: MapRoute = {
    id: "r1", name: "Loop", points: [[52.4, 16.9], [52.41, 16.91], [52.42, 16.92]], createdAt: 1,
  };

  it("build → validate roundtrip", () => {
    const share = buildRouteShare(route);
    expect(validateRouteShare(share)).toEqual(share);
  });

  it("rejects too few / too many / malformed points", () => {
    const base = { type: "map_route", v: 1, name: "x" };
    expect(validateRouteShare({ ...base, points: [[1, 2]] })).toBeNull();
    expect(
      validateRouteShare({ ...base, points: Array(MAP_ROUTE_MAX_POINTS + 1).fill([1, 2]) }),
    ).toBeNull();
    expect(validateRouteShare({ ...base, points: [[1, 2], [91, 0]] })).toBeNull();
    expect(validateRouteShare({ ...base, points: [[1, 2], [3]] })).toBeNull();
    expect(validateRouteShare({ ...base, points: "nope" })).toBeNull();
  });
});

describe("mapModel — region share", () => {
  it("build → validate roundtrip", () => {
    const share = buildRegionShare(manifest(), "offer-1", "addr-base32");
    expect(validateRegionShare(share)).toEqual(share);
  });

  it("rejects invalid inner manifest and missing handles", () => {
    const good = buildRegionShare(manifest(), "offer-1", "addr");
    expect(validateRegionShare({ ...good, manifest: { nope: true } })).toBeNull();
    expect(validateRegionShare({ ...good, offerId: "" })).toBeNull();
    expect(validateRegionShare({ ...good, addr: "" })).toBeNull();
  });
});

describe("mapModel — tile math", () => {
  it("z0 is always tile (0,0)", () => {
    expect(lonLatToTile(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(lonLatToTile(-179.9, 84, 0)).toEqual({ x: 0, y: 0 });
  });

  it("known point: Poznań at z10", () => {
    // lon 16.9 → floor((16.9+180)/360 * 1024) = 560
    // lat 52.4 → floor((1 - asinh(tan 52.4°)/π)/2 * 1024) = 336
    const t = lonLatToTile(16.9, 52.4, 10);
    expect(t.x).toBe(560);
    expect(t.y).toBe(336);
  });

  it("clamps polar latitudes into the Mercator range", () => {
    const n = lonLatToTile(0, 89.9, 4);
    const s = lonLatToTile(0, -89.9, 4);
    expect(n.y).toBe(0);
    expect(s.y).toBe(15);
  });

  it("bbox range is inclusive and ordered", () => {
    const r = bboxTileRange(BBOX, 10);
    expect(r.xMin).toBeLessThanOrEqual(r.xMax);
    expect(r.yMin).toBeLessThanOrEqual(r.yMax);
  });

  it("tile count sums across zooms and grows with zoom", () => {
    expect(bboxTileCount(BBOX, 0, 0)).toBe(1);
    const shallow = bboxTileCount(BBOX, 0, 8);
    const deep = bboxTileCount(BBOX, 0, 12);
    expect(deep).toBeGreaterThan(shallow);
  });

  it("isValidBbox accepts the fixture and rejects reversed boxes", () => {
    expect(isValidBbox(BBOX)).toBe(true);
    expect(isValidBbox([17.1, 52.3, 16.8, 52.5])).toBe(false);
  });
});
