import { describe, expect, it } from "vitest";
import {
  dateTimeValue,
  dateValue,
  hourAfter,
  nextWholeHour,
  parseLocal,
  parseLocalDateTime,
  singleDayFields,
  singleDayRange,
  timeValue,
} from "../../src/index";

// Every expectation is built with the local-time Date constructor, so the
// suite means the same thing in any time zone the tests run in.
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("input values", () => {
  it("writes a local day, a time and both, zero-padded", () => {
    const d = local(2026, 3, 4, 9, 5);
    expect(dateValue(d)).toBe("2026-03-04");
    expect(timeValue(d)).toBe("09:05");
    expect(dateTimeValue(d)).toBe("2026-03-04T09:05");
  });

  it("takes milliseconds as well as a Date", () => {
    expect(dateValue(local(2026, 12, 31).getTime())).toBe("2026-12-31");
    expect(timeValue(local(2026, 1, 1, 23, 59).getTime())).toBe("23:59");
  });
});

describe("parseLocal", () => {
  it("reads a day as local midnight, not UTC midnight", () => {
    // new Date("2026-03-04") is UTC: the day before, west of Greenwich.
    expect(parseLocal("2026-03-04")).toEqual(local(2026, 3, 4));
  });

  it("reads a day and a time", () => {
    expect(parseLocal("2026-03-04T09:15")).toEqual(local(2026, 3, 4, 9, 15));
  });

  it("refuses a day the month does not have, instead of rolling into the next", () => {
    expect(parseLocal("2026-02-31")).toBeNull();
    expect(parseLocal("2026-02-29")).toBeNull();
    expect(parseLocal("2028-02-29")).toEqual(local(2028, 2, 29));
  });

  it("refuses anything that is not exactly the input format", () => {
    for (const bad of ["", "2026-3-4", "2026-13-01", "2026-00-10", "2026-03-04T24:00", "2026-03-04T09:60",
      "2026-03-04 09:15", "2026-03-04T09:15:00", "04.03.2026", "2026-03-04T9:15"]) {
      expect(parseLocal(bad), bad).toBeNull();
    }
  });
});

describe("parseLocalDateTime", () => {
  it("joins a date input and a time input", () => {
    expect(parseLocalDateTime("2026-03-04", "17:30")).toEqual(local(2026, 3, 4, 17, 30));
  });

  it("is null when either input is empty or malformed", () => {
    expect(parseLocalDateTime("", "17:30")).toBeNull();
    expect(parseLocalDateTime("2026-03-04", "")).toBeNull();
    expect(parseLocalDateTime("2026-03-04", "5pm")).toBeNull();
  });
});

describe("the new-meeting default", () => {
  it("offers the next whole hour, then an hour of meeting", () => {
    const start = nextWholeHour(local(2026, 3, 4, 9, 41));
    expect(start).toEqual(local(2026, 3, 4, 10));
    expect(hourAfter(start)).toEqual(local(2026, 3, 4, 11));
  });

  it("moves to the next hour even exactly on the hour", () => {
    expect(nextWholeHour(local(2026, 3, 4, 9))).toEqual(local(2026, 3, 4, 10));
  });

  it("crosses midnight and month ends into the next day", () => {
    expect(nextWholeHour(local(2026, 3, 31, 23, 10))).toEqual(local(2026, 4, 1, 0));
  });
});

describe("singleDayRange", () => {
  it("is the day's two times", () => {
    expect(singleDayRange("2026-03-04", "09:00", "10:30")).toEqual({
      start: local(2026, 3, 4, 9),
      end: local(2026, 3, 4, 10, 30),
    });
  });

  it("reads an end of 00:00 as midnight at the END of the day", () => {
    // The default for a meeting created between 22:00 and 22:59 is 23:00–00:00.
    // Read as the start of the same day it ended before it began, and the
    // untouched form could not be saved.
    const r = singleDayRange("2026-03-04", "23:00", "00:00")!;
    expect(r.end).toEqual(local(2026, 3, 5));
    expect(r.end.getTime()).toBeGreaterThan(r.start.getTime());
  });

  it("keeps any other end before the start, for the form to refuse", () => {
    const r = singleDayRange("2026-03-04", "10:00", "09:00")!;
    expect(r.end.getTime()).toBeLessThan(r.start.getTime());
  });

  it("is null when a field is not a date or a time", () => {
    expect(singleDayRange("2026-02-31", "09:00", "10:00")).toBeNull();
    expect(singleDayRange("2026-03-04", "", "10:00")).toBeNull();
  });

  it("round-trips through singleDayFields", () => {
    const r = singleDayRange("2026-03-04", "08:15", "12:45")!;
    expect(singleDayFields(r.start, r.end)).toEqual({ date: "2026-03-04", start: "08:15", end: "12:45" });
  });
});
