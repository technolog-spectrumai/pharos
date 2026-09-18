// This app's i18n: its catalogue, its storage key, Petalite's mechanism.
//
// The words are the app's — they name its editors and its errors — so they stay
// here. Everything that is not words (which locales exist, how the first one is
// chosen, the `<html lang>` side effect) is `petalite/i18n`, shared so three
// apps cannot drift on it.
import { createAppI18n, type SupportedLocale } from "petalite/i18n";
import { padovaMessages } from "padova/i18n";
import { wisteriaMessages } from "wisteria/i18n";
import en from "./en";
import pl from "./pl";

export { SUPPORTED_LOCALES } from "petalite/i18n";
/** Kept as the app's own name for the type: most callers say `Locale`. */
export type Locale = SupportedLocale;

const { i18n, setLocale } = createAppI18n({
  // Zinnia's own key. Not rakotis's "enigma:locale", and not shared with a
  // sibling app.
  storageKey: "zinnia:locale",
  // Padova brings its own `lock.*` and `security.*` words, merged in at the top
  // level. A package that owns a feature owns the strings that feature shows —
  // otherwise an app could adopt the Security tab and get a screen of raw keys.
  // Wisteria, the drawing engine, brings `sketch.*` the same way.
  // `security` is shared: padova's words for its own components, and the
  // app's for the workspace view. Merged one level deep so neither loses keys.
  messages: {
    en: { ...en, ...padovaMessages.en, ...wisteriaMessages.en,
          security: { ...padovaMessages.en.security, ...en.security } },
    pl: { ...pl, ...padovaMessages.pl, ...wisteriaMessages.pl,
          security: { ...padovaMessages.pl.security, ...pl.security } },
  },
});

export { i18n, setLocale };
