import { describe, expect, it } from "vitest";
import {
  CAPABILITIES, CAPABILITY_GROUPS, capabilitiesIn,
} from "../../src/security/capabilities";
import { LOCK_ERRORS, lockErrorKey } from "../../src/security/lock";
import { i18n } from "../../src/i18n";
import en from "../../src/i18n/en";
import pl from "../../src/i18n/pl";

// The inventory is a page of claims about this build. A claim that renders as a
// raw i18n key reads as a bug in the very place the app is asking to be
// believed, so every string is asserted present in BOTH catalogues — the same
// argument tests/unit/icons.test.ts makes about glyphs.

const LOCALES = ["en", "pl"] as const;

function say(locale: (typeof LOCALES)[number], key: string): string {
  i18n.global.locale.value = locale;
  return i18n.global.t(key);
}

describe("the capability inventory", () => {
  it("gives every row a label and a detail in both locales", () => {
    for (const locale of LOCALES) {
      for (const cap of CAPABILITIES) {
        const label = `security.inventory.items.${cap.id}.label`;
        const detail = `security.inventory.items.${cap.id}.detail`;
        expect(say(locale, label), `${label} in ${locale}`).not.toBe(label);
        expect(say(locale, detail), `${detail} in ${locale}`).not.toBe(detail);
      }
    }
    i18n.global.locale.value = "en";
  });

  it("names every group and every status in both locales", () => {
    for (const locale of LOCALES) {
      for (const group of CAPABILITY_GROUPS) {
        const key = `security.inventory.groups.${group}`;
        expect(say(locale, key), `${key} in ${locale}`).not.toBe(key);
      }
      for (const status of new Set(CAPABILITIES.map((c) => c.status))) {
        const key = `security.inventory.status.${status}`;
        expect(say(locale, key), `${key} in ${locale}`).not.toBe(key);
      }
    }
    i18n.global.locale.value = "en";
  });

  it("keeps ids unique and usable as a testid", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    // A duplicate would render two rows under one testid, and the second would
    // be unreachable from a test.
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-zA-Z]*$/);
  });

  it("puts every row in a group the page renders", () => {
    // A row whose group is not in CAPABILITY_GROUPS is simply never drawn —
    // silently, which for a security page is the worst possible failure.
    const rendered = CAPABILITY_GROUPS.flatMap((g) => capabilitiesIn(g));
    expect(rendered).toHaveLength(CAPABILITIES.length);
  });

  it("quotes the live numbers rather than hardcoding them", () => {
    // The KDF row states this build's costs and the reach row states the folder.
    // Baking either into the catalogue is how a page of facts starts lying.
    //
    // Asserted against the RAW catalogue, not through t(): interpolation is
    // exactly what would hide a missing placeholder, rendering "64 MiB" from a
    // translator's memory as confidently as from the build.
    for (const [locale, cat] of [["en", en], ["pl", pl]] as const) {
      const items = cat.security.inventory.items as Record<string, { detail: string }>;
      const kdf = items.kdf.detail;
      expect(kdf, locale).toContain("{mem}");
      expect(kdf, locale).toContain("{passes}");
      expect(kdf, locale).toContain("{lanes}");
      expect(items.workspace.detail, locale).toContain("{folder}");
    }
  });

  it("reports the policy as present, and its one hole as absent", () => {
    // The page exists to correct stale claims, so these two are pinned: the
    // policy is real, and the fact that it cannot sandbox styles is stated
    // rather than glossed. Flipping `cspLimit` to anything but absent would be
    // claiming a protection the app does not have.
    expect(CAPABILITIES.find((c) => c.id === "csp")?.status).toBe("active");
    expect(CAPABILITIES.find((c) => c.id === "cspLimit")?.status).toBe("absent");
    // The keyring holds one passphrase now, so it is in use — but only because
    // something actually calls it. Still genuinely missing, still said so:
    expect(CAPABILITIES.find((c) => c.id === "keyring")?.status).toBe("active");
    expect(CAPABILITIES.find((c) => c.id === "network")?.status).toBe("parked");
  });
});

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
