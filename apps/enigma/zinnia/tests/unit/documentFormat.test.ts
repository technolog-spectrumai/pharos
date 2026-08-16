import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DocumentParseError, dumps, loads, newDocument, outline, sniffIsDocument,
  type CyDocument,
} from "../../src/formats/document";

// Golden files were produced BY the Python module this ports
// (toto/cyprian/document_format.py) — see tools/golden in the repo history.
// When a case fails, Python is right: it is the server that stores and
// re-sanitises these bytes, and a client that writes something else silently
// loses the difference on the next save.
const DIR = join(__dirname, "..", "golden", "document");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const cases = readdirSync(DIR)
  .filter((f) => f.endsWith(".expected.json"))
  .map((f) => f.replace(".expected.json", ""));

describe("document format — golden files from the Python implementation", () => {
  it("has fixtures to check against", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const name of cases) {
    describe(name, () => {
      const xml = read(`${name}.xml`);
      const expected = JSON.parse(read(`${name}.expected.json`));

      it("parses to the same document Python built", () => {
        const doc = loads(xml);
        expect(doc.title).toBe(expected.title);
        expect(doc.content).toBe(expected.content);
        expect(doc.font).toBe(expected.font);
        expect(doc.margins).toBe(expected.margins);
        expect(doc.toc).toBe(expected.toc);
        expect(doc.cover).toBe(expected.cover);
        expect(doc.meta).toEqual(expected.meta);
        expect(doc.attrs).toEqual(expected.attrs);
      });

      it("re-serialises byte-identically", () => {
        // The whole point: a zinnia save must not rewrite a document it merely
        // opened, or every round trip shows a spurious diff on the server.
        expect(dumps(loads(xml))).toBe(xml);
      });

      it("is idempotent", () => {
        expect(dumps(loads(dumps(loads(xml))))).toBe(xml);
      });
    });
  }
});

describe("the rules that cannot lose a byte", () => {
  it("round-trips a literal ]]> through CDATA", () => {
    const doc: CyDocument = { ...newDocument("T"), content: "<p>a ]]> b</p>" };
    const xml = dumps(doc);
    expect(xml).toContain("]]]]><![CDATA[>"); // split across two sections
    expect(loads(xml).content).toBe("<p>a ]]> b</p>");
  });

  it("carries unknown root attributes and unknown elements through", () => {
    const xml = read("carry_through.xml");
    const doc = loads(xml);
    expect(doc.attrs["zz-custom"]).toBe("keep-me");
    expect(doc.extra.join("")).toContain("futurething");
    expect(dumps(doc)).toContain('zz-custom="keep-me"');
    expect(dumps(doc)).toContain("<futurething");
  });

  it("sorts unknown attributes so output is deterministic", () => {
    const xml = dumps({
      ...newDocument("x"),
      attrs: { "zz-b": "2", "aa-a": "1" },
    });
    expect(xml.indexOf("aa-a")).toBeLessThan(xml.indexOf("zz-b"));
  });
});

describe("reading older versions", () => {
  it("folds a v1 file into one body, as Python does", () => {
    const converted = loads(read("legacy_v1.input.xml"));
    // Compare against what Python's dumps() made of the same input.
    expect(dumps(converted)).toBe(read("legacy_v1.xml"));
  });
});

describe("guards", () => {
  it("refuses a non-document root", () => {
    expect(() => loads("<notadoc/>")).toThrow(DocumentParseError);
  });

  it("refuses malformed XML", () => {
    expect(() => loads("<document><content>")).toThrow(DocumentParseError);
  });

  it("returns a blank document for empty input", () => {
    expect(loads("   ").content).toBe("<p></p>");
  });

  it("clamps an unknown font and margin to the defaults", () => {
    const doc = loads('<document version="3" font="comic" margins="huge"><content><![CDATA[<p/>]]></content></document>');
    expect(doc.font).toBe("serif");
    expect(doc.margins).toBe("normal");
  });

  it("sniffs a document without a full parse", () => {
    expect(sniffIsDocument('<?xml version="1.0"?>\n<document version="3">')).toBe(true);
    expect(sniffIsDocument("<svg xmlns='...'>")).toBe(false);
  });
});

describe("the outline, derived from headings", () => {
  it("lists h1-h3 in order and skips empty ones", () => {
    const heads = outline("<h1>One</h1><p>x</p><h2>Two</h2><h3></h3>");
    expect(heads.map((h) => h.text)).toEqual(["One", "Two"]);
    expect(heads.map((h) => h.level)).toEqual([1, 2]);
  });

  it("keeps an existing id rather than minting one", () => {
    expect(outline('<h1 id="intro">One</h1>')[0].id).toBe("intro");
  });
});
