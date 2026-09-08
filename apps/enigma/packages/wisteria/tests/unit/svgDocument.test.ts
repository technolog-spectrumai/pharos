import { describe, expect, it } from "vitest";
import {
  emptySvgDocument,
  parseSvgDocument,
  serializeSvgDocument,
  shapesOf,
  withShapes,
  type MeasureText,
} from "../../src/svgDocument";
import { emptyDoc, toSvg, type Shape } from "../../src/sketchModel";

// The editor opens REAL .svg files, so this module is both a round-trip
// guarantee and an untrusted-input boundary.
//
// The round-trip half matters more than it looks: `toSvg` smooths a path's
// samples into a quadratic `d` that has no inverse, so without the `data-en-pts`
// hint every open/save cycle would move the drawing a little. The idempotence
// assertion below is what stops that regression from ever landing silently.

/** jsdom has no font metrics; the real editor measures on a canvas. */
const measure: MeasureText = (text, size) => ({ w: text.length * size * 0.6, h: size * 1.2 });

function parse(text: string) {
  const res = parseSvgDocument(text, measure);
  if (!res.ok) throw new Error(`expected a parse, got ${res.reason}: ${res.detail}`);
  return res;
}

/** One of every editable kind, with rotation, fill and opacity in play. */
function everyKind(): Shape[] {
  const base = { color: "#3b82f6", sw: 4, opacity: 0.75, fill: "#ef4444", rot: 30 };
  return [
    { ...base, id: "a", kind: "path", pts: [10, 10, 40, 25, 90, 60], fill: null },
    { ...base, id: "b", kind: "rect", x: 5, y: 6, w: 100, h: 50 },
    { ...base, id: "c", kind: "ellipse", cx: 200, cy: 120, rx: 40, ry: 25 },
    { ...base, id: "d", kind: "triangle", x: 300, y: 40, w: 80, h: 60 },
    { ...base, id: "e", kind: "arrow", x1: 400, y1: 40, x2: 520, y2: 90, fill: null },
    { ...base, id: "f", kind: "text", x: 40, y: 300, text: "hello", size: 24, tw: 72, th: 28.8, fill: null },
  ] as Shape[];
}

describe("round trip — our own files never drift", () => {
  it("recovers every shape kind from the SVG we wrote", () => {
    const doc = emptyDoc();
    doc.shapes = everyKind();
    const { doc: parsed } = parse(toSvg(doc));
    const back = shapesOf(parsed);

    expect(back.map((s) => s.kind)).toEqual(["path", "rect", "ellipse", "triangle", "arrow", "text"]);
    // Ids are regenerated (the file does not carry them), and a text shape's
    // measured box is re-measured on open — the model draws text with `fill`,
    // never a stroke, so `sw` is not emitted and cannot come back either.
    // Everything that AFFECTS RENDERING round-trips exactly.
    for (const [i, got] of back.entries()) {
      const want = doc.shapes[i];
      const drop = new Set(
        want.kind === "text" ? ["id", "sw", "tw", "th"] : ["id"],
      );
      const strip = (o: object) =>
        Object.fromEntries(Object.entries(o).filter(([k]) => !drop.has(k)));
      expect(strip(got)).toEqual(strip(want));
    }
  });

  it("is IDEMPOTENT — a second save is byte-identical to the first", () => {
    // The drift guard. A lossy path or triangle would show up here as a diff on
    // the second pass even when the first pass looked fine.
    const doc = emptyDoc();
    doc.shapes = everyKind();
    const once = serializeSvgDocument(parse(toSvg(doc)).doc);
    const twice = serializeSvgDocument(parse(once).doc);
    expect(twice).toBe(once);
  });

  it("keeps a freehand path's ORIGINAL samples, not the smoothed curve", () => {
    const pts = [0, 0, 13, 27, 41, 8, 90, 55];
    const doc = emptyDoc();
    doc.shapes = [{ id: "p", kind: "path", pts, color: "#111827", sw: 2, opacity: 1, fill: null, rot: 0 }];
    const back = shapesOf(parse(toSvg(doc)).doc)[0] as Shape & { pts: number[] };
    expect(back.pts).toEqual(pts);
  });

  it("round-trips the background without turning it into a shape", () => {
    const doc = emptyDoc();
    doc.background = "#111827";
    doc.shapes = [{ id: "r", kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "#ffffff", sw: 1, opacity: 1, fill: null, rot: 0 }];
    const { doc: parsed } = parse(toSvg(doc));
    expect(parsed.background).toBe("#111827");
    expect(shapesOf(parsed)).toHaveLength(1); // the bg rect is NOT a shape
  });
});

