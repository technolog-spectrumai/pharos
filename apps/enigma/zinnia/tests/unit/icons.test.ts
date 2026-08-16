// Every icon the templates name must resolve to a real glyph.
//
// FontAwesome fails SILENTLY: an unregistered name renders an empty comment
// node, so the button keeps its border, its tooltip and its click handler and
// simply shows nothing. Behaviour tests pass, and the hole is only visible to
// someone looking at that exact button. Both icon bugs in this app shipped that
// way — a batch of names never added to the library, and a tone whose map key
// was spelled differently from the format's value.
//
// So this test reads the source the way the browser does and checks the names.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findIconDefinition, type IconName } from "@fortawesome/fontawesome-svg-core";
import { TONE_ICONS } from "../../src/icons";
import "../../src/icons"; // performs library.add as a side effect
import { APP_TABS } from "../../src/tabs";

const SRC = join(__dirname, "../../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const registered = (name: string) =>
  Boolean(findIconDefinition({ prefix: "fas", iconName: name as IconName }));

/** Icon names written as literals in a template:
 *    icon="pencil"              — static attribute
 *    :icon="'moon'"             — a literal inside a binding (ternaries included)
 *  Not reachable this way: `:icon="tab.icon"`, `:icon="TONE_ICONS[tone]"`,
 *  `:icon="String(level)"` — each of those is asserted separately below. */
function iconNamesIn(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/\sicon="([a-z0-9-]+)"/g)) names.push(m[1]);
  for (const m of source.matchAll(/\s:icon="([^"]*)"/g)) {
    for (const lit of m[1].matchAll(/'([a-z0-9-]+)'/g)) names.push(lit[1]);
  }
  return names;
}

describe("icon registration", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".vue"));

  it("finds icons to check (the scanner itself still works)", () => {
    // Without this the suite would pass vacuously if the regex ever broke.
    const all = files.flatMap((f) => iconNamesIn(readFileSync(f, "utf8")));
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f] as const))(
    "%s names only registered icons",
    (_label, file) => {
      const missing = [...new Set(iconNamesIn(readFileSync(file, "utf8")))]
        .filter((name) => !registered(name));
      expect(missing).toEqual([]);
    },
  );

  it("registers every callout tone's icon", () => {
    // The bug this test exists for: TONE_ICONS was keyed `warning` while the
    // format's tone is `warn`, so the lookup was undefined. Typing the map to
    // `Record<Tone, …>` makes that a build error; this covers the other half —
    // a key that is right but names an icon nobody registered.
    for (const [tone, icon] of Object.entries(TONE_ICONS)) {
      expect(registered(icon), `tone ${tone} → ${icon}`).toBe(true);
    }
  });

  it("registers every tab's icon", () => {
    for (const tab of APP_TABS) {
      expect(registered(tab.icon), `tab ${tab.id} → ${tab.icon}`).toBe(true);
    }
  });

  it("registers the heading-level digits", () => {
    // `:icon="String(level)"` in the writer's toolbar — the only icon names
    // computed from a number, so they cannot be scanned out of the template.
    for (const digit of ["1", "2", "3"]) {
      expect(registered(digit), `heading ${digit}`).toBe(true);
    }
  });
});
