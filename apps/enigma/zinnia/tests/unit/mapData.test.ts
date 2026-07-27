import { describe, it, expect, beforeEach } from "vitest";
import {
  listPins,
  listRegionManifests,
  removePin,
  upsertPin,
} from "../../src/services/mapData";
import type { MapPin, MapRoute } from "../../src/mapModel";

// jsdom has no Tauri runtime → localDb's localStorage backend, like the other
// service tests.
beforeEach(() => localStorage.clear());

const pin = (id: string, name = "Pin"): MapPin => ({
  id, name, lat: 52.4, lng: 16.9, createdAt: 1,
});

describe("mapData — pins", () => {
  it("starts empty", async () => {
    expect(await listPins()).toEqual([]);
  });

  it("upserts new pins to the top and updates in place", async () => {
    await upsertPin(pin("a"));
    await upsertPin(pin("b"));
    expect((await listPins()).map((p) => p.id)).toEqual(["b", "a"]);

    await upsertPin(pin("a", "Renamed"));
    const pins = await listPins();
    expect(pins.map((p) => p.id)).toEqual(["b", "a"]);
    expect(pins[1]!.name).toBe("Renamed");
  });

  it("removes by id and survives reload (persisted round-trip)", async () => {
    await upsertPin(pin("a"));
    await upsertPin(pin("b"));
    await removePin("a");
    expect((await listPins()).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("mapData — region manifests (read-only mirror)", () => {
  it("returns [] when unset or corrupt", async () => {
    expect(await listRegionManifests()).toEqual([]);
    localStorage.setItem("enigma:db:map:regions:default:", "{not json");
    expect(await listRegionManifests()).toEqual([]);
  });

  it("filters entries that fail manifest validation", async () => {
    const good = {
      id: "r1", name: "Poznań", bbox: [16.8, 52.3, 17.1, 52.5],
      minZoom: 0, maxZoom: 14, size: 10, blake3: "a".repeat(64),
      sourceUrl: "", version: 1,
    };
    localStorage.setItem(
      "enigma:db:map:regions:default:",
      JSON.stringify([good, { id: "bad" }, 42]),
    );
    const list = await listRegionManifests();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("r1");
  });
});