describe("foreign files — edit what we can, keep the rest", () => {
  const FOREIGN = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs><linearGradient id="g1"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <rect x="10" y="20" width="100" height="60" fill="none" stroke="#123456" stroke-width="3" opacity="1"/>
  <rect x="0" y="0" width="50" height="50" fill="url(#g1)" stroke="none" stroke-width="1" opacity="1"/>
  <g><circle cx="5" cy="5" r="5"/></g>
  <path d="M0 0 A 10 10 0 0 1 20 20"/>
</svg>`;

  it("makes a plain rect editable and leaves the rest opaque", () => {
    const { doc, opaqueCount } = parse(FOREIGN);
    expect(shapesOf(doc).map((s) => s.kind)).toEqual(["rect"]);
    // gradient-filled rect, the group, and the arc path.
    expect(opaqueCount).toBe(3);
    // <defs> is prologue, not a node.
    expect(doc.prologue).toHaveLength(1);
  });

  it("takes its geometry from the file's own viewBox", () => {
    const { doc } = parse(FOREIGN);
    expect([doc.width, doc.height]).toEqual([800, 600]);
  });

  it("preserves z-order across the editable/opaque boundary", () => {
    const { doc } = parse(FOREIGN);
    expect(doc.nodes.map((n) => n.kind)).toEqual(["shape", "opaque", "opaque", "opaque"]);
  });

  it("re-serializing an untouched foreign file keeps every opaque node", () => {
    const out = serializeSvgDocument(parse(FOREIGN).doc);
    expect(out).toContain("linearGradient");
    expect(out).toContain('url(#g1)');
    expect(out).toContain("<circle");
    expect(out).toContain("A 10 10 0 0 1 20 20");
    expect(out).toContain('viewBox="0 0 800 600"');
  });

  it("editing one shape does not disturb the opaque neighbours", () => {
    const { doc } = parse(FOREIGN);
    const moved = shapesOf(doc).map((s) => ({ ...s, x: 999 }) as Shape);
    const out = serializeSvgDocument(withShapes(doc, moved));
    expect(out).toContain('x="999"');
    expect(out).toContain("<circle");
    expect(out).toContain("linearGradient");
  });

  it("a new shape lands on top, after the opaque nodes", () => {
    const { doc } = parse(FOREIGN);
    const added: Shape = {
      id: "new", kind: "ellipse", cx: 1, cy: 2, rx: 3, ry: 4,
      color: "#000000", sw: 1, opacity: 1, fill: null, rot: 0,
    };
    const next = withShapes(doc, [...shapesOf(doc), added]);
    expect(next.nodes.at(-1)).toMatchObject({ kind: "shape" });
  });

  it("keeps a node opaque when it carries a style override we cannot honour", () => {
    const { doc, opaqueCount } = parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="4" height="4" style="stroke:red"/></svg>`,
    );
    expect(shapesOf(doc)).toHaveLength(0);
    expect(opaqueCount).toBe(1);
  });

  it("keeps a node opaque when its transform is not a plain rotate", () => {
    const { doc } = parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="4" height="4" transform="matrix(1 0 0 1 5 5)"/></svg>`,
    );
    expect(shapesOf(doc)).toHaveLength(0);
  });

  it("keeps a node opaque when its units are not user-space", () => {
    const { doc } = parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="50%" height="4mm"/></svg>`,
    );
    expect(shapesOf(doc)).toHaveLength(0);
  });

  it("reads a circle as an ellipse and a line as a headless arrow", () => {
    const { doc } = parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<circle cx="5" cy="6" r="3"/><line x1="0" y1="0" x2="9" y2="9"/></svg>`,
    );
    expect(shapesOf(doc).map((s) => s.kind)).toEqual(["ellipse", "arrow"]);
    expect(shapesOf(doc)[0]).toMatchObject({ rx: 3, ry: 3 });
  });

  it("falls back to a sane board when the file declares no geometry", () => {
    const { doc } = parse(`<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="1" height="1"/></svg>`);
    expect(doc.width).toBeGreaterThan(0);
    expect(doc.height).toBeGreaterThan(0);
  });
});

describe("untrusted input is refused, not sanitised", () => {
  const cases: [string, string][] = [
    ["a script element", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`],
    ["an event handler", `<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)" width="1" height="1"/></svg>`],
    ["a foreignObject", `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><b>hi</b></foreignObject></svg>`],
    ["a use reference", `<svg xmlns="http://www.w3.org/2000/svg"><use href="other.svg#x"/></svg>`],
    ["a remote image", `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>`],
    ["a javascript: href", `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>`],
    ["a css url()", `<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/x)" width="1" height="1"/></svg>`],
    ["an entity declaration", `<?xml version="1.0"?><!DOCTYPE s [<!ENTITY a "aaa">]><svg xmlns="http://www.w3.org/2000/svg"/>`],
  ];

  for (const [name, svg] of cases) {
    it(`refuses ${name}`, () => {
      const res = parseSvgDocument(svg, measure);
      expect(res.ok).toBe(false);
      // The caller needs a reason to show, and something to name in the message.
      if (!res.ok) expect(res.detail).toBeTruthy();
    });
  }

  it("refuses a file that is not an SVG at all", () => {
    const res = parseSvgDocument("just some text", measure);
    expect(res).toMatchObject({ ok: false, reason: "not-svg" });
  });

  it("round-trips a background image as an embedded raster, never a link", () => {
    const doc = emptySvgDocument();
    doc.backgroundImage = "data:image/png;base64,iVBORw0KGgo=";
    const out = serializeSvgDocument(doc);
    expect(out).toContain("data-en-bgimg");
    const back = parse(out).doc;
    expect(back.backgroundImage).toBe(doc.backgroundImage);
    // It is a document property, not one of the editable shapes.
    expect(shapesOf(back)).toHaveLength(0);
    expect(serializeSvgDocument(back)).toBe(out);
  });

  it("accepts an INLINE raster image — that is our own background format", () => {
    const res = parseSvgDocument(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/></svg>`,
      measure,
    );
    expect(res.ok).toBe(true);
  });

  it("caps an absurd declared canvas rather than trusting it", () => {
    const { doc } = parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 99999999 99999999"/>`);
    expect(doc.width).toBeLessThanOrEqual(6480);
    expect(doc.height).toBeLessThanOrEqual(6480);
  });
});

