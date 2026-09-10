// This app's i18n: its catalogue, its storage key, Petalite's mechanism.
//
// The words are the app's — they name its screens and its errors — so they stay
// here. Everything that is not words (which locales exist, how the first one is
// chosen, the `<html lang>` side effect) is `petalite/i18n`, shared so the apps
// cannot drift on it.
//
// NO padova messages, unlike lazurite and primula: this app ships no sealing
// surface, so merging `lock.*` and `security.*` would be a screen of strings
// nothing renders.
import { createAppI18n, type SupportedLocale } from "petalite/i18n";
import en from "./en";
import pl from "./pl";

export { SUPPORTED_LOCALES } from "petalite/i18n";
/** Kept as the app's own name for the type: most callers say `Locale`. */
export type Locale = SupportedLocale;

const { i18n, setLocale } = createAppI18n({
  // This app's own key, not shared with a sibling.
  storageKey: "py_editor:locale",
  messages: { en, pl },
});

export { i18n, setLocale };
