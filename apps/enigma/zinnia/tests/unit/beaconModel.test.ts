import { describe, expect, it } from "vitest";

import {
  BEACON_COMMENT_MAX_LEN,
  BEACON_TTL_PRESETS,
  beaconTtlLeftMs,
  isBeaconLive,
  parseBeaconAll,
  parseBeaconNear,
  validateBeaconPin,
  validateBeaconRoute,
  validateBeaconZone,
} from "../../src/beaconModel";

const EXPIRES = "2026-07-26T19:00:00+00:00";
const CREATED = "2026-07-26T13:00:00+00:00";

function wirePin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 3,
    user: "alice",
    geometry: { type: "Point", coordinates: [21.0122, 52.2297] },
    comment: "at the market",
    expires_at: EXPIRES,
    created_at: CREATED,
    ...overrides,
  };
}

function wireZone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    user: "bob",
    name: "camp",
    geometry: {
      type: "Polygon",
      coordinates: [[[21.0, 52.2], [21.1, 52.2], [21.1, 52.3], [21.0, 52.2]]],
    },
    comment: "",
    expires_at: EXPIRES,
    created_at: CREATED,
    ...overrides,
  };
}

function wireRoute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 2,
    user: "bob",
    name: "leg 1",
    geometry: {
      type: "LineString",
      coordinates: [[21.0, 52.2], [21.05, 52.25], [21.1, 52.3]],
    },
    comment: "",
    expires_at: EXPIRES,
    created_at: CREATED,
    ...overrides,
  };
}

describe("validateBeaconPin", () => {
  it("accepts a wire pin and flips GeoJSON [lng,lat] to [lat,lng]", () => {
    const pin = validateBeaconPin(wirePin());
    expect(pin).not.toBeNull();
    expect(pin!.lat).toBeCloseTo(52.2297);
    expect(pin!.lng).toBeCloseTo(21.0122);
    expect(pin!.user).toBe("alice");
    expect(pin!.comment).toBe("at the market");
    expect(pin!.expiresAt).toBe(Date.parse(EXPIRES));
    expect(pin!.distanceM).toBeUndefined();
  });

  it("keeps distance_m from /beacon/near responses", () => {
    const pin = validateBeaconPin(wirePin({ distance_m: 1234.5 }));
    expect(pin!.distanceM).toBe(1234.5);
  });

  it("rejects hostile junk", () => {
    const cases: unknown[] = [
      null,
      42,
      "pin",
      [],
      {},
      wirePin({ id: "3" }),
      wirePin({ id: -1 }),
      wirePin({ user: "" }),
      wirePin({ expires_at: "not-a-date" }),
      wirePin({ expires_at: undefined }),
      wirePin({ created_at: undefined }),
      wirePin({ geometry: undefined }),
      wirePin({ geometry: { type: "Polygon", coordinates: [21, 52] } }),
      wirePin({ geometry: { type: "Point", coordinates: [181, 52] } }),
      wirePin({ geometry: { type: "Point", coordinates: [21, 91] } }),
      wirePin({ geometry: { type: "Point", coordinates: [21] } }),
    ];
    for (const c of cases) expect(validateBeaconPin(c), JSON.stringify(c)).toBeNull();
  });

  it("clamps an oversized comment", () => {
    const pin = validateBeaconPin(wirePin({ comment: "x".repeat(BEACON_COMMENT_MAX_LEN + 50) }));
    expect(pin!.comment).toHaveLength(BEACON_COMMENT_MAX_LEN);
  });

  it("ignores a bogus distance_m instead of rejecting", () => {
    const pin = validateBeaconPin(wirePin({ distance_m: "close" }));
    expect(pin).not.toBeNull();
    expect(pin!.distanceM).toBeUndefined();
  });
});

