// @vitest-environment jsdom
//
// The i18n mechanism — everything about languages that is not words.
//
// Each app brings its own catalogue and its own storage key; what is shared,
// and pinned here, is how the first locale is chosen (stored, else the
// browser's, else English), what switching does (words, `<html lang>`, the
// stored choice), and that two apps on one machine never read each other's
// choice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppI18n, SUPPORTED_LOCALES } from "../../src/i18n";

const messages = {
  en: { hello: "Hello", bye: "Goodbye" },
  pl: { hello: "Cześć" },
};

function build(storageKey = "zinnia:locale") {
  const app = createAppI18n({ storageKey, messages });
  // The composer's catalogue-typed `t` is not what is under test; the words
  // it answers are.
  const global = app.i18n.global as unknown as { t: (key: string) => string; locale: { value: string } };
  return { ...app, t: (key: string) => global.t(key), locale: () => global.locale.value };
}

function browserSpeaks(language: string | undefined) {
  vi.spyOn(window.navigator, "language", "get").mockReturnValue(language as string);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("lang");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("which locales exist", () => {
  it("offers English and Polish, English first", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "pl"]);
  });
});

describe("the first locale", () => {
  it("is the one this app stored", () => {
    browserSpeaks("en-US");
    localStorage.setItem("zinnia:locale", "pl");
    const { locale, t } = build();
    expect(locale()).toBe("pl");
    expect(t("hello")).toBe("Cześć");
  });

  it("is the browser's when nothing is stored", () => {
    browserSpeaks("pl-PL");
    expect(build().locale()).toBe("pl");
  });

  it("reads the browser's language without regard to case", () => {
    browserSpeaks("PL");
    expect(build().locale()).toBe("pl");
  });

  it("is English for a browser language there is no catalogue for", () => {
    browserSpeaks("fr-FR");
    expect(build().locale()).toBe("en");
  });

  it("is English when the browser states no language", () => {
    browserSpeaks(undefined);
    expect(build().locale()).toBe("en");
  });

  it("ignores a stored value it does not support, and asks the browser instead", () => {
    // A hand-edited or future-build value must not leave the app in a locale
    // with no catalogue, which renders every string as its raw key.
    browserSpeaks("pl-PL");
    localStorage.setItem("zinnia:locale", "de");
    expect(build().locale()).toBe("pl");
  });

  it("is matched exactly against the stored value, not loosely", () => {
    browserSpeaks("en-GB");
    localStorage.setItem("zinnia:locale", "PL");
    expect(build().locale()).toBe("en");
  });

  it("falls back to the browser when storage cannot be read", () => {
    // A blocked store must not stop the app starting; the browser's
    // preference is the answer a first run would give anyway.
    browserSpeaks("pl");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(build().locale()).toBe("pl");
  });
});

describe("switching", () => {
  it("changes the words, the document language, and the stored choice", () => {
    browserSpeaks("en-US");
    const { setLocale, t, locale } = build();
    expect(t("hello")).toBe("Hello");

    setLocale("pl");

    expect(locale()).toBe("pl");
    expect(t("hello")).toBe("Cześć");
    // What a screen reader picks its voice from, and the spellchecker its
    // dictionary.
    expect(document.documentElement.getAttribute("lang")).toBe("pl");
    expect(localStorage.getItem("zinnia:locale")).toBe("pl");
  });

  it("is what the next launch starts in", () => {
    browserSpeaks("en-US");
    build().setLocale("pl");
    expect(build().locale()).toBe("pl");
  });

  it("still applies for this session when storage refuses the write", () => {
    browserSpeaks("en-US");
    const { setLocale, locale } = build();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => setLocale("pl")).not.toThrow();
    expect(locale()).toBe("pl");
    expect(document.documentElement.getAttribute("lang")).toBe("pl");
    expect(localStorage.getItem("zinnia:locale")).toBeNull();
  });

  it("falls back to English for a word the Polish catalogue lacks", () => {
    // A catalogue that lags behind shows English for its gaps, not raw keys.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    browserSpeaks("en-US");
    const { setLocale, t } = build();
    setLocale("pl");
    expect(t("bye")).toBe("Goodbye");
  });
});

describe("two apps on one machine", () => {
  it("keep their choices under their own keys", () => {
    // Two apps must not fight over one stored locale, for the same reason
    // they do not share a keyring entry.
    browserSpeaks("en-US");
    const zinnia = build("zinnia:locale");
    const other = build("other:locale");

    zinnia.setLocale("pl");

    expect(localStorage.getItem("zinnia:locale")).toBe("pl");
    expect(localStorage.getItem("other:locale")).toBeNull();
    expect(other.locale()).toBe("en");
  });

  it("each start from their own stored choice", () => {
    browserSpeaks("en-US");
    localStorage.setItem("zinnia:locale", "pl");
    localStorage.setItem("other:locale", "en");

    expect(build("zinnia:locale").locale()).toBe("pl");
    expect(build("other:locale").locale()).toBe("en");
  });

  it("are separate instances: switching one leaves the other's words alone", () => {
    browserSpeaks("en-US");
    const zinnia = build("zinnia:locale");
    const other = build("other:locale");

    zinnia.setLocale("pl");

    expect(zinnia.t("hello")).toBe("Cześć");
    expect(other.t("hello")).toBe("Hello");
  });
});
