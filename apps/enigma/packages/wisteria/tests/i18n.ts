// A minimal i18n for the package's own component tests.
//
// The engine ships its strings as data (`wisteria/i18n`); an APP builds the
// real instance and merges them with its own. A test needs neither the app's
// storage key nor its locale persistence, only the words — so this is the
// smallest thing that renders them.
import { createI18n } from "vue-i18n";
import { wisteriaMessages } from "../src/i18n";

export const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages: {
    en: { ...wisteriaMessages.en, common: { close: "Close", cancel: "Cancel", save: "Save" } },
    pl: { ...wisteriaMessages.pl, common: { close: "Zamknij", cancel: "Anuluj", save: "Zapisz" } },
  },
});
