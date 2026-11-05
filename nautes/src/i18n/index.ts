// Nautes's i18n instance: the framework (locale resolution + persistence) lives
// in rakotis; this module supplies Nautes's own message catalogs and re-exports
// the shared helpers so existing call sites (`../i18n`) are unchanged.

import en from "./en";
import pl from "./pl";
import { createAppI18n } from "rakotis";

export {
  SUPPORTED_LOCALES,
  LOCALE_NAMES,
  normalizeLocale,
  getStoredLocale,
  hasExplicitLocale,
} from "rakotis";
export type { Locale } from "rakotis";

const app = createAppI18n({
  en,
  pl,
});
export const i18n = app.i18n;
export const setLocale = app.setLocale;
export const applyProfileLocaleGuess = app.applyProfileLocaleGuess;
