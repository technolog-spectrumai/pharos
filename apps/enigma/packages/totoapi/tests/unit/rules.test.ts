// THE RULES BOTH EDITORS MUST NOT BREAK, asserted against the source.
//
// Stage 11.6 wrote these down as prose. Prose in a checklist is a thing people
// stop reading; this is the same list as a test, and it lives in the package
// both apps depend on so neither can drift away from it alone.
//
// Every rule here is a way to be subtly, silently wrong — the client keeps
// working and the person using it is misled. That is why they are worth a
// grep-shaped test rather than a code review: each one reads as an
// optimisation when somebody writes it.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// FOUR levels: tests/unit → tests → totoapi → packages → the repo root.
// Three was the first guess and every rule below passed vacuously; the
// "finds both apps" guard is what caught it, which is what it is for.
const REPO = join(__dirname, "../../../..");
const APPS = ["py_editor", "tex_editor"];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every source file of both apps, plus this package's own. */
function sources(): Array<[string, string]> {
  const roots = [
    ...APPS.map((app) => [app, join(REPO, "apps", app, "src")] as const),
    ["totoapi", join(REPO, "packages/totoapi/src")] as const,
  ];
  return roots.flatMap(([label, root]) =>
    walk(root)
      .filter((f) => /\.(ts|vue)$/.test(f))
      .map((f) => [`${label}/${f.slice(root.length + 1)}`, readFileSync(f, "utf8")] as [string, string]),
  );
}

/** Strip comments, so a rule EXPLAINING a forbidden pattern does not trip it.
 *
 *  This bit the toto side already — a docstring naming a forbidden call tripped
 *  its own boundary test — and the fix there was the same: look at code, not at
 *  prose. Both of these apps document what they must not do, at length. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const FILES = sources();

describe("the source set", () => {
  it("finds both apps (the walker itself works)", () => {
    // Without this every rule below passes vacuously the day a path changes.
    for (const app of APPS) {
      expect(FILES.some(([label]) => label.startsWith(`${app}/`)),
             `no sources found for ${app}`).toBe(true);
    }
    expect(FILES.length).toBeGreaterThan(15);
  });

  it("strips comments before matching, so documenting a rule is allowed", () => {
    expect(code("// writable = true\nconst x = 1;")).not.toContain("writable = true");
    expect(code("/* text.length */\nconst y = 2;")).not.toContain("text.length");
    expect(code("const keep = 1; // gone")).toContain("const keep = 1;");
  });
});

describe("never decide `writable` in the client", () => {
  // A client that inferred it would have to know the permission rules, and
  // would be wrong the day they change. The server answers it per workspace.
  it("nothing assigns or computes writable", () => {
    for (const [label, source] of FILES) {
      const body = code(source);
      expect(body, `${label} assigns writable`).not.toMatch(/writable\s*[=:]\s*(true|false)/);
      expect(body, `${label} infers writable from owner`)
        .not.toMatch(/writable\s*=\s*.*owner/);
    }
  });
});

describe("never save a truncated buffer", () => {
  // The server shortens a file over its read ceiling; saving that back writes
  // the visible part over the whole thing and the tail is gone.
  it("every app's save path consults saveRefusal", () => {
    for (const app of APPS) {
      const store = FILES.find(([label]) => label === `${app}/platform/workspace.ts`);
      expect(store, `${app} has no workspace store`).toBeDefined();
      const body = code(store![1]);
      expect(body, `${app} does not check saveRefusal before writing`)
        .toMatch(/saveRefusal\(/);
      expect(body, `${app}'s saveRefusal ignores truncated`)
        .toMatch(/truncated/);
    }
  });
});

describe("never call a raised script an error", () => {
  // The server returns a traceback as an ordinary result with a non-zero exit
  // code. Treating a non-zero exit as a failure shows "we could not run your
  // code" for a NameError and throws the traceback away.
  it("nothing branches a run result on exit_code being non-zero", () => {
    for (const [label, source] of FILES) {
      const body = code(source);
      expect(body, `${label} treats a non-zero exit as a failure`)
        .not.toMatch(/exit_?[Cc]ode\s*(!==|!=)\s*0\s*\)?\s*(\{|throw|return\s+(null|false))/);
    }
  });
});

describe("never interpolate `tier` into a sentence", () => {
  // `isolates_kernel` is a boolean beside the tier string precisely so a client
  // cannot render "your code runs in a {tier}" for a container. It is a
  // whitelist server-side, so an unknown tier reads as the weaker claim.
  it("nothing puts tier in a template string or a translation argument", () => {
    for (const [label, source] of FILES) {
      const body = code(source);
      expect(body, `${label} interpolates a tier`).not.toMatch(/\$\{[^}]*\btier\b[^}]*\}/);
      expect(body, `${label} passes tier to a translation`)
        .not.toMatch(/t\([^)]*\{\s*tier\s*[,:}]/);
    }
  });
});

