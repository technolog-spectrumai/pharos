// @vitest-environment jsdom
//
// The live palette: one for the whole app, published as custom properties.
//
// The import itself is under test. The properties must exist before the first
// paint — a writer whose inks resolve to nothing for a frame flashes
// transparent text — so loading the module, not calling anything, is what
// publishes them. Each test therefore re-imports into a fresh module graph.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PALETTE } from "../../src/theme/systemColors";

const KEY = "zinnia:systemColors";
const html = () => document.documentElement;
const published = (role: string) => html().style.getPropertyValue(`--sys-${role}`);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function load() {
  return import("../../src/theme/useSystemColors");
}

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute("style");
  html().className = "";
  vi.resetModules();
});

afterEach(() => {
  html().removeAttribute("style");
  html().className = "";
});

describe("on import", () => {
  it("publishes the defaults on a first run", async () => {
    await load();
    expect(published("accent")).toBe(DEFAULT_PALETTE.accent);
    expect(published("warning")).toBe(DEFAULT_PALETTE.warning);
    expect(published("mute")).toBe(DEFAULT_PALETTE.mute);
  });

  it("publishes the stored palette before anything asks for it", async () => {
    localStorage.setItem(KEY, JSON.stringify({ accent: "#123456", success: "#0a0b0c" }));
    await load();
    expect(published("accent")).toBe("#123456");
    expect(published("success")).toBe("#0a0b0c");
    expect(published("highlight")).toBe(DEFAULT_PALETTE.highlight);
  });
});

describe("changing a colour", () => {
  it("changes one role, publishes it, and remembers it", async () => {
    const { useSystemColors } = await load();
    const colors = useSystemColors();

    colors.set("warning", "#aa0000");

    expect(colors.palette.value).toEqual({ ...DEFAULT_PALETTE, warning: "#aa0000" });
    expect(published("warning")).toBe("#aa0000");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ ...DEFAULT_PALETTE, warning: "#aa0000" });
  });

  it("is seen by every caller, because there is one palette", async () => {
    // Settings and the editors each call the composable; neither owns the
    // palette, and a change made in one must be what the other draws with.
    const { useSystemColors } = await load();
    const settings = useSystemColors();
    const sketch = useSystemColors();

    settings.set("highlight", "#ffee00");

    expect(sketch.palette.value.highlight).toBe("#ffee00");
  });

  it("survives a reload: what was set is what the next launch publishes", async () => {
    const first = await load();
    first.useSystemColors().set("accent", "#0f0f0f");

    vi.resetModules();
    html().removeAttribute("style");
    const second = await load();

    expect(second.useSystemColors().palette.value.accent).toBe("#0f0f0f");
    expect(published("accent")).toBe("#0f0f0f");
  });

  it("resets every role to the defaults, published and remembered", async () => {
    localStorage.setItem(KEY, JSON.stringify({ accent: "#123456", mute: "#654321" }));
    const { useSystemColors } = await load();
    const colors = useSystemColors();

    colors.reset();

    expect(colors.palette.value).toEqual(DEFAULT_PALETTE);
    expect(published("accent")).toBe(DEFAULT_PALETTE.accent);
    expect(published("mute")).toBe(DEFAULT_PALETTE.mute);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(DEFAULT_PALETTE);
  });

  it("keeps working for the session when storage refuses the write", async () => {
    const { useSystemColors } = await load();
    const colors = useSystemColors();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => colors.set("success", "#00aa00")).not.toThrow();
    expect(published("success")).toBe("#00aa00");
    expect(colors.palette.value.success).toBe("#00aa00");
    // The write really was refused: nothing reached the store.
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(KEY)).toBeNull();
    setItem.mockRestore();
  });
});

describe("the mode", () => {
  it("follows the theme class, while no role changes with it", async () => {
    // Plain text and the paper are mode-dependent; the five roles are one
    // value each, so a theme switch must leave every published role alone.
    const { useSystemColors } = await load();
    const colors = useSystemColors();
    expect(colors.mode.value).toBe("light");

    html().classList.add("dark");
    await settle();

    expect(colors.mode.value).toBe("dark");
    expect(published("accent")).toBe(DEFAULT_PALETTE.accent);
    expect(colors.palette.value).toEqual(DEFAULT_PALETTE);
  });
});
