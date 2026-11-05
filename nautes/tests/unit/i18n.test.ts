import { describe, it, expect, beforeEach } from "vitest";
import {
  i18n,
  setLocale,
  getStoredLocale,
  hasExplicitLocale,
  normalizeLocale,
  applyProfileLocaleGuess,
  SUPPORTED_LOCALES,
  LOCALE_NAMES,
} from "../../src/i18n";

beforeEach(() => {
  localStorage.clear();
  // Reset the shared singleton to a known state between tests.
  i18n.global.locale.value = "en";
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

describe("setLocale", () => {
  it("changes the active locale and persists by default", () => {
    setLocale("pl");
    expect(i18n.global.locale.value).toBe("pl");
    expect(localStorage.getItem("nautes:locale")).toBe("pl");
  });
  it("does not persist when persist=false", () => {
    setLocale("pl", false);
    expect(i18n.global.locale.value).toBe("pl");
    expect(localStorage.getItem("nautes:locale")).toBeNull();
  });
  it("reflects the locale on <html lang>", () => {
    setLocale("pl");
    expect(document.documentElement.getAttribute("lang")).toBe("pl");
  });
});

describe("applyProfileLocaleGuess", () => {
  it("applies a supported profile language as a non-persisted guess", () => {
    applyProfileLocaleGuess("pl");
    expect(i18n.global.locale.value).toBe("pl");
    expect(localStorage.getItem("nautes:locale")).toBeNull(); // a guess, not a choice
  });
  it("ignores the guess when the user already chose explicitly", () => {
    setLocale("en"); // explicit choice persisted
    applyProfileLocaleGuess("pl");
    expect(i18n.global.locale.value).toBe("en");
  });
  it("ignores unsupported / empty profile languages", () => {
    applyProfileLocaleGuess("fr");
    expect(i18n.global.locale.value).toBe("en");
    applyProfileLocaleGuess(null);
    expect(i18n.global.locale.value).toBe("en");
  });
});

describe("catalog", () => {
  it("exposes exactly the supported locales", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "pl"]);
    expect(Object.keys(LOCALE_NAMES)).toEqual(["en", "pl"]);
  });

  it("has identical key structure across en and pl (no missing translations)", () => {
    const en = i18n.global.getLocaleMessage("en");
    const pl = i18n.global.getLocaleMessage("pl");
    const keys = (obj: any, prefix = ""): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(keys(pl).sort()).toEqual(keys(en).sort());
  });

  it("actually translates a known key to Polish", () => {
    setLocale("pl");
    expect(i18n.global.t("nav.chat")).toBe("Czat");
    expect(i18n.global.t("chat.join")).toBe("Dołącz");
  });
});

describe("locale key parity", () => {
  // `fallbackLocale: "en"` means a key missing from pl.ts silently renders the
  // English string, so an omission is invisible until a Polish speaker hits it.
  // This walks both trees and reports the exact paths that differ.
  function paths(obj: unknown, prefix = ""): string[] {
    if (obj === null || typeof obj !== "object") return [prefix];
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      paths(v, prefix ? `${prefix}.${k}` : k),
    );
  }

  it("en and pl define exactly the same keys", async () => {
    const en = (await import("../../src/i18n/en")).default;
    const pl = (await import("../../src/i18n/pl")).default;
    const inEn = new Set(paths(en));
    const inPl = new Set(paths(pl));
    const missingFromPl = [...inEn].filter((k) => !inPl.has(k)).sort();
    const missingFromEn = [...inPl].filter((k) => !inEn.has(k)).sort();
    expect({ missingFromPl, missingFromEn }).toEqual({ missingFromPl: [], missingFromEn: [] });
  });
});
