import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import {
  applyPalette,
  colorFor,
  DEFAULT_PALETTE,
  isHexColor,
  loadPalette,
  normalizePalette,
  PRIMARY_TEXT,
  savePalette,
  SYSTEM_ROLES,
} from "petalite/theme";

describe("the system palette", () => {
  beforeEach(() => localStorage.clear());

  it("gives every role exactly one colour", () => {
    // One value per role, not one per theme. A role that resolved differently
    // by theme would be a lie in every file that stores it.
    for (const role of SYSTEM_ROLES) {
      expect(isHexColor(DEFAULT_PALETTE[role]), role).toBe(true);
    }
  });

  it("keeps the five roles distinct", () => {
    // Two roles sharing a colour would make "warning" and "success" the same
    // mark on the page, which is worse than either being slightly off-hue.
    const values = SYSTEM_ROLES.map((r) => DEFAULT_PALETTE[r]);
    expect(new Set(values).size).toBe(values.length);
  });

  it("keeps body text out of the configurable roles", () => {
    expect(SYSTEM_ROLES).not.toContain("text");
    expect(PRIMARY_TEXT).toEqual({ light: "#000000", dark: "#ffffff" });
  });

  describe("validation", () => {
    it("accepts the two forms a colour input produces", () => {
      expect(isHexColor("#abc")).toBe(true);
      expect(isHexColor("#A1B2C3")).toBe(true);
    });

    it("refuses anything that would resolve to nothing", () => {
      // A malformed custom property does not throw — it silently yields no
      // colour, so the text renders transparent. Refusing is the loud option.
      for (const bad of ["red", "#12", "#1234567", "rgb(0,0,0)", "", "  #fff", null, 42]) {
        expect(isHexColor(bad), String(bad)).toBe(false);
      }
    });
  });

  describe("normalizing stored values", () => {
    it("fills gaps PER ROLE rather than discarding the whole palette", () => {
      // An older build's blob is missing roles added since. Throwing it away
      // would reset colours the user had deliberately set.
      const out = normalizePalette({ accent: "#010101" });
      expect(out.accent).toBe("#010101");
      expect(out.mute).toBe(DEFAULT_PALETTE.mute);
    });

    it("drops an invalid value without touching the valid ones", () => {
      const out = normalizePalette({ warning: "javascript:alert(1)", success: "#123456" });
      expect(out.warning).toBe(DEFAULT_PALETTE.warning);
      expect(out.success).toBe("#123456");
    });

    it("reads the earlier per-theme shape and takes its light value", () => {
      // That build shipped, so a browser out there holds one. Silently
      // resetting somebody's palette because the shape changed would be the
      // wrong way for them to find out.
      const out = normalizePalette({ accent: { light: "#111111", dark: "#222222" } });
      expect(out.accent).toBe("#111111");
    });

    it("survives junk in place of a palette", () => {
      for (const junk of [null, undefined, 7, "nope", []]) {
        expect(normalizePalette(junk)).toEqual(DEFAULT_PALETTE);
      }
    });
  });

  describe("persistence", () => {
    it("round-trips a saved palette", () => {
      const edited = { ...DEFAULT_PALETTE, mute: "#111111" };
      savePalette(edited);
      expect(loadPalette()).toEqual(edited);
    });

    it("falls back to defaults on unparseable storage", () => {
      localStorage.setItem("zinnia:systemColors", "{not json");
      expect(loadPalette()).toEqual(DEFAULT_PALETTE);
    });
  });

  describe("publishing to CSS", () => {
    it("writes one property per role", () => {
      const root = document.createElement("div");
      applyPalette(DEFAULT_PALETTE, root);
      for (const role of SYSTEM_ROLES) {
        expect(root.style.getPropertyValue(`--sys-${role}`)).toBe(DEFAULT_PALETTE[role]);
      }
    });

    it("writes no per-theme variants", () => {
      // The pair is gone on purpose: a role is one colour. Leftover -light /
      // -dark properties would let a stale rule resurrect the swap.
      const root = document.createElement("div");
      applyPalette(DEFAULT_PALETTE, root);
      expect(root.style.getPropertyValue("--sys-accent-light")).toBe("");
      expect(root.style.getPropertyValue("--sys-accent-dark")).toBe("");
    });
  });

  it("resolves a role to a concrete hex for consumers that store colours", () => {
    // The sketch writes literal values into the .svg it saves, so it needs the
    // value, not a var() that would mean something else in another viewer.
    expect(colorFor(DEFAULT_PALETTE, "success")).toBe(DEFAULT_PALETTE.success);
  });
});

describe("following the theme", () => {
  it("recomputes the mode when the theme changes", async () => {
    // `isDark()` reads a DOM class, which a computed cannot depend on: written
    // that way, mode caches its first answer forever and the editors keep
    // offering the outgoing theme's shades after a toggle.
    const { useSystemColors } = await import("petalite/theme");
    document.documentElement.classList.remove("dark");
    const { mode } = useSystemColors();
    expect(mode.value).toBe("light");

    document.documentElement.classList.add("dark");
    // jsdom delivers MutationObserver callbacks on a microtask.
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    expect(mode.value).toBe("dark");

    document.documentElement.classList.remove("dark");
  });
});
