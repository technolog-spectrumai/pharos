// The writer's stylesheet, asserted as RULES rather than as rendering.
//
// This file exists because a bulleted list shipped with no bullets. The nodes
// were right, the toolbar was right, and every DOM test passed — because
// `style.css` imports Tailwind and jsdom applies none of it. Preflight sets
// `list-style: none` on every ul and ol in a real browser; in a test there is
// nothing to reset and nothing to restore, so the bug was invisible to exactly
// the kind of test that would normally catch it.
//
// So this reads the stylesheet as text. It is a blunt instrument and it is the
// only one that works here: the assertion is that the RULE exists, because the
// rule is what the browser was missing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "../../src/document.css"), "utf8");

/** The declarations for one selector, with comments stripped so a selector
 *  named only in prose never counts as a rule. */
function rulesFor(selector: string): string[] {
  const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = match[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector)) out.push(match[2].trim());
  }
  return out;
}

/** Everything a selector ends up declaring, as one string. */
const declared = (selector: string) => rulesFor(selector).join(" ");

describe("list markers", () => {
  // Both surfaces, together. `.cy-doc` is the editor canvas; `.cy-content` is
  // the paginated body that pdf/documentHtml.ts inlines this same file into.
  // A fix applied to one and not the other is how the screen and the PDF come
  // to disagree, so they are asserted as a pair on purpose.
  const SURFACES = [".cy-doc", ".cy-content"] as const;

  it.each(SURFACES)("gives %s bullets a marker", (surface) => {
    expect(declared(`${surface} ul`)).toMatch(/list-style:\s*disc/);
  });

  it.each(SURFACES)("gives %s numbered lists a marker", (surface) => {
    expect(declared(`${surface} ol`)).toMatch(/list-style:\s*decimal/);
  });

  it.each(SURFACES)("puts %s markers outside, so wrapped lines align", (surface) => {
    // `inside` is the browser default and puts the second line of a wrapped
    // item under the bullet instead of under the first word.
    expect(declared(`${surface} ul`)).toMatch(/outside/);
    expect(declared(`${surface} ol`)).toMatch(/outside/);
  });

  it.each(SURFACES)("changes %s marker with nesting depth", (surface) => {
    // Depth should be readable without counting indents — the same thing a
    // word processor does.
    expect(declared(`${surface} ul ul`)).toMatch(/circle/);
    expect(declared(`${surface} ul ul ul`)).toMatch(/square/);
    expect(declared(`${surface} ol ol`)).toMatch(/lower-alpha/);
    expect(declared(`${surface} ol ol ol`)).toMatch(/lower-roman/);
  });

  it("still keeps the table of contents unmarked", () => {
    // `.cy-toc ol` is a list of links, not a bulleted list, and its `none` is
    // deliberate. A blanket `ol { list-style: decimal }` would put numbers
    // down the side of the contents page.
    expect(declared(".cy-toc ol")).toMatch(/list-style:\s*none/);
  });

  it("declares the markers where the PDF can see them", () => {
    // documentHtml.ts inlines this file with `?raw`, so a rule that lived in a
    // Vue component's <style scoped> would fix the editor and silently leave
    // the export broken. The guard is that the rule is in THIS file.
    expect(CSS).toMatch(/\.cy-content ul[^{]*\{[^}]*list-style/);
  });
});
