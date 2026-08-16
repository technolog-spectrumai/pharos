// Minimal per-app i18n. Deliberately not rakotis's createAppI18n: that module
// persists under "enigma:locale", and zinnia keeps its own key.
import { createI18n } from "vue-i18n";
import en from "./en";
import pl from "./pl";

const KEY = "zinnia:locale";
export const SUPPORTED_LOCALES = ["en", "pl"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

function initialLocale(): Locale {
  const stored = localStorage.getItem(KEY);
  if (stored === "en" || stored === "pl") return stored;
  return navigator.language?.toLowerCase().startsWith("pl") ? "pl" : "en";
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: initialLocale(),
  fallbackLocale: "en",
  messages: { en, pl },
});

export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale;
  document.documentElement.setAttribute("lang", locale);
  localStorage.setItem(KEY, locale);
}
