import { describe, expect, it } from "vitest";
import { LOCK_ERRORS, lockErrorKey } from "../../src/security/lock";
import { i18n } from "../../src/i18n";

// Rust answers `prefix: prose`. A prefix with no `lock.errors.*` key renders as
// raw Rust in the dialog, which is how a real error reads as a crash.

const LOCALES = ["en", "pl"] as const;

function say(locale: (typeof LOCALES)[number], key: string): string {
  i18n.global.locale.value = locale;
  return i18n.global.t(key);
}

describe("the lock error prefixes", () => {
  it("maps a known prefix and leaves anything else raw", () => {
    expect(lockErrorKey("wrong_password: nope")).toBe("lock.errors.wrong_password");
    expect(lockErrorKey("legacy_format: platform")).toBe("lock.errors.legacy_format");
    // A filesystem message says more verbatim than "something failed" would.
    expect(lockErrorKey("EACCES: permission denied")).toBe(null);
    expect(lockErrorKey("no colon at all")).toBe(null);
  });

  it("has a string for every prefix, in both locales", () => {
    for (const locale of LOCALES) {
      for (const prefix of LOCK_ERRORS) {
        const key = `lock.errors.${prefix}`;
        expect(say(locale, key), `${key} in ${locale}`).not.toBe(key);
      }
    }
    i18n.global.locale.value = "en";
  });

  it("names every prefix lock.rs can actually return", async () => {
    // Reads the Rust the way the runtime meets it, the move icons.test.ts makes
    // on templates. This is what stops the next prefix from shipping unmapped
    // and rendering as raw Rust in the dialog.
    const { readFileSync } = await import("node:fs");
    const rust = readFileSync("src-tauri/src/lock.rs", "utf8");
    const found = new Set<string>();
    // `"prefix: prose"` — the colon is followed by a space, which is what keeps
    // the AAD constant (b"zinnia:file:v1") out of the results.
    for (const m of rust.matchAll(/"([a-z_]+):\s/g)) found.add(m[1]);
    expect(found.size).toBeGreaterThan(0);
    for (const prefix of found) {
      expect(LOCK_ERRORS as readonly string[], `lock.rs returns ${prefix}`)
        .toContain(prefix);
    }
  });
});
