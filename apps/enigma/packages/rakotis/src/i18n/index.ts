// Shared i18n framework: locale resolution + persistence helpers and a factory
// that builds an app's i18n instance from its own message catalogs. The catalogs
// themselves live in the app (apps/enigma/src/i18n), so rakotis carries no app strings.

import { createI18n, type I18n } from "vue-i18n";
import { syncDateLocale } from "./dateFormat";

export const SUPPORTED_LOCALES = ["en", "pl"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  pl: "Polski",
};

const STORAGE_KEY = "enigma:locale";

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Map e.g. "pl", "pl-PL", "PL" → "pl"; anything unsupported → null. */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const base = value.toLowerCase().split("-")[0];
  return isLocale(base) ? base : null;
}

/** An explicit choice the user made in the app (overrides the profile guess). */
export function getStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

export function hasExplicitLocale(): boolean {
  return getStoredLocale() !== null;
}

function browserLocale(): Locale {
  return normalizeLocale(typeof navigator !== "undefined" ? navigator.language : null) ?? "en";
}

export interface AppI18n {
  i18n: I18n;
  setLocale: (locale: Locale, persist?: boolean) => void;
  applyProfileLocaleGuess: (language: string | null | undefined) => void;
}

/**
 * Build an app's i18n instance from its message catalogs.
 *
 * Initial locale: an explicit local choice wins; otherwise fall back to the
 * browser language. `applyProfileLocaleGuess` remains for callers that obtain a
 * language hint from elsewhere (e.g. a profile) without an explicit choice.
 */
export function createAppI18n(messages: Record<Locale, unknown>): AppI18n {
  const initial = getStoredLocale() ?? browserLocale();
  const i18n = createI18n({
    legacy: false,
    globalInjection: true,
    locale: initial,
    fallbackLocale: "en",
    // Catalog shape is app-defined; vue-i18n's strict message typing is bypassed here.
    messages: messages as Record<string, never>,
  });

  // Dates read their locale from the same place the catalogs do. Seeded here and
  // updated in `setLocale` below, so a language switch moves "August 2026" to
  // "sierpień 2026" along with everything else rather than leaving dates in the
  // operating system's language (see ./dateFormat.ts).
  syncDateLocale(initial);

  function setLocale(locale: Locale, persist = true): void {
    (i18n.global.locale as unknown as { value: Locale }).value = locale;
    syncDateLocale(locale);
    try {
      document.documentElement.setAttribute("lang", locale);
    } catch {
      /* SSR / no DOM */
    }
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, locale);
      } catch {
        /* storage unavailable */
      }
    }
  }

  function applyProfileLocaleGuess(language: string | null | undefined): void {
    if (hasExplicitLocale()) return;
    const guess = normalizeLocale(language);
    if (guess) setLocale(guess, false);
  }

  return { i18n, setLocale, applyProfileLocaleGuess };
}
