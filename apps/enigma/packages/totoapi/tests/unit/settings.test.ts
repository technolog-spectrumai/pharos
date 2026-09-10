// @vitest-environment jsdom
//
// The ONE file in this package that needs a DOM, and only for `localStorage`.
// Everything else here is logic over an injected `fetchImpl` and runs in node —
// see vitest.config.ts. A per-file environment beats switching the whole
// package to jsdom for one Storage object.
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY, isFingerprint, load, normalize, save } from "../../src/platform/settings";

const KEY = "totoapi:test";

const FP = "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:"
  + "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90";

describe("what a platform-backed app remembers", () => {
  beforeEach(() => localStorage.clear());

  it("never holds a token", () => {
    // The whole point of the split. An editor opens files whose contents the
    // user did not write, so anything here should be assumed reachable by an
    // opened document — the token lives in the OS secret store, written only
    // by Rust.
    save(KEY, { server: "https://s.test", fingerprint: FP });
    const raw = localStorage.getItem(KEY)!;
    expect(raw).not.toMatch(/token/i);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["fingerprint", "server"]);
  });

  it("round-trips a server and its accepted fingerprint", () => {
    save(KEY, { server: "https://s.test", fingerprint: FP });
    expect(load(KEY)).toEqual({ server: "https://s.test", fingerprint: FP });
  });

  describe("the fingerprint", () => {
    it("accepts the shape Rust emits and openssl prints", () => {
      expect(isFingerprint(FP)).toBe(true);
      expect(isFingerprint(FP.toLowerCase())).toBe(true);
    });

    it("refuses anything that is not one", () => {
      // A malformed pin would never match a real certificate, so it would look
      // like a trusted server that constantly refuses — worse than no pin.
      for (const bad of [
        "", "AA:BB", FP.slice(3), `${FP}:AA`, FP.replace(/:/g, ""),
        "ZZ:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90",
        null, 42, {},
      ]) {
        expect(isFingerprint(bad), String(bad)).toBe(false);
      }
    });

    it("is stored uppercase, so a comparison cannot miss on case alone", () => {
      expect(normalize({ server: "https://s.test", fingerprint: FP.toLowerCase() }).fingerprint)
        .toBe(FP);
    });
  });

  describe("normalizing a stored record", () => {
    it("keeps a good field when its neighbour is bad", () => {
      // Per field, never all-or-nothing: discarding the record to repair one
      // absent value would sign the user out for no reason.
      expect(normalize({ server: "https://s.test", fingerprint: "junk" }))
        .toEqual({ server: "https://s.test", fingerprint: "" });
      expect(normalize({ fingerprint: FP }))
        .toEqual({ server: "", fingerprint: FP });
    });

    it("survives junk in place of a record", () => {
      for (const junk of [null, undefined, 7, "nope", []]) {
        expect(normalize(junk)).toEqual(EMPTY);
      }
    });

    it("falls back to empty on unparseable storage", () => {
      localStorage.setItem(KEY, "{not json");
      expect(load(KEY)).toEqual(EMPTY);
    });
  });

  it("does not normalise the server address itself", () => {
    // Rust owns that rule — the normalised URL is the key the token is filed
    // under, and a second normalizer here that drifted would orphan the
    // credential while leaving it on disk.
    expect(normalize({ server: "https://S.TEST/x/" }).server).toBe("https://S.TEST/x/");
  });
});

describe("the key is per app", () => {
  beforeEach(() => localStorage.clear());

  it("two apps pointed at two servers do not overwrite each other", () => {
    // py_editor and tex_editor are separate bundles a person may point at
    // different servers. One shared constant — which is what this was in
    // limbo — would make signing one in silently move the other.
    save("totoapi:py", { server: "https://one.test", fingerprint: "" });
    save("totoapi:tex", { server: "https://two.test", fingerprint: "" });
    expect(load("totoapi:py").server).toBe("https://one.test");
    expect(load("totoapi:tex").server).toBe("https://two.test");
  });

  it("an unknown key reads as empty rather than throwing", () => {
    expect(load("totoapi:never-written")).toEqual(EMPTY);
  });
});