describe("a new drawing", () => {
  it("seeds a valid, empty, immediately re-parseable document", () => {
    const seeded = serializeSvgDocument(emptySvgDocument());
    const { doc, opaqueCount } = parse(seeded);
    expect(shapesOf(doc)).toEqual([]);
    expect(opaqueCount).toBe(0);
    expect(serializeSvgDocument(doc)).toBe(seeded);
  });
});

describe("a plain line survives being opened and saved", () => {
  const LINE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">' +
    '<line x1="10" y1="20" x2="110" y2="20" stroke="#111111" stroke-width="2"/>' +
    "</svg>";

  const reserialise = (text: string) => {
    const { doc } = parse(text);
    return serializeSvgDocument(withShapes(doc, shapesOf(doc)));
  };

  it("imports as an arrow with no head", () => {
    // Sharing the arrow kind is deliberate — it reuses every handle, transform
    // and hit-test — but the head must not come with it.
    const shapes = shapesOf(parse(LINE).doc);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].kind).toBe("arrow");
    expect((shapes[0] as { head?: boolean }).head).toBe(false);
  });

  it("does NOT grow an arrowhead when saved", () => {
    // The bug: the exporter always emitted the head polygon, so every plain
    // line acquired an arrowhead the first time the file was saved, and a
    // triangle drawn from three lines came back as three arrows — permanently.
    const out = reserialise(LINE);
    expect(out).toContain("<line");
    expect(out).not.toContain("<polygon");
  });

  it("goes out as a bare <line>, not as one of our groups", () => {
    // So it re-imports as a line everywhere else too — delta's editor, or
    // whatever drew it in the first place.
    expect(reserialise(LINE)).not.toContain('data-en-kind="arrow"');
  });

  it("is stable over repeated open/save cycles", () => {
    const once = reserialise(LINE);
    expect(reserialise(once)).toBe(once);
  });

  it("leaves a real arrow alone", () => {
    const arrowSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">' +
      '<g data-en-kind="arrow" opacity="1">' +
      '<line x1="0" y1="0" x2="50" y2="0" stroke="#111111" stroke-width="2"/>' +
      '<polygon points="50,0 44,-3 44,3" fill="#111111"/>' +
      "</g></svg>";
    const shapes = shapesOf(parse(arrowSvg).doc);
    expect((shapes[0] as { head?: boolean }).head).toBeUndefined();
    const out = reserialise(arrowSvg);
    expect(out).toContain("<polygon");
    expect(out).toContain('data-en-kind="arrow"');
  });
});

describe("an arrow's head width survives a save and reopen", () => {
  const reserialise = (text: string) => {
    const { doc } = parse(text);
    return serializeSvgDocument(withShapes(doc, shapesOf(doc)));
  };
  const wide =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">' +
    '<g data-en-kind="arrow" data-en-headw="5.4" opacity="1">' +
    '<line x1="0" y1="0" x2="100" y2="0" stroke="#111111" stroke-width="4"/>' +
    '<polygon points="100,0 88,-10 88,10" fill="#111111"/>' +
    "</g></svg>";

  it("reads the width back off the file", () => {
    const shapes = shapesOf(parse(wide).doc);
    expect((shapes[0] as { headWidth?: number }).headWidth).toBe(5.4);
  });

  it("writes it out again, so reopening does not re-cut the head", () => {
    // The head polygon is REGENERATED from the shaft on open. Without the hint
    // every arrow in an old drawing would silently take the current setting.
    expect(reserialise(wide)).toContain('data-en-headw="5.4"');
  });

  it("is stable over repeated cycles", () => {
    const once = reserialise(wide);
    expect(reserialise(once)).toBe(once);
  });

  it("says nothing about an ordinary arrow", () => {
    // Only a non-default width is written, so plain files stay unadorned.
    const plain = wide.replace(' data-en-headw="5.4"', "");
    expect(reserialise(plain)).not.toContain("data-en-headw");
  });
});