describe("never recompute a log offset from text length", () => {
  // `offset` is a BYTE offset into the accumulated output. `text.length` is a
  // character count and desynchronises on the first non-ASCII line — after
  // which every slice starts mid-codepoint.
  it("nothing derives an offset from a string length", () => {
    for (const [label, source] of FILES) {
      const body = code(source);
      expect(body, `${label} computes an offset from a length`)
        .not.toMatch(/offset\s*[+]?=\s*[\w.]*\.length/);
      expect(body, `${label} advances an offset by text length`)
        .not.toMatch(/offset:\s*[\w.]*text[\w.]*\.length/);
    }
  });
});

describe("never keep the token on the JavaScript side", () => {
  // It lives in the OS keyring and is attached inside Rust. Anything that
  // stored it here would be readable by a document the user merely opened.
  it("nothing PERSISTS a token", () => {
    // Persistence is the rule, not "no variable called token". A component
    // needs a `ref` bound to the input — that was the first version of this
    // check and it failed on `const token = ref("")` in the connect form,
    // which is both unavoidable and correct.
    //
    // What must never happen is the value outliving the form.
    for (const [label, source] of FILES) {
      const body = code(source);
      for (const store of ["localStorage", "sessionStorage"]) {
        expect(body, `${label} puts a token in ${store}`)
          .not.toMatch(new RegExp(`${store}\\.setItem\\([^)]*token`, "i"));
      }
    }
  });

  it("the connect form clears the token field after every attempt", () => {
    // Including on FAILURE. A token left in a field survives into a
    // screenshot, a bug report, and the next person to walk past the screen.
    for (const app of APPS) {
      const view = FILES.find(([label]) => label === `${app}/views/ConnectView.vue`);
      expect(view, `${app} has no connect view`).toBeDefined();
      const body = code(view![1]);
      expect(body, `${app} does not clear the token field`)
        .toMatch(/finally\s*\{[^}]*token\.value\s*=\s*""/s);
    }
  });

  it("the client's getToken always returns null", () => {
    // `createClient` takes one because the seam is general; these apps never
    // use it, because `tauriFetch` routes through Rust which attaches the
    // header itself.
    for (const app of APPS) {
      const session = FILES.find(([label]) => label === `${app}/platform/session.ts`);
      expect(session, `${app} has no session module`).toBeDefined();
      expect(code(session![1]), `${app} hands a token to the client`)
        .toMatch(/getToken:\s*\(\)\s*=>\s*null/);
    }
  });
});

describe("never call forgetting a token 'signing out'", () => {
  // It is not revocation. The token stays valid until somebody revokes it on
  // the server, and wording that implies otherwise is a lie in the direction
  // that matters.
  it("neither catalogue says sign out", () => {
    for (const app of APPS) {
      for (const locale of ["en", "pl"]) {
        const cat = FILES.find(([label]) => label === `${app}/i18n/${locale}.ts`);
        expect(cat, `${app}/${locale} missing`).toBeDefined();
        // `code()`, not the raw file: BOTH catalogues carry a comment saying
        // "deliberately not sign out", and reading the prose made this rule
        // fail on its own explanation. The same trap the toto side hit with a
        // docstring naming a forbidden call — look at strings, not at comments.
        expect(code(cat![1]).toLowerCase(), `${app}/${locale} says sign out`)
          .not.toMatch(/sign out|signed out|wyloguj/);
      }
    }
  });
});

describe("the two apps stay two apps", () => {
  it("neither imports the other", () => {
    // They share through `totoapi` and `petalite`. A direct import would make
    // one app's release drag the other's, and the whole point of two bundles is
    // that they ship apart.
    for (const [label, source] of FILES) {
      for (const other of APPS) {
        if (label.startsWith(`${other}/`)) continue;
        expect(code(source), `${label} imports ${other}`)
          .not.toMatch(new RegExp(`from ["'][^"']*${other}/`));
      }
    }
  });

  it("each keeps its own storage keys, so one cannot move the other", () => {
    for (const app of APPS) {
      const config = FILES.find(([label]) => label === `${app}/config.ts`);
      expect(config, `${app} has no config.ts`).toBeDefined();
      expect(config![1], `${app} does not namespace its settings key`)
        .toMatch(new RegExp(`["']${app}:`));
    }
  });
});
