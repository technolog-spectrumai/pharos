// Every icon the templates name must resolve to a real glyph.
//
// FontAwesome fails SILENTLY: an unregistered name renders an empty comment
// node, so the button keeps its border, its tooltip and its click handler and
// simply shows nothing. Behaviour tests pass, and the hole is only visible to
// someone looking at that exact button. Two icon bugs have shipped in this repo
// that way.
//
// THE ROOTS ARE DERIVED FROM THIS APP'S DEPENDENCIES, which is where this
// differs from the sibling apps' copies. Theirs walk every directory under
// `packages/`, so this app inherited failures for `padova/LockModal.vue` and
// `wisteria/SketchToolbar.vue` — components it does not depend on, does not
// import and never mounts, demanding a padlock and a pen-nib in its library for
// nothing.
//
// Reading `package.json` keeps the set honest in both directions: adding a
// dependency brings its templates under the check automatically, and dropping
// one stops demanding icons for screens that are gone.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findIconDefinition, type IconName } from "@fortawesome/fontawesome-svg-core";
import "../../src/icons"; // performs library.add as a side effect

const APP = join(__dirname, "../..");
const SRC = join(APP, "src");
const PACKAGES = join(APP, "../../packages");

/** Packages that ship no templates. Named, not detected: "skip any root with
 *  no .vue files" would disarm the per-root guard below, which exists to catch
 *  a root that WENT empty after a move. */
const NO_TEMPLATES = new Set(["totoapi", "rakotis"]);

/** This app's workspace dependencies, from its own manifest. */
function workspaceDeps(): string[] {
  const manifest = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => existsSync(join(PACKAGES, name)))
    .filter((name) => !NO_TEMPLATES.has(name));
}

const ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["src", SRC] as const,
  ...workspaceDeps()
    .map((name) => [name, join(PACKAGES, name, "src")] as const)
    .filter(([, dir]) => existsSync(dir)),
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function registered(name: string): boolean {
  return Boolean(findIconDefinition({ prefix: "fas", iconName: name as IconName }));
}

/** Icon names as the templates write them: `icon="play"` and `:icon="'play'"`. */
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
    expect(all.length).toBeGreaterThan(0);
  });

  it("scans this app's own templates", () => {
    // The root that matters most, and the one a path change would silently
    // empty.
    expect(files.filter(([label]) => label.startsWith("src/")).length)
      .toBeGreaterThan(0);
  });

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

  it("does not demand icons for packages this app does not use", () => {
    // The reason this file differs from the sibling apps' copies. padova is
    // the sealing surface and wisteria the drawing engine; neither is a
    // dependency here, and scanning them would demand a library of glyphs for
    // screens this app cannot show.
    const scanned = new Set(ROOTS.map(([label]) => label));
    expect(scanned.has("padova")).toBe(false);
    expect(scanned.has("wisteria")).toBe(false);
  });
});
