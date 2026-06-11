import { describe, it, expect } from "vitest";
import {
  isGeoJson,
  parseGeoJson,
  featureCount,
  ensureGeojsonName,
  isGeoJsonVaultFile,
  formatGeoJson,
  SAMPLE_GEOJSON,
} from "../../src/lib/geojson";

const POINT = { type: "Point", coordinates: [21, 52] };
const FEATURE = { type: "Feature", properties: {}, geometry: POINT };
const FC = { type: "FeatureCollection", features: [FEATURE, FEATURE] };

describe("isGeoJson", () => {
  it("accepts FeatureCollection, Feature, and bare geometries", () => {
    expect(isGeoJson(FC)).toBe(true);
    expect(isGeoJson(FEATURE)).toBe(true);
    expect(isGeoJson(POINT)).toBe(true);
    expect(isGeoJson({ type: "Polygon", coordinates: [] })).toBe(true);
  });
  it("rejects non-GeoJSON objects and primitives", () => {
    expect(isGeoJson({ type: "Banana" })).toBe(false);
    expect(isGeoJson({ foo: 1 })).toBe(false);
    expect(isGeoJson(null)).toBe(false);
    expect(isGeoJson("Point")).toBe(false);
  });
});

describe("parseGeoJson", () => {
  it("parses valid GeoJSON text", () => {
    const res = parseGeoJson(JSON.stringify(FC));
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as any).type).toBe("FeatureCollection");
  });
  it("reports a JSON syntax error distinctly", () => {
    const res = parseGeoJson("{ not json ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Invalid JSON/);
  });
  it("reports a shape error for valid JSON that isn't GeoJSON", () => {
    const res = parseGeoJson(JSON.stringify({ hello: "world" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Not GeoJSON/);
  });
  it("accepts the bundled sample document", () => {
    expect(parseGeoJson(SAMPLE_GEOJSON).ok).toBe(true);
  });
});

describe("featureCount", () => {
  it("counts FeatureCollection members", () => {
    expect(featureCount(FC)).toBe(2);
  });
  it("treats a lone Feature or Geometry as one", () => {
    expect(featureCount(FEATURE)).toBe(1);
    expect(featureCount(POINT)).toBe(1);
  });
  it("is zero for non-GeoJSON", () => {
    expect(featureCount({ type: "Nope" })).toBe(0);
    expect(featureCount(null)).toBe(0);
  });
});

describe("ensureGeojsonName", () => {
  it("keeps an existing .geojson / .json extension", () => {
    expect(ensureGeojsonName("zones.geojson")).toBe("zones.geojson");
    expect(ensureGeojsonName("data.JSON")).toBe("data.JSON");
  });
  it("appends .geojson when missing", () => {
    expect(ensureGeojsonName("zones")).toBe("zones.geojson");
  });
  it("falls back to a default for blank input", () => {
    expect(ensureGeojsonName("   ")).toBe("untitled.geojson");
  });
});

describe("isGeoJsonVaultFile", () => {
  it("matches by extension or json file_type", () => {
    expect(isGeoJsonVaultFile({ title: "borders.geojson", file_type: "default" })).toBe(true);
    expect(isGeoJsonVaultFile({ title: "x.json", file_type: "default" })).toBe(true);
    expect(isGeoJsonVaultFile({ title: "data", file_type: "json" })).toBe(true);
  });
  it("ignores unrelated files", () => {
    expect(isGeoJsonVaultFile({ title: "photo.png", file_type: "image" })).toBe(false);
  });
});

describe("formatGeoJson", () => {
  it("pretty-prints valid input with 2-space indent", () => {
    const res = formatGeoJson(JSON.stringify(FEATURE));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('\n  "type": "Feature"');
      // It must still be the same document.
      expect(JSON.parse(res.text!)).toEqual(FEATURE);
    }
  });
  it("returns the parse error for invalid JSON", () => {
    const res = formatGeoJson("{bad");
    expect(res.ok).toBe(false);
  });
});
