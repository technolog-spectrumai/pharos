// Enigma26's i18n instance: the framework (locale resolution + persistence) lives
// in rakotis; this module supplies Enigma26's own message catalogs and re-exports
// the shared helpers so existing call sites (`../i18n`) are unchanged.

import en from "./en";
import pl from "./pl";
import { createAppI18n } from "rakotis";
// The drawing engine (wisteria, from Rutile) ships the words its canvas and
// toolbar render. Both copies of these strings used to live in two apps, and
// only one was ever updated.
import { wisteriaMessages } from "wisteria/i18n";

export {
  SUPPORTED_LOCALES,
  LOCALE_NAMES,
  normalizeLocale,
  getStoredLocale,
  hasExplicitLocale,
} from "rakotis";
export type { Locale } from "rakotis";

const app = createAppI18n({
  en: { ...en, ...wisteriaMessages.en },
  pl: { ...pl, ...wisteriaMessages.pl },
});
export const i18n = app.i18n;
export const setLocale = app.setLocale;
export const applyProfileLocaleGuess = app.applyProfileLocaleGuess;
