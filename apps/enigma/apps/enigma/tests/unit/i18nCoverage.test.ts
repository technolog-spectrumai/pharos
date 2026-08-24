// Nothing user-visible may be hard-coded English.
//
// The app has shipped English and Polish for a long time, and `i18n.test.ts`
// checks the two catalogs define the same keys. But that test compares the
// catalogs to EACH OTHER, so a string that never became a key at all is in
// neither and therefore invisible to it — which is exactly how about forty of
// them accumulated: notices, placeholders, button labels and alt text, each
// added in a hurry and each rendering in English to a Polish user.
//
// This test closes that blind spot by reading the source as text and flagging
// user-facing English outside `$t(...)`. It is a heuristic, so it carries an
// ALLOWLIST — and every entry there has to say why, or the list becomes the
// place where the problem hides instead of the place it is documented.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      statSync(join(dir, "apps/enigma/src/i18n/en.ts"));
      return dir;
    } catch {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error(`cannot find the repo root above ${process.cwd()}`);
}

const ROOT = repoRoot();

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

/**
 * Strings that are deliberately not translated. Each needs a reason — a bare
 * list would just be somewhere to hide a bug.
 */
const ALLOWED = new Set([
  // Protocol and product names. "Tor" and "iroh" are what the transports are
  // called, in every language; translating them would invent terminology.
  "Tor",
  "iroh",
  "Enigma26",
  "MLS",
  "QR",
]);

/** Attributes whose value a user reads — including via a screen reader. */
const TEXT_ATTRS = ["placeholder", "label", "alt", "title", "aria-label"];

/** Two or more words starting with a capital, or one long capitalised word. */
function looksLikeProse(value: string): boolean {
  const v = value.trim();
  if (!v || ALLOWED.has(v)) return false;
  if (/^[a-z0-9:_\-./#{}[\]$ ]+$/.test(v)) return false; // classes, ids, paths
  return /^[A-Z][a-z]/.test(v) && (v.includes(" ") || v.length > 12);
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function scanVue(): Finding[] {
  const found: Finding[] = [];
  for (const file of walk(resolve(ROOT, "apps/enigma/src"), ".vue")) {
    const rel = relative(ROOT, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // A literal attribute (no leading `:`) whose value reads as prose.
        for (const attr of TEXT_ATTRS) {
          const m = line.match(new RegExp(`(?<![:\\w-])${attr}="([^"]*)"`));
          if (m && looksLikeProse(m[1])) {
            found.push({ file: rel, line: i + 1, text: `${attr}="${m[1]}"` });
          }
        }
        // A bare string inside an interpolation: {{ "Foo bar" }} or a ternary.
        if (line.includes("{{")) {
          for (const m of line.matchAll(/["'`]([^"'`]{4,})["'`]/g)) {
            if (looksLikeProse(m[1]) && !line.includes("$t(")) {
              found.push({ file: rel, line: i + 1, text: m[1] });
            }
          }
        }
      });
  }
  return found;
}

function scanRakotisNotices(): Finding[] {
  const found: Finding[] = [];
  const file = resolve(ROOT, "packages/rakotis/src/useChatChannel.ts");
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      // A notice built from a literal instead of going through `t(key, …)`.
      const m = line.match(/systemMsg\(\s*[`"']([^`"']{4,})/);
      if (m && looksLikeProse(m[1])) {
        found.push({
          file: "packages/rakotis/src/useChatChannel.ts",
          line: i + 1,
          text: m[1],
        });
      }
    });
  return found;
}

/**
 * Dates formatted against the OS locale instead of the app's.
 *
 * `toLocaleDateString(undefined, …)` and `toLocaleTimeString([], …)` read the
 * OPERATING SYSTEM's language, so they rendered "August 2026" to users who had
 * chosen Polski. Every one of them now goes through rakotis's `formatDate` /
 * `formatTime`, which read the app locale — this keeps the next one from landing.
 */
function scanDateFormatting(): Finding[] {
  const found: Finding[] = [];
  const roots = [
    resolve(ROOT, "apps/enigma/src"),
    resolve(ROOT, "packages/rakotis/src"),
  ];
  for (const root of roots) {
    for (const ext of [".vue", ".ts"]) {
      for (const file of walk(root, ext)) {
        // The formatter itself names these calls in its own documentation.
        if (file.endsWith("i18n/dateFormat.ts")) continue;
        const rel = relative(ROOT, file);
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const m = line.match(/\.toLocale(?:Date|Time)?String\s*\(/);
            if (m) found.push({ file: rel, line: i + 1, text: line.trim().slice(0, 90) });
          });
      }
    }
  }
  return found;
}

/**
 * Prose in a component's <script setup>, not just its template.
 *
 * The attribute scan above misses a whole class: strings COMPUTED into a label
 * rather than written in the markup. MessageComposer built its placeholder from a
 * four-way ternary of bare English ("Select a room to start chatting",
 * "Establishing secure session…") and nothing flagged it, because no `placeholder=`
 * attribute ever held those words.
 */
function scanVueScripts(): Finding[] {
  const found: Finding[] = [];
  for (const file of walk(resolve(ROOT, "apps/enigma/src"), ".vue")) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, "utf8");
    const end = src.indexOf("</script>");
    if (end < 0) continue;
    src
      .slice(0, end)
      .split("\n")
      .forEach((line, i) => {
        const code = line.trim();
        // Comments are prose on purpose — this codebase has a lot of it.
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        // A line already reaching for a translation is doing the right thing; any
        // English beside it is a documented fallback.
        if (/\bt\(/.test(code) || code.includes("$t(")) return;
        for (const m of code.matchAll(/["'`]([^"'`\n]{8,})["'`]/g)) {
          if (looksLikeProse(m[1])) found.push({ file: rel, line: i + 1, text: m[1] });
        }
      });
  }
  return found;
}

const show = (f: Finding[]) => f.map((x) => `${x.file}:${x.line}  ${x.text}`);

describe("no hard-coded user-facing English", () => {
  it("has none in .vue templates", () => {
    // Includes alt and aria-label: a Polish screen-reader user is still a
    // Polish user.
    expect(show(scanVue())).toEqual([]);
  });

  it("has none in the chat notices rakotis emits", () => {
    // These go through `t(key, englishFallback)` — the seam in
    // packages/rakotis/src/i18n/chatText.ts.
    expect(show(scanRakotisNotices())).toEqual([]);
  });

  it("has none computed inside <script setup>", () => {
    // Strings assembled in script and handed to the template as a value — the gap
    // the attribute scan above cannot see.
    expect(show(scanVueScripts())).toEqual([]);
  });

  it("formats every date through the app locale, not the OS", () => {
    // A raw toLocale*String call takes its language from the operating system, so
    // the app's language switch does not reach it. Use formatDate/formatTime from
    // rakotis instead — they read the locale the user actually chose.
    expect(show(scanDateFormatting())).toEqual([]);
  });

  it("actually detects prose, so an empty result means something", () => {
    // A guard that cannot fail is not a guard. If `looksLikeProse` is ever
    // loosened into uselessness, this is what notices.
    expect(looksLikeProse("Your name")).toBe(true);
    expect(looksLikeProse("No participants yet.")).toBe(true);
    expect(looksLikeProse("Reset encryption session")).toBe(true);
    // ...and does not fire on the things it must not.
    expect(looksLikeProse("Tor")).toBe(false);
    expect(looksLikeProse("flex items-center gap-2")).toBe(false);
    expect(looksLikeProse("mana-price-row")).toBe(false);
    expect(looksLikeProse("")).toBe(false);
  });
});
