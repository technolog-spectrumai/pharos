import { createI18n } from "vue-i18n";
import en from "./en";
import pl from "./pl";

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

/** An explicit choice the user made in Enigma (overrides the profile guess). */
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

// Initial locale: an explicit local choice wins; otherwise fall back to the
// browser language. The toto profile language is applied later (once /me
// resolves) as the first guess when the user has made no explicit choice.
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: getStoredLocale() ?? browserLocale(),
  fallbackLocale: "en",
  messages: { en, pl },
});

export function setLocale(locale: Locale, persist = true): void {
  i18n.global.locale.value = locale;
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

/**
 * Apply the toto profile language as the *first guess* — but only when the user
 * has not already picked a language in Enigma. Not persisted, so a later
 * explicit choice still wins.
 */
export function applyProfileLocaleGuess(language: string | null | undefined): void {
  if (hasExplicitLocale()) return;
  const guess = normalizeLocale(language);
  if (guess) setLocale(guess, false);
}
