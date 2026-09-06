import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PresentationParseError, columnsOf, dumps, loads, newPresentation,
  resolveSlot, slotsFor, sniffIsPresentation,
} from "../../src/formats/presentation";

// Golden files produced BY the Python module this ports
// (toto/memo/presentation_format.py). When a case fails, Python is right.
const DIR = join(__dirname, "..", "golden", "presentation");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const cases = readdirSync(DIR)
  .filter((f) => f.endsWith(".expected.json"))
  .map((f) => f.replace(".expected.json", ""));

describe("presentation format — golden files", () => {
  it("has fixtures to check against", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const name of cases) {
    describe(name, () => {
      const xml = read(`${name}.xml`);
      const expected = JSON.parse(read(`${name}.expected.json`));

      it("parses to the same deck Python built", () => {
        const p = loads(xml);
        expect(p.title).toBe(expected.title);
        expect(p.theme).toBe(expected.theme);
        expect(p.font).toBe(expected.font);
        expect(p.attrs).toEqual(expected.attrs);
        expect(p.slides.length).toBe(expected.slides.length);
        p.slides.forEach((slide, i) => {
          const want = expected.slides[i];
          expect(slide.id).toBe(want.id);
          expect(slide.title).toBe(want.title);
          expect(slide.layout).toBe(want.layout);
          expect(slide.attrs).toEqual(want.attrs);
          expect(slide.blocks.length).toBe(want.blocks.length);
          slide.blocks.forEach((block, j) => {
            const wb = want.blocks[j];
            expect(block.id).toBe(wb.id);
            expect(block.type).toBe(wb.type);
            expect(block.slot).toBe(wb.slot);
            expect(block.payload).toBe(wb.payload);
            expect(block.items).toEqual(wb.items);
            expect(block.render).toBe(wb.render);
            expect(block.attrs).toEqual(wb.attrs);
          });
        });
      });

      it("re-serialises byte-identically", () => {
        expect(dumps(loads(xml))).toBe(xml);
      });

      it("is idempotent", () => {
        expect(dumps(loads(dumps(loads(xml))))).toBe(xml);
      });
    });
  }
});

describe("the rules that cannot lose a byte", () => {
  it("round-trips a literal ]]> in a payload", () => {
    const xml = read("cdata_trap.xml");
    expect(xml).toContain("]]]]><![CDATA[>");
    expect(loads(xml).slides[0].blocks[0].payload).toBe("<p>before ]]> after</p>");
  });

  it("carries unknown attrs, unknown elements and unknown block types", () => {
    const p = loads(read("carry_through.xml"));
    expect(p.attrs["zz-root"]).toBe("keep");
    expect(p.slides[0].attrs["zz-slide"]).toBe("keep");
    expect(p.slides[0].blocks[0].type).toBe("futuretype"); // not coerced
    expect(p.slides[0].blocks[0].attrs["zz-block"]).toBe("keep");
    expect(p.slides[0].extra.join("")).toContain("weirdchild");
    expect(p.extra.join("")).toContain("deckwide");
  });

  it("keeps a formula's cached KaTeX beside its source", () => {
    // WeasyPrint runs no JavaScript: losing the render blanks every formula in
    // an exported deck.
    const p = loads(read("kitchen_sink.xml"));
    const formula = p.slides[1].blocks.find((b) => b.type === "formula")!;
    expect(formula.payload).toBe("e^{i\\pi}+1=0");
    expect(formula.render).toContain("RENDERED");
  });
});

describe("layouts and slots", () => {
  it("gives every layout its boxes in reading order", () => {
    expect(slotsFor("two-column")).toEqual(["left", "right"]);
    expect(slotsFor("grid")).toEqual(["a", "b", "c", "d"]);
    expect(slotsFor("title-content")).toEqual([""]);
  });

  it("falls back to the default layout's boxes for an unknown layout", () => {
    expect(slotsFor("nonsense")).toEqual([""]);
  });

  it("renders a block whose slot this layout lacks in the FIRST box", () => {
    // …and the file still says `right`, so switching back restores it.
    expect(resolveSlot("title-content", "right")).toBe("");
    expect(resolveSlot("two-column", "right")).toBe("right");
  });

  it("groups blocks into columns without losing any", () => {
    const p = loads(read("kitchen_sink.xml"));
    const cols = columnsOf(p.slides[1]);
    expect(cols.map(([slot]) => slot)).toEqual(["left", "right"]);
    const total = cols.reduce((n, [, blocks]) => n + blocks.length, 0);
    expect(total).toBe(p.slides[1].blocks.length);
  });
});

