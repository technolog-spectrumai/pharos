import { describe, expect, it } from "vitest";
import { DOCUMENT_ERRORS, documentErrorKey } from "../../src/collab/document";
import { i18n } from "../../src/i18n";

// Rust answers `prefix: prose`. A prefix with no `document.errors.*` key
// renders as raw Rust in the UI, which is how a real error reads as a crash.
// Same contract and same guard as persistErrors.test.ts and collabErrors.

const LOCALES = ["en", "pl"] as const;

function say(locale: (typeof LOCALES)[number], key: string): string {
  i18n.global.locale.value = locale;
  return i18n.global.t(key);
}

describe("the document error prefixes", () => {
  it("maps a known prefix and leaves anything else raw", () => {
    expect(documentErrorKey("document_failed: lock poisoned")).toBe(
      "document.errors.document_failed",
    );
    expect(documentErrorKey("bad_update: damaged")).toBe("document.errors.bad_update");
    expect(documentErrorKey("ENOSPC: no space left")).toBe(null);
    expect(documentErrorKey("no colon at all")).toBe(null);
  });

  it("has a string for every prefix, in both locales", () => {
    for (const locale of LOCALES) {
      for (const prefix of DOCUMENT_ERRORS) {
        const key = `document.errors.${prefix}`;
        expect(say(locale, key), `${key} in ${locale}`).not.toBe(key);
      }
    }
    i18n.global.locale.value = "en";
  });

  it("names every prefix the document chain can actually return", async () => {
    const { readFileSync } = await import("node:fs");
    // The chain: this app's shim, then the crate. One sentinel per file, so a
    // file that moved out from under the scan is noticed rather than silently
    // contributing nothing.
    const CHAIN = {
      "src-tauri/src/document.rs": "document_failed",
      "../../crates/board/src/lib.rs": "bad_update",
    } as const;
    const found = new Set<string>();
    for (const [file, sentinel] of Object.entries(CHAIN)) {
      const here = new Set<string>();
      for (const m of readFileSync(file, "utf8").matchAll(/"([a-z_]+):\s/g)) here.add(m[1]);
      expect(here, `${file} was read and still yields ${sentinel}`).toContain(sentinel);
      for (const p of here) found.add(p);
    }
    for (const prefix of found) {
      expect(DOCUMENT_ERRORS as readonly string[], `the chain returns ${prefix}`).toContain(prefix);
    }
  });
});
