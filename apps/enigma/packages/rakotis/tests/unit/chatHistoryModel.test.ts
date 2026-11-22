import { describe, expect, it } from "vitest";
import { isMapShareType, MAP_SHARE_TYPES, validatePersistedMessage } from "../../src/chatHistoryModel";

// Maps left the app (2026-10-03), but the three message types the Map tab put
// in a room are in stored histories and can still arrive from a peer on an
// older build. What is held here: such a message survives a reload as a card
// (so a history does not silently lose entries), and its payload — a pin's
// coordinates, a region's transfer address — is neither read nor stored.

const BASE = { id: "m1", user: "alice", content: "", encrypted: true, ts: 1700000000000 };

describe("a map share in a stored history", () => {
  it("is kept, by type, for each kind the Map tab sent", () => {
    for (const type of MAP_SHARE_TYPES) {
      expect(validatePersistedMessage({ ...BASE, type })).toEqual({ ...BASE, type });
    }
  });

  it("drops the payload it used to carry", () => {
    const stored = {
      ...BASE, type: "map_pin",
      map: { type: "map_pin", v: 1, name: "Meet here", lat: 52.4, lng: 16.9, note: "back door" },
    };
    const kept = validatePersistedMessage(stored)!;
    expect(kept.type).toBe("map_pin");
    expect("map" in kept).toBe(false);
    expect(JSON.stringify(kept)).not.toContain("52.4");
  });

  it("is told apart from every other type", () => {
    expect(MAP_SHARE_TYPES.every(isMapShareType)).toBe(true);
    for (const other of ["mls_app", "map_", "map_route", "MAP_PIN", "", 7, null, undefined]) {
      expect(isMapShareType(other), String(other)).toBe(false);
    }
  });

  it("does not open the door to an unknown map_ type", () => {
    expect(validatePersistedMessage({ ...BASE, type: "map_route" })).toBeNull();
  });
});
