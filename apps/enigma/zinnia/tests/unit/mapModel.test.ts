import { describe, it, expect } from "vitest";
import {
  MAP_NAME_MAX_LEN,
  MAP_NOTE_MAX_LEN,
  MAP_SHARE_VERSION,
  MAP_LOC_TTL_MS,
  bboxTileCount,
  bboxTileRange,
  buildLocationShare,
  buildPinShare,
  buildRegionShare,
  coveredByAny,
  isLocationLive,
  isValidBbox,
  locationAgeMs,
  lonLatToTile,
  pointInBbox,
  regionCovers,
  validateLocationShare,
  validateManifest,
  validatePinShare,
  validateRegionShare,
  type MapBbox,
  type MapPin,
  type MapRegionManifest,
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

// ── Location shares ───────────────────────────────────────────────────────────
// A shared location is deliberately its own wire type: it EXPIRES on the map,
// and an older build must drop it rather than render it as a permanent pin.

const NOW = 1_800_000_000_000;

describe("location share", () => {
  it("builds and re-validates losslessly", () => {
    const share = buildLocationShare(52.4, 16.9, { at: NOW, label: "Gate B", note: "by the kiosk" });
    expect(share).toEqual({
      type: "map_loc", v: MAP_SHARE_VERSION, lat: 52.4, lng: 16.9, at: NOW,
      label: "Gate B", note: "by the kiosk",
    });
    expect(validateLocationShare(JSON.parse(JSON.stringify(share)))).toEqual(share);
  });

  it("label and note are optional and clamped", () => {
    const bare = buildLocationShare(0, 0, { at: NOW });
    expect(bare.label).toBeUndefined();
    expect(bare.note).toBeUndefined();
    // A blank label is not a label.
    expect(buildLocationShare(0, 0, { at: NOW, label: "   " }).label).toBeUndefined();
    const long = buildLocationShare(0, 0, {
      at: NOW, label: "x".repeat(500), note: "y".repeat(2000),
    });
    expect(long.label).toHaveLength(MAP_NAME_MAX_LEN);
    expect(long.note).toHaveLength(MAP_NOTE_MAX_LEN);
  });

  it("rejects a missing or hostile `at`", () => {
    const base = { type: "map_loc", v: 1, lat: 1, lng: 2 };
    expect(validateLocationShare(base)).toBeNull();
    expect(validateLocationShare({ ...base, at: "now" })).toBeNull();
    expect(validateLocationShare({ ...base, at: Number.NaN })).toBeNull();
    expect(validateLocationShare({ ...base, at: 0 })).toBeNull();
    expect(validateLocationShare({ ...base, at: -NOW })).toBeNull();
    expect(validateLocationShare({ ...base, at: 1.5 })).toBeNull();
    expect(validateLocationShare({ ...base, at: 1e18 })).toBeNull(); // past the year-2100 ceiling
  });

  it("rejects the wrong type, version, or coordinates", () => {
    const ok = { type: "map_loc", v: 1, lat: 1, lng: 2, at: NOW };
    expect(validateLocationShare({ ...ok, type: "map_location" })).toBeNull();
    expect(validateLocationShare({ ...ok, type: "map_pin" })).toBeNull();
    expect(validateLocationShare({ ...ok, v: 2 })).toBeNull();
    expect(validateLocationShare({ ...ok, lat: 91 })).toBeNull();
    expect(validateLocationShare({ ...ok, lng: 181 })).toBeNull();
    for (const junk of [null, 42, "x", [], {}]) expect(validateLocationShare(junk)).toBeNull();
  });

  it("validation is TIME-INDEPENDENT — an expired share still validates on reload", () => {
    // chatLog re-validates every stored message on every load; a time-dependent
    // validator would drop the payload and leave an empty bubble.
    const ancient = buildLocationShare(52.4, 16.9, { at: 1 });
    expect(validateLocationShare(ancient)).toEqual(ancient);
    // ...and is live/dead purely as a render decision:
    expect(isLocationLive(ancient, NOW)).toBe(false);
  });

  it("isLocationLive honours the TTL boundaries", () => {
    const at = (offset: number) => buildLocationShare(0, 0, { at: NOW - offset });
    expect(isLocationLive(at(0), NOW)).toBe(true);
    expect(isLocationLive(at(MAP_LOC_TTL_MS), NOW)).toBe(true); // inclusive
    expect(isLocationLive(at(MAP_LOC_TTL_MS + 1), NOW)).toBe(false);
    expect(isLocationLive(at(0), NOW, 1000)).toBe(true);
    expect(isLocationLive(at(2000), NOW, 1000)).toBe(false);
  });

  it("tolerates a mildly fast peer clock but ignores a broken one", () => {
    const oneHourAhead = buildLocationShare(0, 0, { at: NOW + 60 * 60 * 1000 });
    expect(isLocationLive(oneHourAhead, NOW)).toBe(true); // fails open
    expect(locationAgeMs(oneHourAhead, NOW)).toBe(0); // never negative
    const twoDaysAhead = buildLocationShare(0, 0, { at: NOW + 48 * 60 * 60 * 1000 });
    expect(isLocationLive(twoDaysAhead, NOW)).toBe(false);
  });
});

// ── Coverage ──────────────────────────────────────────────────────────────────

describe("coverage predicates", () => {
  const POZNAN = manifest({ id: "pz", bbox: [16.8, 52.3, 17.1, 52.5] });
  const BERLIN = manifest({ id: "be", bbox: [13.0, 52.3, 13.6, 52.6] });

  it("point inside, and inclusive on every edge", () => {
    expect(pointInBbox(BBOX, 52.4, 16.9)).toBe(true);
    expect(pointInBbox(BBOX, 52.3, 16.8)).toBe(true); // south-west corner
    expect(pointInBbox(BBOX, 52.5, 17.1)).toBe(true); // north-east corner
    expect(pointInBbox(BBOX, 52.4, 16.8)).toBe(true); // west edge
    expect(pointInBbox(BBOX, 52.5, 16.9)).toBe(true); // north edge
  });

  it("point just outside each edge", () => {
    expect(pointInBbox(BBOX, 52.4, 16.79)).toBe(false);
    expect(pointInBbox(BBOX, 52.4, 17.11)).toBe(false);
    expect(pointInBbox(BBOX, 52.29, 16.9)).toBe(false);
    expect(pointInBbox(BBOX, 52.51, 16.9)).toBe(false);
  });

  it("regionCovers / coveredByAny across several regions", () => {
    expect(regionCovers(POZNAN, 52.4, 16.9)).toBe(true);
    expect(regionCovers(BERLIN, 52.4, 16.9)).toBe(false);
    expect(coveredByAny([POZNAN, BERLIN], 52.45, 13.3)).toBe(true);
    expect(coveredByAny([], 52.4, 16.9)).toBe(false); // nothing imported
  });

  it("the gap between two disjoint regions is NOT covered (the union-bbox trap)", () => {
    // map_source_info's union bbox would call this covered; per-region is right.
    expect(coveredByAny([POZNAN, BERLIN], 52.4, 15.0)).toBe(false);
  });

  it("antimeridian: no stored region can cross the seam, so no wraparound match", () => {
    expect(isValidBbox([170, -10, -170, 10])).toBe(false); // rejected at the source
    const farEast = manifest({ bbox: [179.0, -1, 180, 1] });
    expect(regionCovers(farEast, 0, 179.9)).toBe(true);
    expect(regionCovers(farEast, 0, -179.9)).toBe(false); // documented consequence
  });

});
