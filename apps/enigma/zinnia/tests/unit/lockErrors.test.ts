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

  it("names every prefix the sealing commands can actually return", async () => {
    // Reads the Rust the way the runtime meets it, the move icons.test.ts makes
    // on templates. This is what stops the next prefix from shipping unmapped
    // and rendering as raw Rust in the dialog.
    //
    // An error reaches the dialog through a chain of crates: the app's shim
    // calls padova, which calls substrate. Every file on that chain is read,
    // because a prefix can originate in any of them.
    const { readFileSync } = await import("node:fs");
    const CHAIN = {
      "src-tauri/src/lock.rs": null,
      "src-tauri/src/secrets.rs": null,
      // One prefix each file is KNOWN to hold. Without this, one stray hit from
      // one file would satisfy the floor below while every other file had
      // silently moved out from under the scan — which is how this test failed
      // the day padova was extracted, and the only reason it noticed.
      "crates/padova/src/lock.rs": "wrong_password",
      "crates/padova/src/secrets.rs": "no_passphrase",
      "crates/substrate/src/lib.rs": "too_large",
    } as const;
    const found = new Set<string>();
    for (const [file, sentinel] of Object.entries(CHAIN)) {
      const here = new Set<string>();
      // `"prefix: prose"` — the colon is followed by a space, which is what
      // keeps the AAD constant (b"zinnia:file:v1") out of the results.
      for (const m of readFileSync(file, "utf8").matchAll(/"([a-z_]+):\s/g)) here.add(m[1]);
      if (sentinel) expect(here, `${file} was read and still yields ${sentinel}`).toContain(sentinel);
      for (const p of here) found.add(p);
    }
    expect(found.size).toBeGreaterThan(0);
    for (const prefix of found) {
      expect(LOCK_ERRORS as readonly string[], `the sealing chain returns ${prefix}`)
        .toContain(prefix);
    }
  });
});
