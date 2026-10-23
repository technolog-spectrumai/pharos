// Privacy HP — the history chart and the last few display helpers.
//
// The chart is reconstructed, not recorded: each sample is `deriveBalances`
// called at a past instant, so it cannot disagree with the number beside it.
// What these tests pin is the sampling (where the points land, how many there
// are) and the drawing (a fixed 0..max y-axis, so a quiet week never looks like
// a crisis; a visible hairline for a day at zero, so "at zero" and "no data"
// never look the same).
//
// Pure functions throughout: `now` is passed explicitly, no fake timers.

import { describe, it, expect } from "vitest";
import {
  calendarActionId,
  deriveBalances,
  findAction,
  formatRate,
  hpBars,
  hpToCenti,
  regenPerHour,
  hpHistory,
  hpSparkline,
  type HpEntry,
  type HpSample,
} from "../../src/privacyHp";
import { FALLBACK_HP_POLICY as P } from "../../src/services/hp";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

const spend = (ts: number, hpCenti: number): HpEntry => ({
  ts, kind: "spend", code: "room.create.clearnet", hp: -hpCenti, n: 1, bucket: 0,
});

describe("hpHistory", () => {
  it("samples a week hourly, oldest first, landing the last point exactly on now", () => {
    const s = hpHistory(P, [], T0);
    expect(s).toHaveLength(7 * 24 + 1);
    expect(s[0].t).toBe(T0 - 7 * DAY);
    expect(s[1].t - s[0].t).toBe(HOUR);
    expect(s.at(-1)!.t).toBe(T0);
    expect(s.every((x) => x.centi === 10_000)).toBe(true);
  });

  it("samples by day for the coarse view", () => {
    const s = hpHistory(P, [], T0, "day");
    expect(s.map((x) => x.t)).toEqual(Array.from({ length: 8 }, (_, i) => T0 - (7 - i) * DAY));
  });

  it("honours a shorter span than the policy's retention", () => {
    expect(hpHistory(P, [], T0, "day", 2)).toHaveLength(3);
  });

  it("draws each sample as the meter stood at that instant", () => {
    // A 20 HP charge two hours ago: down 20 at it, and 8 HP healed by now
    // (4 HP an hour off Tor).
    const log = [spend(T0 - 2 * HOUR, 2000)];
    const s = hpHistory(P, log, T0);
    const at = (t: number) => s.find((x) => x.t === t)!.centi;
    expect(at(T0 - 2 * HOUR)).toBe(8000);
    expect(at(T0 - HOUR)).toBe(8400);
    expect(at(T0)).toBe(8800);
    // …and the last point is the live number, not an approximation of it.
    expect(at(T0)).toBe(deriveBalances(P, log, T0).daily.balanceCenti);
  });
});

describe("hpSparkline", () => {
  const samples = (...centi: number[]): HpSample[] => centi.map((c, i) => ({ t: i, centi: c }));

  it("draws nothing for no data or a meter with no maximum", () => {
    expect(hpSparkline([], 10_000)).toBe("");
    expect(hpSparkline(samples(1, 2), 0)).toBe("");
  });

  it("fits the series to the box on a fixed 0..max axis, full at the top", () => {
    expect(hpSparkline(samples(10_000, 5000, 0), 10_000)).toBe("0.00,0.00 50.00,16.00 100.00,32.00");
  });

  it("does not rescale to the data, so a small dip stays small", () => {
    const line = hpSparkline(samples(10_000, 9900), 10_000).split(" ");
    expect(line[1]).toBe("100.00,0.32");
  });

  it("clamps values outside the axis and honours a custom box", () => {
    expect(hpSparkline(samples(20_000, -5), 10_000, 10, 4)).toBe("0.00,0.00 10.00,4.00");
  });
});

describe("hpBars", () => {
  const samples = (...centi: number[]): HpSample[] => centi.map((c, i) => ({ t: 1000 + i, centi: c }));

  it("draws nothing for no data or a meter with no maximum", () => {
    expect(hpBars([], 10_000)).toEqual([]);
    expect(hpBars(samples(1), 0)).toEqual([]);
  });

  it("gives each day an equal slot with a centred bar, carrying its time and value", () => {
    const bars = hpBars(samples(10_000, 5000, 20_000, 0), 10_000);
    expect(bars.map((b) => [b.x, b.w])).toEqual([[3.75, 17.5], [28.75, 17.5], [53.75, 17.5], [78.75, 17.5]]);
    expect(bars[0]).toMatchObject({ y: 0, h: 32, t: 1000, centi: 10_000 });
    expect(bars[1]).toMatchObject({ y: 16, h: 16 });
    // Over the maximum is drawn as full, never past the box.
    expect(bars[2]).toMatchObject({ y: 0, h: 32, centi: 20_000 });
  });

  it("keeps a hairline for a day at zero, so it reads as present, not missing", () => {
    const [bar] = hpBars(samples(0), 10_000);
    expect(bar.h).toBe(0.6);
    expect(bar.y).toBeCloseTo(31.4);
  });

  it("never draws a bar narrower than one unit", () => {
    const bars = hpBars(samples(...Array.from({ length: 200 }, () => 5000)), 10_000);
    expect(bars[0].w).toBe(1);
  });
});

describe("calendar traffic", () => {
  it("picks its lane from the transport alone, and both lanes are priced", () => {
    expect(calendarActionId(true)).toBe("calendar.share.tor");
    expect(calendarActionId(false)).toBe("calendar.share.clearnet");
    expect(findAction(P, calendarActionId(true))).not.toBeNull();
    expect(findAction(P, calendarActionId(false))).not.toBeNull();
  });
});

describe("formatRate", () => {
  it("shows a per-unit cost with a real minus sign, whatever sign it was given", () => {
    expect(formatRate(5, "msg")).toBe("−0.05 HP/msg");
    expect(formatRate(-25, "min")).toBe("−0.25 HP/min");
  });

  it("shows nothing at all for the free lane", () => {
    expect(formatRate(0, "msg")).toBe("");
  });
});

describe("meter labels", () => {
  it("states the regeneration rate in force as whole HP per hour", () => {
    expect(regenPerHour(deriveBalances(P, [], T0).daily)).toBe("4");
    const onTor: HpEntry = { ts: T0 - HOUR, kind: "posture", code: "transport.tor.on", hp: 0, n: 1, bucket: 0 };
    expect(regenPerHour(deriveBalances(P, [onTor], T0).daily)).toBe("12");
  });

  it("converts HP to centi-HP without floating-point drift", () => {
    expect(hpToCenti(0.05)).toBe(5);
    expect(hpToCenti(0.07)).toBe(7); // 0.07 * 100 is 7.000000000000001 in floating point
    expect(hpToCenti(2.675)).toBe(268);
    expect(hpToCenti(-1.1)).toBe(-110);
  });
});
