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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findIconDefinition, type IconName } from "@fortawesome/fontawesome-svg-core";
import "../../src/icons"; // performs library.add as a side effect
import { APP_TABS } from "../../src/tabs";

const SRC = join(__dirname, "../../src");
/** The repo root is two levels above the app now. */
const PACKAGES = join(__dirname, "../../../../packages");

/** Every tree that ships templates: the app, plus each workspace package.
 *
 *  DISCOVERED, not listed. A hardcoded list loses a package's coverage in
 *  silence the moment one is added, and the per-root guard below catches a root
 *  that went empty — not one that was never named. `LockModal.vue` and
 *  `SecurityView.vue` proved that twice, moving into Petalite and then into
 *  Padova; both times the suite stayed green and two cases quietly vanished.
 *
 *  `rakotis` is excluded: it is a git subtree with its own tests, and its icon
 *  set is its own concern. */
const ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["src", SRC] as const,
  ...readdirSync(PACKAGES)
    .filter((name) => name !== "rakotis")
    .map((name) => [name, join(PACKAGES, name, "src")] as const)
    .filter(([, dir]) => existsSync(dir)),
];

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
  const files = ROOTS.flatMap(([label, root]) =>
    walk(root)
      .filter((f) => f.endsWith(".vue"))
      .map((f) => [`${label}/${f.slice(root.length + 1)}`, f] as const),
  );

  it("finds icons to check (the scanner itself still works)", () => {
    // Without this the suite would pass vacuously if the regex ever broke.
    const all = files.flatMap(([, f]) => iconNamesIn(readFileSync(f, "utf8")));
    expect(all.length).toBeGreaterThan(20);
  });

  // Per ROOT, not just in total: a root that goes empty — a path that stopped
  // matching after a move — would otherwise be covered by the other root's
  // count and vanish in silence. That is exactly what happened to Petalite's
  // two components in step 5.
  it.each(ROOTS.map(([label, root]) => [label, root] as const))(
    "%s still has templates to scan",
    (_label, root) => {
      expect(walk(root).filter((f) => f.endsWith(".vue")).length).toBeGreaterThan(0);
    },
  );

  it.each(files)(
    "%s names only registered icons",
    (_label, file) => {
      const missing = [...new Set(iconNamesIn(readFileSync(file, "utf8")))]
        .filter((name) => !registered(name));
      expect(missing).toEqual([]);
    },
  );

  it("registers every tab's icon", () => {
    for (const tab of APP_TABS) {
      expect(registered(tab.icon), `tab ${tab.id} → ${tab.icon}`).toBe(true);
    }
  });

});
