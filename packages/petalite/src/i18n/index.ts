// The i18n MECHANISM. The catalogues stay with the app that owns their words.
//
// Deliberately not rakotis's `createAppI18n`: that module persists under
// "enigma:locale", and each app here keeps its own key — which is also why the
// key is a parameter rather than a constant. Two apps on one machine should not
// fight over one stored locale, for the same reason they do not share a keyring
// entry.
//
// What is shared is everything that is not words: which locales exist, how the
// initial one is chosen (stored, else the browser's, else English), and the
// `<html lang>` side effect that a screen reader and the spellchecker read.
import { createI18n } from "vue-i18n";

export const SUPPORTED_LOCALES = ["en", "pl"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupported(value: unknown): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly unknown[]).includes(value);
}

/** Build one app's i18n.
 *
 *  `storageKey` is per app (`"zinnia:locale"`); `messages` is that app's own
 *  catalogue, so Petalite never has to know a single word of it. */
export function createAppI18n<M extends Record<SupportedLocale, unknown>>(options: {
  storageKey: string;
  messages: M;
}) {
  const { storageKey, messages } = options;

  function initialLocale(): SupportedLocale {
    // A blocked or absent store must not stop the app from starting; falling
    // back to the browser's preference is the same answer a first run gives.
    try {
      const stored = localStorage.getItem(storageKey);
      if (isSupported(stored)) return stored;
    } catch {
      /* no store: use the browser's preference */
    }
    return navigator.language?.toLowerCase().startsWith("pl") ? "pl" : "en";
  }

  const i18n = createI18n({
    legacy: false,
    globalInjection: true,
    locale: initialLocale(),
    fallbackLocale: "en",
    messages: messages as never,
  });

  function setLocale(locale: SupportedLocale) {
    i18n.global.locale.value = locale;
    document.documentElement.setAttribute("lang", locale);
    try {
      localStorage.setItem(storageKey, locale);
    } catch {
      /* the choice still applies to this session */
    }
  }

  return { i18n, setLocale };
}
