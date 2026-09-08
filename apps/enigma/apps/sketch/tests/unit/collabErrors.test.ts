import { describe, expect, it } from "vitest";
import { COLLAB_ERRORS, collabErrorKey } from "../../src/collab/transport";
import { i18n } from "../../src/i18n";

// Rust answers `prefix: prose`. A prefix with no `collab.errors.*` key renders
// as raw Rust in the panel — the same contract, and the same guard, as
// padova's lock errors (lockErrors.test.ts).

const LOCALES = ["en", "pl"] as const;

function say(locale: (typeof LOCALES)[number], key: string): string {
  i18n.global.locale.value = locale;
  return i18n.global.t(key);
}

describe("the collab error prefixes", () => {
  it("maps a known prefix and leaves anything else raw", () => {
    expect(collabErrorKey("ticket_spent: someone has already joined")).toBe("collab.errors.ticket_spent");
    expect(collabErrorKey("bind_failed: address in use")).toBe("collab.errors.bind_failed");
    expect(collabErrorKey("ECONNRESET: peer reset")).toBe(null);
    expect(collabErrorKey("no colon at all")).toBe(null);
  });

  it("has a string for every prefix, in both locales", () => {
    for (const locale of LOCALES) {
      for (const prefix of COLLAB_ERRORS) {
        const key = `collab.errors.${prefix}`;
        expect(say(locale, key), `${key} in ${locale}`).not.toBe(key);
      }
    }
    i18n.global.locale.value = "en";
  });

  it("names every prefix the collaboration chain can actually return", async () => {
    const { readFileSync } = await import("node:fs");
    // The chain: the app's shim, then the crate's session, ticket and frame
    // modules. One sentinel per file, so a file that moved out from under the
    // scan is noticed rather than silently contributing nothing.
    const CHAIN = {
      "src-tauri/src/collab.rs": "no_session",
      "../../crates/collab/src/session.rs": "ticket_spent",
      "../../crates/collab/src/ticket.rs": "bad_ticket",
      "../../crates/collab/src/frame.rs": "bad_frame",
      // Behind the `mls` feature, and read anyway: a prefix that only appears
      // in a feature-gated build is exactly the one that reaches a user with
      // no catalogue entry and renders as raw Rust.
      "../../crates/collab/src/mls.rs": "mls_decrypt",
    } as const;
    const found = new Set<string>();
    for (const [file, sentinel] of Object.entries(CHAIN)) {
      const here = new Set<string>();
      for (const m of readFileSync(file, "utf8").matchAll(/"([a-z_]+):\s/g)) here.add(m[1]);
      expect(here, `${file} was read and still yields ${sentinel}`).toContain(sentinel);
      for (const p of here) found.add(p);
    }
    for (const prefix of found) {
      expect(COLLAB_ERRORS as readonly string[], `the chain returns ${prefix}`).toContain(prefix);
    }
  });
});
