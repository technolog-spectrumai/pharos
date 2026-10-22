// The five system colours: what counts as a colour, how a stored palette is
// read back, and how it is published.
//
// The palette is data an app SAVES — the sketch writes these hex values into
// its files — so the read-back is pinned hardest: a stored palette from any
// build that shipped must come back as the colours the user set, and nothing
// malformed may reach a custom property, where it would fail silently.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPalette,
  colorFor,
  DEFAULT_PALETTE,
  isHexColor,
  loadPalette,
  normalizePalette,
  savePalette,
  SYSTEM_ROLES,
  type SystemPalette,
} from "../../src/theme/systemColors";

const KEY = "zinnia:systemColors";

/** A `localStorage` with nothing behind it but a Map — this suite runs in
 *  node, and the palette needs only the two calls. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const custom: SystemPalette = {
  accent: "#112233",
  warning: "#abc",
  success: "#00FF00",
  highlight: "#fedcba",
  mute: "#999",
};

describe("what counts as a colour", () => {
  it.each(["#abc", "#ABC", "#a1b2c3", "#A1B2C3"])("accepts %s", (value) => {
    expect(isHexColor(value)).toBe(true);
  });

  it.each([
    ["a name", "red"],
    ["no hash", "abcdef"],
    ["four digits", "#abcd"],
    ["eight digits", "#aabbccdd"],
    ["a non-hex digit", "#abcdeg"],
    ["surrounding space", " #abc "],
    ["an empty string", ""],
    ["a number", 0xabcdef],
    ["null", null],
    ["an object", { light: "#abc" }],
  ])("refuses %s", (_label, value) => {
    // Coercing would publish something CSS resolves to nothing, which shows
    // as transparent text rather than as an error anyone can see.
    expect(isHexColor(value)).toBe(false);
  });
});

describe("reading a stored palette back", () => {
  it("uses the defaults for nothing stored", () => {
    expect(normalizePalette(null)).toEqual(DEFAULT_PALETTE);
    expect(normalizePalette(undefined)).toEqual(DEFAULT_PALETTE);
  });

  it("keeps every role the user set", () => {
    expect(normalizePalette(custom)).toEqual(custom);
  });

  it("fills a missing role from the defaults without discarding the rest", () => {
    // A blob from an older build lacks the roles added since. Throwing the
    // whole thing away to repair one field would reset colours on purpose.
    const older = { accent: "#123456", warning: "#654321" };
    expect(normalizePalette(older)).toEqual({
      ...DEFAULT_PALETTE,
      accent: "#123456",
      warning: "#654321",
    });
  });

  it("replaces a malformed role with its default, one role at a time", () => {
    expect(normalizePalette({ ...custom, success: "green", mute: 42 })).toEqual({
      ...custom,
      success: DEFAULT_PALETTE.success,
      mute: DEFAULT_PALETTE.mute,
    });
  });

  it("reads the earlier light-and-dark shape by taking the light value", () => {
    // That build shipped, so somebody's browser still holds `{light, dark}`.
    const legacy = {
      accent: { light: "#010203", dark: "#fefefe" },
      warning: "#ff0000",
    };
    const palette = normalizePalette(legacy);
    expect(palette.accent).toBe("#010203");
    expect(palette.warning).toBe("#ff0000");
  });

  it("falls back to the default when the earlier shape's light value is malformed", () => {
    expect(normalizePalette({ accent: { light: "blue", dark: "#000" } }).accent).toBe(DEFAULT_PALETTE.accent);
    expect(normalizePalette({ accent: { dark: "#000" } }).accent).toBe(DEFAULT_PALETTE.accent);
  });

  it("ignores stored junk that is not an object of roles", () => {
    expect(normalizePalette("#ffffff")).toEqual(DEFAULT_PALETTE);
    expect(normalizePalette(["#ffffff"])).toEqual(DEFAULT_PALETTE);
  });

  it("hands back a fresh object, never the defaults themselves", () => {
    // Editing the palette a caller was given must not rewrite the defaults
    // that every later reset copies.
    const palette = normalizePalette(null);
    palette.accent = "#000000";
    expect(DEFAULT_PALETTE.accent).toBe("#3b82f6");
  });

  it("answers exactly the five roles and nothing it was not asked about", () => {
    const palette = normalizePalette({ ...custom, sparkle: "#ffffff" });
    expect(Object.keys(palette).sort()).toEqual([...SYSTEM_ROLES].sort());
  });
});

describe("loading and saving", () => {
  it("round-trips a palette through storage", () => {
    savePalette(custom);
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual(custom);
    expect(loadPalette()).toEqual(custom);
  });

  it("loads the defaults on a first run", () => {
    expect(loadPalette()).toEqual(DEFAULT_PALETTE);
  });

  it("loads the defaults when the stored text is not JSON", () => {
    // Not worth failing a launch over: the defaults are a complete palette.
    storage.data.set(KEY, "{not json");
    expect(loadPalette()).toEqual(DEFAULT_PALETTE);
  });

  it("merges a partial stored palette over the defaults", () => {
    storage.data.set(KEY, JSON.stringify({ highlight: "#0f0f0f" }));
    expect(loadPalette()).toEqual({ ...DEFAULT_PALETTE, highlight: "#0f0f0f" });
  });

  it("loads the defaults when storage cannot be read at all", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: storage is disabled");
      },
    });
    expect(loadPalette()).toEqual(DEFAULT_PALETTE);
  });

  it("does not throw when storage refuses the write", () => {
    // A full or blocked store must not break the editor mid-session.
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => savePalette(custom)).not.toThrow();
  });
});

describe("publishing the palette", () => {
  it("sets one custom property per role on the element it is given", () => {
    const published = new Map<string, string>();
    const root = { style: { setProperty: (name: string, value: string) => published.set(name, value) } };

    applyPalette(custom, root as unknown as HTMLElement);

    expect(Object.fromEntries(published)).toEqual({
      "--sys-accent": "#112233",
      "--sys-warning": "#abc",
      "--sys-success": "#00FF00",
      "--sys-highlight": "#fedcba",
      "--sys-mute": "#999",
    });
  });

  it("answers the concrete hex for a role, for consumers that store it", () => {
    expect(colorFor(custom, "highlight")).toBe("#fedcba");
    expect(colorFor(DEFAULT_PALETTE, "warning")).toBe("#ef4444");
  });
});
