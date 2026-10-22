// The build-feature list has one owner — `[features]` in src-tauri/Cargo.toml —
// and three readers: the Rust code (`#[cfg(feature = "…")]`), the build driver
// (which validates a config against it) and the bundler (buildFeatures.ts).
// These tests hold the frontend's reading of it in step.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogue, featureDefines } from "../../buildFeatures";

describe("the build-feature catalogue", () => {
  it("is read from Cargo.toml, without `default`", () => {
    const ids = catalogue();
    expect(ids).toContain("calendar");
    expect(ids).toContain("hosted_relays");
    expect(ids).not.toContain("default");
  });

  it("has a declared literal for every feature, and no stray ones", () => {
    // A feature added to Cargo.toml without its `declare const` would be a
    // type error only where it is first used; one removed would leave a
    // declaration for a literal the bundler never defines — a ReferenceError
    // at run time. Neither should wait to be found that way.
    const dts = readFileSync("src/vite-env.d.ts", "utf8");
    const declared = [...dts.matchAll(/^declare const (__FEATURE_[A-Z0-9_]+__): boolean;$/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(featureDefines(undefined)).sort());
  });
});

describe("turning ENIGMA_FEATURES into literals", () => {
  it("unset means every feature — the dev server, vitest and Playwright see the whole app", () => {
    expect(new Set(Object.values(featureDefines(undefined)))).toEqual(new Set(["true"]));
  });

  it("set means exactly that list", () => {
    const defs = featureDefines("hosted_relays,contacts");
    expect(defs.__FEATURE_HOSTED_RELAYS__).toBe("true");
    expect(defs.__FEATURE_CONTACTS__).toBe("true");
    expect(defs.__FEATURE_CALENDAR__).toBe("false");
    expect(defs.__FEATURE_CALLS__).toBe("false");
  });

  it("the empty string means none — not 'unset'", () => {
    expect(new Set(Object.values(featureDefines("")))).toEqual(new Set(["false"]));
  });

  it("refuses an id the catalogue does not have", () => {
    expect(() => featureDefines("calls,callz")).toThrow(/unknown feature\(s\) callz/);
  });
});
