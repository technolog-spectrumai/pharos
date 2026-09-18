import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FS_ERRORS, fsErrorKey } from "../../src/files/fs";
import { LOCK_ERRORS } from "padova";
import { i18n } from "../../src/i18n";

// The workspace, sealed-editing and folder commands answer `prefix: prose`,
// like the lock chain. A prefix with no catalogue key renders as raw Rust,
// which reads as a crash — so every prefix these files can return must be
// one the page knows, and every one it knows must have words in both locales.
const FILES = {
  "src-tauri/src/workspace.rs": "cannot_open",
  "src-tauri/src/sealed.rs": "no_session",
  "src-tauri/src/folder.rs": "not_found",
  "src-tauri/src/meta.rs": "too_many_tags",
} as const;

describe("the workspace error prefixes", () => {
  it("maps a known prefix and leaves anything else raw", () => {
    expect(fsErrorKey("symlink: Morion does not follow symbolic links")).toBe("workspace.errors.symlink");
    expect(fsErrorKey("EACCES: permission denied")).toBe(null);
  });

  it("has words for every prefix, in both locales", () => {
    for (const locale of ["en", "pl"] as const) {
      i18n.global.locale.value = locale;
      for (const prefix of FS_ERRORS) {
        const key = `workspace.errors.${prefix}`;
        expect(i18n.global.t(key), `${key} in ${locale}`).not.toBe(key);
      }
    }
    i18n.global.locale.value = "en";
  });

  it("knows every prefix the commands can return", () => {
    // `meta` is an I/O failure with the OS's own words after it; shown as it
    // came, like any filesystem message.
    const known = new Set<string>([...FS_ERRORS, ...LOCK_ERRORS, "meta"]);
    for (const [file, sentinel] of Object.entries(FILES)) {
      const here = new Set<string>();
      // Only the non-test half: a test's expected strings are not answers.
      const source = readFileSync(file, "utf8").split("#[cfg(test)]")[0];
      for (const m of source.matchAll(/"([a-z_]+):\s/g)) here.add(m[1]);
      expect(here, `${file} still yields ${sentinel}`).toContain(sentinel);
      for (const prefix of here) expect(known.has(prefix), `${file} returns ${prefix}`).toBe(true);
    }
  });
});
