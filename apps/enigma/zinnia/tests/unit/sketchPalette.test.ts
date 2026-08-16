import { describe, expect, it } from "vitest";
import { COLOR_ROLES, DEFAULT_INK, NEUTRALS, offeredColors } from "../../src/sketch/sketchPalette";
import { DEFAULT_PALETTE, SYSTEM_ROLES } from "../../src/systemColors";

describe("the sketch palette", () => {
  it("is the system roles plus two fixed neutrals, and nothing else", () => {
    const offered = offeredColors(DEFAULT_PALETTE);
    expect(offered).toHaveLength(SYSTEM_ROLES.length + 2);
    expect(offered.map((o) => o.role)).toEqual([...COLOR_ROLES]);
  });

  it("passes the configured colour through unchanged", () => {
    // No conversion anywhere: a drawing stores the literal hex, so a palette
    // value that arrived here altered would put a colour in the file that
    // matches nothing in Settings.
    const custom = { ...DEFAULT_PALETTE, accent: "#ABCDEF" };
    const accent = offeredColors(custom).find((o) => o.role === "accent")!;
    expect(accent.hex).toBe("#ABCDEF");
  });

  it("keeps the neutrals out of Settings' reach", () => {
    // Black and white are fixed: a board can be either paper, and "the plain
    // one" must be reachable for both without becoming theme-dependent.
    const meddled = { ...DEFAULT_PALETTE } as Record<string, string>;
    meddled.black = "#ff0000";
    const black = offeredColors(meddled as typeof DEFAULT_PALETTE).find((o) => o.role === "black")!;
    expect(black.hex).toBe(NEUTRALS.black);
  });

  it("names every colour it offers", () => {
    for (const o of offeredColors(DEFAULT_PALETTE)) {
      expect(o.nameKey, o.role).toBe(`sketch.roleNames.${o.role}`);
    }
  });

  it("defaults the pen to plain black, not a theme-dependent ink", () => {
    expect(DEFAULT_INK).toBe(NEUTRALS.black);
  });

  it("falls back to a default when a role is missing from a stored palette", () => {
    const partial = { accent: "#111111" } as unknown as typeof DEFAULT_PALETTE;
    const mute = offeredColors(partial).find((o) => o.role === "mute")!;
    expect(mute.hex).toBe(DEFAULT_PALETTE.mute);
  });
});