describe("validateBeaconZone", () => {
  it("accepts a closed ring and drops the closing duplicate", () => {
    const zone = validateBeaconZone(wireZone());
    expect(zone).not.toBeNull();
    expect(zone!.name).toBe("camp");
    expect(zone!.ring).toHaveLength(3);
    expect(zone!.ring[0]).toEqual([52.2, 21.0]);
  });

  it("ignores holes (outer ring only)", () => {
    const withHole = wireZone();
    (withHole.geometry as { coordinates: unknown[] }).coordinates = [
      [[21.0, 52.2], [21.1, 52.2], [21.1, 52.3], [21.0, 52.2]],
      [[21.02, 52.22], [21.03, 52.22], [21.03, 52.23], [21.02, 52.22]],
    ];
    const zone = validateBeaconZone(withHole);
    expect(zone!.ring).toHaveLength(3);
  });

  it("rejects open rings, short rings, and bad positions", () => {
    const open = wireZone({
      geometry: { type: "Polygon", coordinates: [[[21.0, 52.2], [21.1, 52.2], [21.1, 52.3]]] },
    });
    const short = wireZone({
      geometry: { type: "Polygon", coordinates: [[[21.0, 52.2], [21.0, 52.2]]] },
    });
    const badPos = wireZone({
      geometry: { type: "Polygon", coordinates: [[[210, 52.2], [21.1, 52.2], [21.1, 52.3], [210, 52.2]]] },
    });
    const wrongType = wireZone({ geometry: { type: "LineString", coordinates: [[21, 52], [22, 53]] } });
    for (const c of [open, short, badPos, wrongType, wireZone({ geometry: { type: "Polygon", coordinates: [] } })]) {
      expect(validateBeaconZone(c)).toBeNull();
    }
  });
});

describe("validateBeaconRoute", () => {
  it("accepts a linestring and flips coordinate order", () => {
    const route = validateBeaconRoute(wireRoute());
    expect(route).not.toBeNull();
    expect(route!.points).toHaveLength(3);
    expect(route!.points[0]).toEqual([52.2, 21.0]);
  });

  it("rejects single-point and malformed linestrings", () => {
    const single = wireRoute({ geometry: { type: "LineString", coordinates: [[21, 52]] } });
    const junk = wireRoute({ geometry: { type: "LineString", coordinates: "abc" } });
    expect(validateBeaconRoute(single)).toBeNull();
    expect(validateBeaconRoute(junk)).toBeNull();
  });
});

describe("parseBeaconAll / parseBeaconNear", () => {
  it("collects valid entries and silently drops broken ones", () => {
    const all = parseBeaconAll({
      pins: [wirePin(), wirePin({ id: "bad" }), null],
      zones: [wireZone(), 42],
      routes: [wireRoute()],
    });
    expect(all.pins).toHaveLength(1);
    expect(all.zones).toHaveLength(1);
    expect(all.routes).toHaveLength(1);
  });

  it("returns empty collections for junk payloads", () => {
    expect(parseBeaconAll(null)).toEqual({ pins: [], zones: [], routes: [] });
    expect(parseBeaconAll("nope")).toEqual({ pins: [], zones: [], routes: [] });
    expect(parseBeaconNear(undefined)).toEqual([]);
  });

  it("preserves server order for near results", () => {
    const near = parseBeaconNear({
      pins: [wirePin({ id: 1, distance_m: 5 }), wirePin({ id: 2, distance_m: 9 })],
    });
    expect(near.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe("expiry helpers", () => {
  const t = Date.parse(EXPIRES);

  it("isBeaconLive is a strict future check", () => {
    expect(isBeaconLive(t, t - 1)).toBe(true);
    expect(isBeaconLive(t, t)).toBe(false);
    expect(isBeaconLive(t, t + 1)).toBe(false);
  });

  it("beaconTtlLeftMs clamps at zero", () => {
    expect(beaconTtlLeftMs(t, t - 500)).toBe(500);
    expect(beaconTtlLeftMs(t, t + 500)).toBe(0);
  });

  it("presets are the 15m/1h/6h ladder", () => {
    expect(BEACON_TTL_PRESETS).toEqual([900, 3600, 21600]);
  });
});
