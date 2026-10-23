// The calendar code Enigma and Morion share: the local dates and times a
// meeting form reads and writes.
//
// The two calendars are different products — Enigma's meetings and polls go
// to a room, Morion's live in an .ics file — but both ask a person for a day
// and a time in a native <input>, and both had their own copy of turning that
// text into a Date and back, and of guessing "the next whole hour" for a new
// meeting. One of the copies got midnight wrong (see `singleDayRange`).
//
// Everything is in the device's local time, as the inputs are. Pure functions:
// no Vue, no clock (callers pass `now`), no I/O.

const two = (n: number) => String(n).padStart(2, "0");
const HOUR_MS = 3_600_000;

/** `<input type="date">` value, "YYYY-MM-DD", of a local day. */
export function dateValue(d: Date | number): string {
  const dt = typeof d === "number" ? new Date(d) : d;
  return `${dt.getFullYear()}-${two(dt.getMonth() + 1)}-${two(dt.getDate())}`;
}

/** `<input type="time">` value, "HH:MM", of a local time. */
export function timeValue(d: Date | number): string {
  const dt = typeof d === "number" ? new Date(d) : d;
  return `${two(dt.getHours())}:${two(dt.getMinutes())}`;
}

/** `<input type="datetime-local">` value, "YYYY-MM-DDTHH:MM". */
export function dateTimeValue(d: Date | number): string {
  return `${dateValue(d)}T${timeValue(d)}`;
}

/**
 * "2026-03-04" or "2026-03-04T09:15" as a local Date; null if it is not one.
 *
 * Strict on purpose: `new Date("…")` would also take "2026-02-31" (and roll it
 * into March) or read a date-only string as UTC midnight, which shows as the
 * day before west of Greenwich.
 */
export function parseLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi);
  // A day past the month's end rolls over; refuse it rather than move it.
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** A date input's and a time input's values together; null if either is not one. */
export function parseLocalDateTime(date: string, time: string): Date | null {
  return /^\d{2}:\d{2}$/.test(time) ? parseLocal(`${date}T${time}`) : null;
}

/** The start a new meeting is offered: the next whole hour after `now`. */
export function nextWholeHour(now: Date | number): Date {
  const dt = typeof now === "number" ? new Date(now) : now;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours() + 1, 0, 0, 0);
}

/** One hour after `d` — a new meeting's default length. */
export function hourAfter(d: Date | number): Date {
  return new Date((typeof d === "number" ? d : d.getTime()) + HOUR_MS);
}

/**
 * A meeting entered as one day and two times. An end of "00:00" is midnight
 * at the END of that day, as people mean it — so 23:00–00:00 is the last hour
 * of the day, not an end before the start. Any other end earlier than the
 * start stays earlier, for the form to refuse. Null when a field is not a
 * date or a time.
 */
export function singleDayRange(date: string, start: string, end: string): { start: Date; end: Date } | null {
  const s = parseLocalDateTime(date, start);
  const e = parseLocalDateTime(date, end);
  if (!s || !e) return null;
  if (end === "00:00") return { start: s, end: new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1) };
  return { start: s, end: e };
}

/** What a single-day form shows for a meeting: its day and its two times. */
export function singleDayFields(start: Date | number, end: Date | number): { date: string; start: string; end: string } {
  return { date: dateValue(start), start: timeValue(start), end: timeValue(end) };
}
