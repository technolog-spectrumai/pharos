import { beforeEach, describe, expect, it } from "vitest";
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
} from "../../src/systemColors";

describe("the system palette", () => {
  beforeEach(() => localStorage.clear());

  it("defines both modes for every role", () => {
    for (const role of SYSTEM_ROLES) {
      expect(isHexColor(DEFAULT_PALETTE[role].light), `${role} light`).toBe(true);
      expect(isHexColor(DEFAULT_PALETTE[role].dark), `${role} dark`).toBe(true);
    }
  });

  it("gives each role a DIFFERENT value per mode where it matters", () => {
    // Not a style rule — the point of the pair. A role whose two values were
    // identical would be unreadable on one of the two papers, which is the
    // whole reason the palette is not a single set of five.
    for (const role of SYSTEM_ROLES) {
      expect(DEFAULT_PALETTE[role].light, role).not.toBe(DEFAULT_PALETTE[role].dark);
    }
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
    it("fills gaps PER FIELD rather than discarding the whole palette", () => {
      // An older build's blob is missing roles added since. Throwing it away
      // would reset colours the user had deliberately set.
      const partial = { accent: { light: "#010101" } };
      const out = normalizePalette(partial);
      expect(out.accent.light).toBe("#010101");
      expect(out.accent.dark).toBe(DEFAULT_PALETTE.accent.dark);
      expect(out.mute).toEqual(DEFAULT_PALETTE.mute);
    });

    it("drops individual invalid values without touching the valid ones", () => {
      const out = normalizePalette({ warning: { light: "javascript:alert(1)", dark: "#123456" } });
      expect(out.warning.light).toBe(DEFAULT_PALETTE.warning.light);
      expect(out.warning.dark).toBe("#123456");
    });

    it("survives junk in place of a palette", () => {
      for (const junk of [null, undefined, 7, "nope", []]) {
        expect(normalizePalette(junk)).toEqual(DEFAULT_PALETTE);
      }
    });
  });

  describe("persistence", () => {
    it("round-trips a saved palette", () => {
      const edited = { ...DEFAULT_PALETTE, mute: { light: "#111111", dark: "#eeeeee" } };
      savePalette(edited);
      expect(loadPalette()).toEqual(edited);
    });

    it("falls back to defaults on unparseable storage", () => {
      localStorage.setItem("zinnia:systemColors", "{not json");
      expect(loadPalette()).toEqual(DEFAULT_PALETTE);
    });
  });

  describe("publishing to CSS", () => {
    it("writes BOTH modes' values, so the .dark rule can do the swap", () => {
      const root = document.createElement("div");
      applyPalette(DEFAULT_PALETTE, root);
      for (const role of SYSTEM_ROLES) {
        expect(root.style.getPropertyValue(`--sys-${role}-light`)).toBe(DEFAULT_PALETTE[role].light);
        expect(root.style.getPropertyValue(`--sys-${role}-dark`)).toBe(DEFAULT_PALETTE[role].dark);
      }
    });

    it("does not write a bare --sys-<role>", () => {
      // That one is defined in style.css as an alias of the pair. Writing it
      // from JS too would pin it to one mode and break the theme swap.
      const root = document.createElement("div");
      applyPalette(DEFAULT_PALETTE, root);
      expect(root.style.getPropertyValue("--sys-accent")).toBe("");
    });
  });

  it("resolves a role to a concrete hex for consumers that store colours", () => {
    // The sketch writes literal values into the .svg it saves, so it needs the
    // value, not a var() that would mean something else in another viewer.
    expect(colorFor(DEFAULT_PALETTE, "success", "dark")).toBe(DEFAULT_PALETTE.success.dark);
  });
});
