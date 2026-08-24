// Dates, times and numbers in the language the user picked.
//
// Every date in this app used to be built with `toLocaleDateString(undefined, …)`,
// and `undefined` means the OPERATING SYSTEM's locale — not the app's. So a Polish
// user who set the app to Polski still read "August 2026" in the calendar header,
// "Mon" over the weekday columns and "3:30 PM" on their messages, because their OS
// was English. The language switch moved every string in the catalogs and not one
// date.
//
// These helpers take the locale from `currentLocale` below, which is a ref the
// i18n factory keeps in step with `i18n.global.locale`. Reading a ref is what makes
// dates REACTIVE: a component that formats one inside a computed or a template
// re-renders on a language switch, so dates change with everything else instead of
// keeping the old language until the view is rebuilt.
//
// Intl does the hard part. Polish month names inflect — nominative standing alone,
// genitive next to a day number — and Intl gets that right by itself:
//
//     { month: "long", year: "numeric" }             → "sierpień 2026"
//     { day: "numeric", month: "long", year: "num" } → "24 sierpnia 2026"
//
// which is the whole reason this file holds no month or weekday names of its own.
// A hand-written table would have to encode that grammar and would be wrong in one
// of the two cases, and wrong again for every locale added later.

import { ref, type Ref } from "vue";
import type { Locale } from "./index";

/**
 * The app's active locale. Owned here rather than in the vue-i18n instance so this
 * module stays free of it: rakotis formats, the app decides. `createAppI18n` writes
 * it at startup and on every switch.
 */
export const currentLocale: Ref<Locale> = ref<Locale>("en");

/** Called by the i18n factory. Not for general use — set the locale via `setLocale`. */
export function syncDateLocale(locale: Locale): void {
  currentLocale.value = locale;
}

/**
 * The BCP-47 tag Intl gets for each app locale.
 *
 * "pl" is unambiguous. "en" deliberately stays region-less: it keeps English
 * exactly as English users read it today, and picking "en-GB" or "en-US" here
 * would silently re-order every date for them to settle a question this app has
 * not been asked. The cost is that bare "en" resolves to US conventions
 * (month-first, 12-hour), so an English reader sees "8/24/2026" where a Polish one
 * sees "24.08.2026".
 */
const INTL_TAG: Record<Locale, string> = { en: "en", pl: "pl" };

/**
 * The date shapes this app actually renders. A closed set rather than free-form
 * options, so that two surfaces showing the same kind of thing cannot drift into
 * showing it differently — and so the coverage test can tell a formatted date from
 * a hand-rolled one.
 */
export type DateStyle =
  /** 15:30 — message timestamps, meeting start/end */
  | "time"
  /** 24.08.2026 — compact, numeric, no weekday */
  | "date"
  /** 24 sie 2026, 15:30 — "last seen", ledger rows, deadlines */
  | "dateTime"
  /** sierpień 2026 — the calendar's month header (nominative) */
  | "monthYear"
  /** pon. — calendar weekday column headers */
  | "weekdayShort"
  /** 24 sie — compact day chips */
  | "dayMonth"
  /** poniedziałek, 24 sierpnia — a day panel's title (genitive) */
  | "dayMonthWeekday"
  /** pon., 24 sie — the day half of a slot range, times appended separately */
  | "dayMonthWeekdayShort"
  /** 24 sie, 15:30 — a deadline, where the year is implied by proximity */
  | "dayMonthTime"
  /** pon., 24 sie, 15:30 — a slot in a list */
  | "dayMonthWeekdayTime";

const OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  time: { hour: "2-digit", minute: "2-digit" },
  date: { day: "2-digit", month: "2-digit", year: "numeric" },
  dateTime: { dateStyle: "medium", timeStyle: "short" },
  monthYear: { month: "long", year: "numeric" },
  weekdayShort: { weekday: "short" },
  dayMonth: { day: "numeric", month: "short" },
  dayMonthWeekday: { weekday: "long", day: "numeric", month: "long" },
  dayMonthWeekdayShort: { weekday: "short", day: "numeric", month: "short" },
  dayMonthTime: { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
  dayMonthWeekdayTime: {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  },
};

// Building an Intl.DateTimeFormat is expensive relative to using one, and these run
// inside list renders (a month grid formats 42 cells, a transcript one per message).
// Cached per locale+style; the map is tiny and bounded by the two enums above.
const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: Locale, style: DateStyle): Intl.DateTimeFormat {
  const key = `${locale}:${style}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_TAG[locale], OPTIONS[style]);
    cache.set(key, f);
  }
  return f;
}

export type DateInput = Date | number | string;

function asDate(value: DateInput): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date in the app's language.
 *
 * An unparseable value formats as "" rather than "Invalid Date": these render in
 * chat transcripts and contact lists next to real content, and a blank cell reads
 * as "not known" where the browser's error string reads as a bug.
 */
export function formatDate(value: DateInput, style: DateStyle = "date"): string {
  const d = asDate(value);
  if (!d) return "";
  return formatter(currentLocale.value, style).format(d);
}

/** 15:30 — the common case, spelled out because it is most of the call sites. */
export function formatTime(value: DateInput): string {
  return formatDate(value, "time");
}

/**
 * A number in the app's language: Polish separates thousands with a space and takes
 * a comma for the decimal point ("1 234,5"), English the reverse ("1,234.5").
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (!isFinite(value)) return "";
  return new Intl.NumberFormat(INTL_TAG[currentLocale.value], options).format(value);
}

/** Test seam: the caches key on locale, and a test that swaps locales wants them cold. */
export function resetDateFormatCache(): void {
  cache.clear();
}
