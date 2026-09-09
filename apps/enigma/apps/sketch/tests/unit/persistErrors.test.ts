import { describe, expect, it } from "vitest";
import { PERSIST_ERRORS, persistErrorKey } from "../../src/collab/persist";
import { i18n } from "../../src/i18n";

// Rust answers `prefix: prose`. A prefix with no `persist.errors.*` key renders
// as raw Rust in the UI, which is how a real error reads as a crash. Same
// contract and same guard as collabErrors.test.ts and padova's lockErrors.

const LOCALES = ["en", "pl"] as const;

function say(locale: (typeof LOCALES)[number], key: string): string {
  i18n.global.locale.value = locale;
  return i18n.global.t(key);
}

describe("the persistence error prefixes", () => {
  it("maps a known prefix and leaves anything else raw", () => {
    expect(persistErrorKey("store_failed: disk full")).toBe("persist.errors.store_failed");
    expect(persistErrorKey("board_damaged: bad json")).toBe("persist.errors.board_damaged");
    // A filesystem message says more verbatim than "something failed" would.
    expect(persistErrorKey("ENOSPC: no space left")).toBe(null);
    expect(persistErrorKey("no colon at all")).toBe(null);
  });

  it("has a string for every prefix, in both locales", () => {
    for (const locale of LOCALES) {
      for (const prefix of PERSIST_ERRORS) {
        const key = `persist.errors.${prefix}`;
        expect(say(locale, key), `${key} in ${locale}`).not.toBe(key);
      }
    }
    i18n.global.locale.value = "en";
  });

  it("names every prefix the persistence chain can actually return", async () => {
    const { readFileSync } = await import("node:fs");
    // The chain: this app's shim, then the crate. One sentinel per file, so a
    // file that moved out from under the scan is noticed rather than silently
    // contributing nothing.
    const CHAIN = {
      "src-tauri/src/persist.rs": "store_failed",
      "../../crates/hoard/src/lib.rs": "board_damaged",
    } as const;
    const found = new Set<string>();
    for (const [file, sentinel] of Object.entries(CHAIN)) {
      const here = new Set<string>();
      for (const m of readFileSync(file, "utf8").matchAll(/"([a-z_]+):\s/g)) here.add(m[1]);
      expect(here, `${file} was read and still yields ${sentinel}`).toContain(sentinel);
      for (const p of here) found.add(p);
    }
    for (const prefix of found) {
      expect(PERSIST_ERRORS as readonly string[], `the chain returns ${prefix}`).toContain(prefix);
    }
  });
});
