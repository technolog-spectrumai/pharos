// The two catalogues must carry the same keys, and neither may go silently
// English.
//
// WORTH HAVING HERE SPECIFICALLY. Enigma has `i18nCoverage.test.ts` and
// `i18n.test.ts`; lazurite, primula and sketch have neither, so a missing
// Polish key on the zinnia side surfaces as a raw `connect.tokenHint` on
// somebody's screen and nothing catches it. This app starts with the check
// rather than acquiring it after the first bug.
import { describe, expect, it } from "vitest";
import en from "../../src/i18n/en";
import pl from "../../src/i18n/pl";

type Tree = Record<string, unknown>;

function paths(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const here = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object" && !Array.isArray(value)
      ? paths(value as Tree, here)
      : [here];
  });
}

function at(tree: Tree, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, key) => (node as Tree | undefined)?.[key], tree);
}

/** `{name}` placeholders, which are a contract between the two catalogues:
 *  a translation that drops one renders a sentence with a hole in it. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("the catalogues", () => {
  const enPaths = paths(en as unknown as Tree);
  const plPaths = paths(pl as unknown as Tree);

  it("finds keys to check (the walker itself works)", () => {
    // Without this the suite would pass vacuously if `paths` ever broke.
    expect(enPaths.length).toBeGreaterThan(20);
  });

  it("have exactly the same keys", () => {
    expect([...plPaths].sort()).toEqual([...enPaths].sort());
  });

  it("every string is non-empty", () => {
    for (const path of enPaths) {
      expect(String(at(en as unknown as Tree, path)).trim()).not.toBe("");
      expect(String(at(pl as unknown as Tree, path)).trim()).not.toBe("");
    }
  });

  it("placeholders match, so no sentence renders with a hole", () => {
    for (const path of enPaths) {
      const a = placeholders(String(at(en as unknown as Tree, path)));
      const b = placeholders(String(at(pl as unknown as Tree, path)));
      expect(b, `placeholders differ at ${path}`).toEqual(a);
    }
  });

  it("Polish is TRANSLATED, not copied", () => {
    // A catalogue built by copying en.ts and meaning to come back to it is the
    // usual way a locale ships half done. Proper nouns are allowed to match;
    // whole sentences are not.
    const identical = enPaths.filter(
      (path) => at(en as unknown as Tree, path) === at(pl as unknown as Tree, path));
    expect(identical, `identical strings: ${identical.join(", ")}`).toEqual([]);
  });

  it("says where the token comes from, in both languages", () => {
    // The one sentence this app cannot do without: the token is minted on the
    // server, and without saying so the field is a dead end. Named explicitly
    // because it is copy a tidy-up would shorten away.
    expect(en.connect.tokenHint).toMatch(/Compute Capsules/);
    expect(pl.connect.tokenHint).toMatch(/Kapsuły Obliczeniowe/);
  });

  it("never calls forgetting a token 'signing out', in either language", () => {
    // It is not revocation. The token stays valid until somebody revokes it on
    // the server, and wording that implies otherwise is a lie in the direction
    // that matters.
    for (const cat of [en, pl]) {
      expect(cat.connect.forget.toLowerCase()).not.toMatch(/sign out|wyloguj/);
      expect(cat.connect.forgetHint).toMatch(/server|serwerze/);
    }
  });
});
