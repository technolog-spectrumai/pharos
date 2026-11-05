import { describe, it, expect, beforeEach, vi } from "vitest";
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
    localStorage.setItem("nautes:locale", "pl");
    expect(getStoredLocale()).toBe("pl");
    expect(hasExplicitLocale()).toBe(true);
    localStorage.setItem("nautes:locale", "xx");
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
    expect(localStorage.getItem("nautes:locale")).toBe("pl");
  });

  it("setLocale does not persist when persist=false and reflects <html lang>", () => {
    const { i18n, setLocale } = createAppI18n(messages);
    setLocale("pl", false);
    expect((i18n.global.locale as { value: string }).value).toBe("pl");
    expect(localStorage.getItem("nautes:locale")).toBeNull();
    expect(document.documentElement.getAttribute("lang")).toBe("pl");
  });

  it("applyProfileLocaleGuess applies a supported language as a non-persisted guess", () => {
    const { i18n, applyProfileLocaleGuess } = createAppI18n(messages);
    applyProfileLocaleGuess("pl");
    expect((i18n.global.locale as { value: string }).value).toBe("pl");
    expect(localStorage.getItem("nautes:locale")).toBeNull();
  });

  it("applyProfileLocaleGuess ignores the guess when a choice is already stored", () => {
    localStorage.setItem("nautes:locale", "en");
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

describe("Polish plurals", () => {
  // Three forms chosen by the last two digits, with the teens carved out — the
  // part a modulo in a template gets wrong.
  // vue-i18n's composer/legacy union has no single callable `t` type.
  const tr = (i18n: ReturnType<typeof createAppI18n>["i18n"]) =>
    i18n.global.t as unknown as (key: string, named: Record<string, unknown>, plural: number) => string;
  const plural = {
    en: { people: "{n} participant | {n} participants" },
    pl: { people: "{n} uczestnik | {n} uczestnicy | {n} uczestników" },
  };

  it("picks one / few / many the way Polish does, teens included", () => {
    const { i18n, setLocale } = createAppI18n(plural);
    setLocale("pl", false);
    const t = (n: number) => tr(i18n)("people", { n }, n);
    expect(t(1)).toBe("1 uczestnik");
    expect(t(2)).toBe("2 uczestnicy");
    expect(t(4)).toBe("4 uczestnicy");
    expect(t(5)).toBe("5 uczestników");
    expect(t(12)).toBe("12 uczestników");
    expect(t(14)).toBe("14 uczestników");
    expect(t(22)).toBe("22 uczestnicy");
    expect(t(25)).toBe("25 uczestników");
    expect(t(0)).toBe("0 uczestników");
  });

  it("leaves English on its two-form rule", () => {
    const { i18n, setLocale } = createAppI18n(plural);
    setLocale("en", false);
    expect(tr(i18n)("people", { n: 1 }, 1)).toBe("1 participant");
    expect(tr(i18n)("people", { n: 3 }, 3)).toBe("3 participants");
  });
});

describe("a stored locale when storage is unavailable", () => {
  it("reads as no explicit choice rather than throwing", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    try {
      expect(getStoredLocale()).toBeNull();
      expect(hasExplicitLocale()).toBe(false);
    } finally {
      getItem.mockRestore();
    }
  });
});
