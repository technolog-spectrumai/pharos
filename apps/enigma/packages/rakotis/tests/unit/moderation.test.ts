import { describe, it, expect } from "vitest";
import {
  RULES_MAX_CHARS,
  MUTE_MAX_MS,
  activeMuteUntil,
  clampRules,
  formatRemaining,
  pruneMutes,
  sanitizeMuteUntil,
} from "../../src/services/moderation";

const NOW = 1_700_000_000_000;

describe("activeMuteUntil", () => {
  it("returns the expiry while in the future, null otherwise", () => {
    const mutes = { alice: NOW + 60_000, bob: NOW - 1 };
    expect(activeMuteUntil(mutes, "alice", NOW)).toBe(NOW + 60_000);
    expect(activeMuteUntil(mutes, "bob", NOW)).toBeNull(); // expired
    expect(activeMuteUntil(mutes, "carol", NOW)).toBeNull(); // never muted
  });

  it("ignores garbage values", () => {
    expect(activeMuteUntil({ x: "soon" as unknown as number }, "x", NOW)).toBeNull();
  });
});

describe("sanitizeMuteUntil", () => {
  it("accepts a future timestamp and clamps to the 30-day cap", () => {
    expect(sanitizeMuteUntil(NOW + 5_000, NOW)).toBe(NOW + 5_000);
    expect(sanitizeMuteUntil(NOW + MUTE_MAX_MS * 10, NOW)).toBe(NOW + MUTE_MAX_MS);
  });

  it("rejects past, non-numeric, and non-finite values", () => {
    expect(sanitizeMuteUntil(NOW - 1, NOW)).toBeNull();
    expect(sanitizeMuteUntil("tomorrow", NOW)).toBeNull();
    expect(sanitizeMuteUntil(Infinity, NOW)).toBeNull();
    expect(sanitizeMuteUntil(NaN, NOW)).toBeNull();
  });
});

describe("pruneMutes", () => {
  it("drops expired entries and keeps live ones", () => {
    const pruned = pruneMutes({ a: NOW - 1, b: NOW + 1000 }, NOW);
    expect(pruned).toEqual({ b: NOW + 1000 });
  });

  it("returns the SAME object when nothing expired (persist-on-change check)", () => {
    const mutes = { a: NOW + 1000 };
    expect(pruneMutes(mutes, NOW)).toBe(mutes);
  });
});

describe("clampRules", () => {
  it("trims and caps at RULES_MAX_CHARS", () => {
    expect(clampRules("  be kind  ")).toBe("be kind");
    expect(clampRules("x".repeat(RULES_MAX_CHARS + 100))).toHaveLength(RULES_MAX_CHARS);
  });
});

describe("formatRemaining", () => {
  it("formats hours, minutes and sub-minute remainders", () => {
    expect(formatRemaining(NOW + 4 * 3600_000 + 5 * 60_000, NOW)).toBe("4h 05m");
    expect(formatRemaining(NOW + 3600_000, NOW)).toBe("1h");
    expect(formatRemaining(NOW + 12 * 60_000, NOW)).toBe("12m");
    expect(formatRemaining(NOW + 45_000, NOW)).toBe("45s");
    expect(formatRemaining(NOW - 1, NOW)).toBe("1s"); // never negative/zero
  });
});
