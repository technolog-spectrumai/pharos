import { describe, expect, it } from "vitest";
import {
  SHARED_LAYER_MAX_ITEMS,
  deriveSharedLayer,
  sharedItemName,
  type TimelineLike,
} from "../../src/components/map/sharedLayerModel";
import {
  MAP_LOC_TTL_MS,
  buildLocationShare,
  type MapRegionManifest,
  type MapShare,
} from "rakotis";

// The shared layer is a projection of the chat timeline — these pin what gets
// drawn, what expires, and what is out of coverage, without any Vue or store.

const NOW = 1_800_000_000_000;

const POZNAN: MapRegionManifest = {
  id: "pz", name: "Poznań", bbox: [16.8, 52.3, 17.1, 52.5],
  minZoom: 0, maxZoom: 14, size: 1024, blake3: "a".repeat(64), sourceUrl: "", version: 1,
};

function msg(id: string, share: MapShare, over: Partial<TimelineLike> = {}): TimelineLike {
  return { id, user: "Bob", self: false, map: share, ...over };
}

const PIN: MapShare = { type: "map_pin", v: 1, name: "Spot", lat: 52.4, lng: 16.9 };
const FAR_PIN: MapShare = { type: "map_pin", v: 1, name: "Far", lat: 0, lng: 0 };
const ROUTE: MapShare = {
  type: "map_route", v: 1, name: "Walk", points: [[52.4, 16.9], [52.45, 16.95]],
};

function derive(msgs: TimelineLike[], regions = [POZNAN]) {
  return deriveSharedLayer(msgs, { now: NOW, regions });
}

describe("what lands on the layer", () => {
  it("keeps pins, routes and live locations; ignores everything else", () => {
    const region: MapShare = {
      type: "map_region", v: 1, manifest: POZNAN, offerId: "o1", addr: "b32",
    };
    const items = derive([
      msg("a", PIN),
      msg("b", ROUTE),
      msg("c", buildLocationShare(52.4, 16.9, { at: NOW })),
      msg("d", region), // a download card, not an overlay
      { id: "e", user: "Bob", self: false }, // a plain text message
    ]);
    expect(items.map((i) => [i.key, i.kind])).toEqual([["a", "pin"], ["b", "route"], ["c", "loc"]]);
  });

  it("carries sender, self and the message id as the diff key", () => {
    const [mine] = derive([msg("m1", PIN, { user: "Alice", self: true })]);
    expect(mine).toMatchObject({ key: "m1", sender: "Alice", self: true });
  });

  it("shares the SAME object as message.map (reference identity)", () => {
    // The chat card's "Open in Maps" handoff finds an item by reference.
    const m = msg("m1", PIN);
    const [item] = derive([m]);
    expect(item.share).toBe(m.map);
  });

  it("dedupes by message id", () => {
    expect(derive([msg("dup", PIN), msg("dup", PIN)])).toHaveLength(1);
  });
});

describe("expiry", () => {
  it("drops a location past the TTL but keeps a fresh one", () => {
    const fresh = msg("f", buildLocationShare(52.4, 16.9, { at: NOW - 5 * 60 * 60 * 1000 }));
    const stale = msg("s", buildLocationShare(52.4, 16.9, { at: NOW - 7 * 60 * 60 * 1000 }));
    expect(derive([fresh, stale]).map((i) => i.key)).toEqual(["f"]);
  });

  it("honours the TTL boundary and a custom ttl", () => {
    const atBoundary = msg("b", buildLocationShare(52.4, 16.9, { at: NOW - MAP_LOC_TTL_MS }));
    expect(derive([atBoundary])).toHaveLength(1);
    const custom = deriveSharedLayer([atBoundary], { now: NOW, regions: [POZNAN], ttlMs: 1000 });
    expect(custom).toHaveLength(0);
  });

  it("never expires pins or routes, however old the card", () => {
    const items = deriveSharedLayer([msg("a", PIN), msg("b", ROUTE)], {
      now: NOW + 10 * 365 * 24 * 60 * 60 * 1000,
      regions: [POZNAN],
    });
    expect(items).toHaveLength(2);
  });
});

describe("coverage", () => {
  it("flags what an imported region covers", () => {
    const items = derive([msg("in", PIN), msg("out", FAR_PIN)]);
    expect(items.map((i) => [i.key, i.covered])).toEqual([["in", true], ["out", false]]);
  });

  it("a route counts as covered when any waypoint is", () => {
    const crossing: MapShare = {
      type: "map_route", v: 1, name: "Long", points: [[0, 0], [52.4, 16.9]],
    };
    expect(derive([msg("r", crossing)])[0].covered).toBe(true);
  });

  it("nothing is covered with no regions imported — items still listed", () => {
    const items = derive([msg("a", PIN), msg("b", ROUTE)], []);
    expect(items).toHaveLength(2);
    expect(items.every((i) => !i.covered)).toBe(true);
  });
});

describe("cap", () => {
  it("keeps the newest SHARED_LAYER_MAX_ITEMS", () => {
    const many = Array.from({ length: SHARED_LAYER_MAX_ITEMS + 50 }, (_, i) =>
      msg(`m${i}`, { type: "map_pin", v: 1, name: `p${i}`, lat: 52.4, lng: 16.9 }),
    );
    const items = derive(many);
    expect(items).toHaveLength(SHARED_LAYER_MAX_ITEMS);
    expect(items[0].key).toBe("m50"); // the oldest 50 dropped
    expect(items.at(-1)!.key).toBe(`m${SHARED_LAYER_MAX_ITEMS + 49}`);
  });
});

describe("sharedItemName", () => {
  it("falls back for an unlabelled location", () => {
    const [pin] = derive([msg("a", PIN)]);
    const [loc] = derive([msg("b", buildLocationShare(52.4, 16.9, { at: NOW }))]);
    const [labelled] = derive([
      msg("c", buildLocationShare(52.4, 16.9, { at: NOW, label: "Gate B" })),
    ]);
    expect(sharedItemName(pin, "Shared location")).toBe("Spot");
    expect(sharedItemName(loc, "Shared location")).toBe("Shared location");
    expect(sharedItemName(labelled, "Shared location")).toBe("Gate B");
  });
});
