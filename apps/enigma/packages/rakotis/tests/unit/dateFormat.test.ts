// The bug this file exists to prevent: the app renders "August 2026" to a user who
// has chosen Polski, because `toLocaleDateString(undefined, …)` reads the OPERATING
// SYSTEM's locale and not the app's. Every assertion below is about the app locale
// winning.

import { describe, it, expect, beforeEach } from "vitest";
import {
  formatDate,
  formatTime,
  formatNumber,
  formatBytes,
  currentLocale,
  resetDateFormatCache,
} from "../../src/i18n/dateFormat";

// A Monday, so the weekday assertions mean something. Local time on purpose: these
// formatters render wall-clock time to the person sitting in front of the app.
const AUG = new Date(2026, 7, 24, 15, 30);

beforeEach(() => {
  currentLocale.value = "en";
  resetDateFormatCache();
});

describe("dates follow the app's language", () => {
  it("renders the month in Polish, not English", () => {
    // The literal case the user reported.
    expect(formatDate(AUG, "monthYear")).toBe("August 2026");
    currentLocale.value = "pl";
    expect(formatDate(AUG, "monthYear")).toBe("sierpień 2026");
  });

  it("inflects the Polish month when a day number is present", () => {
    // Polish declines: the calendar header is nominative ("sierpień") but a full
    // date is genitive ("24 sierpnia"). Intl knows this and a hand-written table of
    // month names would not — which is why this module holds no month names.
    currentLocale.value = "pl";
    expect(formatDate(AUG, "monthYear")).toContain("sierpień");
    expect(formatDate(AUG, "dayMonthWeekday")).toContain("sierpnia");
    expect(formatDate(AUG, "dayMonthWeekday")).toContain("poniedziałek");
  });

  it("translates weekday headers", () => {
    expect(formatDate(AUG, "weekdayShort")).toBe("Mon");
    currentLocale.value = "pl";
    expect(formatDate(AUG, "weekdayShort")).toBe("pon.");
  });

  it("uses a 24-hour clock in Polish", () => {
    currentLocale.value = "pl";
    expect(formatTime(AUG)).toBe("15:30");
    expect(formatTime(AUG)).not.toMatch(/PM/i);
  });

  it("formats numbers with Polish separators", () => {
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatNumber(12345.5)).toBe("12,345.5");
    currentLocale.value = "pl";
    // Polish takes a comma for the decimal point, and a space for thousands — but
    // only from FIVE digits up (CLDR gives pl minimumGroupingDigits: 2), so "1234,5"
    // has no separator and "12 345,5" does. Grouping every four-digit number the way
    // English does would be the wrong kind of wrong: it looks deliberate.
    expect(formatNumber(1234.5)).toBe("1234,5");
    expect(formatNumber(12345.5).replace(/\s/g, " ")).toBe("12 345,5");
  });
});

describe("switching language moves already-formatted dates", () => {
  it("re-formats when the locale ref changes", () => {
    // `currentLocale` is a ref precisely so a computed or template that formatted a
    // date re-runs on a language switch. If this ever became a plain variable the
    // catalogs would switch and the dates would silently keep the old language.
    const before = formatDate(AUG, "dayMonthWeekday");
    currentLocale.value = "pl";
    expect(formatDate(AUG, "dayMonthWeekday")).not.toBe(before);
  });

  it("does not serve a cached formatter from the previous locale", () => {
    // Formatters are cached per locale+style for speed (a month grid formats 42
    // cells). Keying the cache on locale alone, or reusing one instance, would pin
    // the first language chosen for the rest of the session.
    expect(formatDate(AUG, "monthYear")).toBe("August 2026");
    currentLocale.value = "pl";
    expect(formatDate(AUG, "monthYear")).toBe("sierpień 2026");
    currentLocale.value = "en";
    expect(formatDate(AUG, "monthYear")).toBe("August 2026");
  });
});

describe("input handling", () => {
  it("takes a Date, an epoch number or a string", () => {
    // The call sites carry all three: Date from the calendar grid, number from the
    // meeting model, string from stored contact records.
    const expected = formatDate(AUG, "date");
    expect(formatDate(AUG.getTime(), "date")).toBe(expected);
    expect(formatDate(AUG.toISOString(), "date")).toBe(expected);
  });

  it("renders an unparseable value as empty, never 'Invalid Date'", () => {
    // These sit in transcripts and contact lists beside real content: a blank reads
    // as "not known", where the browser's error string reads as a broken app.
    expect(formatDate("not a date", "date")).toBe("");
    expect(formatDate(NaN, "dateTime")).toBe("");
    expect(formatNumber(Infinity)).toBe("");
  });
});

describe("byte counts", () => {
  it("picks the unit by size and keeps a fixed number of decimals", () => {
    // Fixed decimals keep sizes in a list the same width: "2.0 MB", not "2 MB".
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1,023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(3.5 * 1024 ** 3)).toBe("3.50 GB");
  });

  it("moves only the separator in Polish, never the unit symbol", () => {
    currentLocale.value = "pl";
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2,0 MB");
  });

  it("renders a size that is not a size as empty", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatNumber(Number.NaN)).toBe("");
  });
});