describe("reading v1", () => {
  it("upgrades a v1 slide to one html block, as Python does", () => {
    const upgraded = loads(read("legacy_v1.input.xml"));
    // The upgrade MINTS a block id (a v1 body had none), so the one random
    // value is normalised away — everything else must match Python byte for
    // byte, including the slide id, which v1 did carry.
    const normalise = (xml: string) => xml.replace(/id="b-[0-9a-f]{8}"/g, 'id="b-MINTED"');
    expect(normalise(dumps(upgraded))).toBe(normalise(read("legacy_v1.xml")));
    expect(upgraded.slides[0].blocks[0].type).toBe("html");
    expect(upgraded.slides[0].id).toBe("s-eeee1111"); // carried, not minted
  });

  it("treats a version=1 file containing blocks as v2", () => {
    // A hand-edit that added blocks but forgot to bump `version` must not be
    // flattened back to one HTML blob.
    const p = loads('<presentation version="1" title="x">' +
      '<slide id="s-1"><title>t</title><block id="b-1" type="text"><![CDATA[<p>a</p>]]></block></slide>' +
      "</presentation>");
    expect(p.slides[0].blocks[0].type).toBe("text");
  });
});

describe("guards", () => {
  it("refuses a non-presentation root", () => {
    expect(() => loads("<document/>")).toThrow(PresentationParseError);
  });

  it("refuses malformed XML", () => {
    expect(() => loads("<presentation><slide>")).toThrow(PresentationParseError);
  });

  it("clamps an unknown theme and font", () => {
    const p = loads('<presentation version="2" theme="neon" font="comic"/>');
    expect(p.theme).toBe("black");
    expect(p.font).toBe("sans");
  });

  it("sniffs a presentation without a full parse", () => {
    expect(sniffIsPresentation('<?xml version="1.0"?>\n<presentation version="2">')).toBe(true);
    expect(sniffIsPresentation('<document version="3">')).toBe(false);
  });

  it("makes a new deck with one slide", () => {
    expect(newPresentation("Hi").slides.length).toBe(1);
  });
});

// The defect this guards against is a real one, found and fixed in the sibling
// Django app `toto.cyprian` on 2026-09-06: its writer escaped a title (`&` ->
// `&amp;`) and its reader took the page apart with a REGEX, which returned the
// escaped text raw. Every save escaped an already-escaped title, so "Tom &
// Jerry" became "Tom &amp; Jerry", then "Tom &amp;amp; Jerry" — one `amp;` per
// save, without limit. It survived 87 tests because not one of them asserted
// `loads(dumps(d)) === d` with an entity in the text.
//
// This format should be immune by construction: `escText` writes the entity and
// the reader is a real XML parser reading `.textContent`, which resolves it. But
// "should be immune by construction" is exactly what was believed over there, so
// it is asserted rather than argued — and asserted over SEVERAL saves, because
// the failure is an accumulation that one round trip can hide.
describe("entities survive repeated saves (the cyprian defect)", () => {
  const HOSTILE = 'Tom & Jerry <not-a-tag> "quoted" — café';

  it("keeps a deck title byte-identical over five saves", () => {
    let deck = newPresentation(HOSTILE);
    expect(deck.title).toBe(HOSTILE);
    for (let i = 0; i < 5; i++) {
      deck = loads(dumps(deck));
      expect(deck.title).toBe(HOSTILE);
    }
  });

  it("keeps a slide title byte-identical over five saves", () => {
    let deck = newPresentation("deck");
    deck.slides[0].title = HOSTILE;
    for (let i = 0; i < 5; i++) {
      deck = loads(dumps(deck));
      expect(deck.slides[0].title).toBe(HOSTILE);
    }
  });

  it("reaches a fixed point: the second dump equals the first", () => {
    const deck = newPresentation(HOSTILE);
    deck.slides[0].title = HOSTILE;
    const once = dumps(deck);
    expect(dumps(loads(once))).toBe(once);
  });
});
