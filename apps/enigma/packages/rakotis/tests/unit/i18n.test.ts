import { describe, it, expect, beforeEach } from "vitest";
import {
  getStoredLocale,
  hasExplicitLocale,
  normalizeLocale,
  SUPPORTED_LOCALES,
  LOCALE_NAMES,
  createAppI18n,
} from "../../src/i18n";

// A tiny app catalog to exercise the factory + locale helpers without coupling
// Euclid to any app's strings (catalog-parity tests live in each app).
const messages = {
  en: { hello: "Hello" },
  pl: { hello: "Cześć" },
};

beforeEach(() => {
  localStorage.clear();
});

describe("normalizeLocale", () => {
  it("maps regional + cased tags to a base supported locale", () => {
    expect(normalizeLocale("pl-PL")).toBe("pl");
    expect(normalizeLocale("PL")).toBe("pl");
    expect(normalizeLocale("en-US")).toBe("en");
  });
  it("returns null for unsupported or empty values", () => {
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });
});

describe("getStoredLocale / hasExplicitLocale", () => {
  it("is null when nothing is stored", () => {
    expect(getStoredLocale()).toBeNull();
    expect(hasExplicitLocale()).toBe(false);
  });
  it("reads a valid stored locale and ignores an invalid one", () => {
    localStorage.setItem("enigma:locale", "pl");
    expect(getStoredLocale()).toBe("pl");
    expect(hasExplicitLocale()).toBe(true);
    localStorage.setItem("enigma:locale", "xx");
    expect(getStoredLocale()).toBeNull();
  });
});

describe("supported locales", () => {
  it("exposes exactly the supported locales", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "pl"]);
    expect(Object.keys(LOCALE_NAMES)).toEqual(["en", "pl"]);
  });
});

describe("createAppI18n", () => {
  it("setLocale changes the active locale and persists by default", () => {
    const { i18n, setLocale } = createAppI18n(messages);
    setLocale("pl");
    expect((i18n.global.locale as { value: string }).value).toBe("pl");
    expect(localStorage.getItem("enigma:locale")).toBe("pl");
  });

  it("setLocale does not persist when persist=false and reflects <html lang>", () => {
    const { i18n, setLocale } = createAppI18n(messages);
    setLocale("pl", false);
    expect((i18n.global.locale as { value: string }).value).toBe("pl");
    expect(localStorage.getItem("enigma:locale")).toBeNull();
    expect(document.documentElement.getAttribute("lang")).toBe("pl");
  });

  it("applyProfileLocaleGuess applies a supported language as a non-persisted guess", () => {
    const { i18n, applyProfileLocaleGuess } = createAppI18n(messages);
    applyProfileLocaleGuess("pl");
    expect((i18n.global.locale as { value: string }).value).toBe("pl");
    expect(localStorage.getItem("enigma:locale")).toBeNull();
  });

  it("applyProfileLocaleGuess ignores the guess when a choice is already stored", () => {
    localStorage.setItem("enigma:locale", "en");
    const { i18n, applyProfileLocaleGuess } = createAppI18n(messages);
    applyProfileLocaleGuess("pl");
    expect((i18n.global.locale as { value: string }).value).toBe("en");
  });

  it("translates a known key per locale", () => {
    const { i18n, setLocale } = createAppI18n(messages);
    setLocale("pl");
    expect(i18n.global.t("hello")).toBe("Cześć");
  });
});
