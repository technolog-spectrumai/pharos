import { describe, expect, it } from "vitest";
import {
  arrowHead,
  BACKGROUND_COLORS,
  COLOR_NAME_KEYS,
  DEFAULT_SLOT_COLORS,
  distToShape,
  distToShapeRotated,
  emptyDoc,
  EXTRA_COLORS,
  hitTest,
  MAX_BG_IMAGE_CHARS,
  normalizeSlots,
  normDeg,
  PALETTE_SLOTS,
  pathD,
  PICKER_COLORS,
  rotatePoint,
  rotateShape,
  scaleShape,
  shapeBounds,
  shapePivot,
  toSvg,
  translateShape,
  trianglePoints,
  validateBackgroundImage,
  validateDoc,
  validateShape,
  type PathShape,
  type Shape,
  type SketchCaps,
} from "../../src/components/sketch/sketchModel";

const CAPS: SketchCaps = { maxShapes: 1000, maxTextLen: 200 };

function path(id: string, pts: number[]): PathShape {
  return { id, kind: "path", color: "#111827", sw: 4, opacity: 1, fill: null, rot: 0, pts };
}

/** Shorthand for a non-path shape literal with the shared base fields filled in. */
function shape(over: Record<string, unknown>): Shape {
  return { id: "s", color: "#111827", sw: 4, opacity: 1, fill: null, rot: 0, ...over } as Shape;
}

describe("pathD", () => {
  it("handles empty, single, and two-point strokes", () => {
    expect(pathD([])).toBe("");
    expect(pathD([5, 5])).toContain("M5 5");
    expect(pathD([0, 0, 10, 10])).toBe("M0 0L10 10");
  });

  it("is append-safe: extending a stroke never rewrites drawn geometry", () => {
    // Why midpoint-quadratic rather than Catmull-Rom — a stroke is re-serialized on
    // every pointermove and must not visually shift.
    const base = [0, 0, 10, 10, 20, 0, 30, 10];
    const a = pathD(base);
    const b = pathD([...base, 40, 0]);
    expect(b.startsWith(a.slice(0, a.lastIndexOf("L")))).toBe(true);
  });
});

describe("bounds and pivot", () => {
  it("covers every kind", () => {
    expect(shapeBounds(path("p", [0, 0, 10, 20]))).toEqual({ x: 0, y: 0, w: 10, h: 20 });
    expect(shapeBounds(shape({ kind: "ellipse", cx: 50, cy: 50, rx: 10, ry: 5 }))).toEqual({
      x: 40,
      y: 45,
      w: 20,
      h: 10,
    });
    expect(shapeBounds(shape({ kind: "rect", x: 1, y: 2, w: 3, h: 4 }))).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(shapeBounds(shape({ kind: "arrow", x1: 10, y1: 0, x2: 0, y2: 10 }))).toEqual({
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    });
  });

  it("puts the pivot at the centre of the unrotated bounds", () => {
    expect(shapePivot(shape({ kind: "rect", x: 0, y: 0, w: 100, h: 50 }))).toEqual({ cx: 50, cy: 25 });
  });

  it("returns zero bounds for an empty path instead of Infinity", () => {
    expect(shapeBounds(path("p", []))).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("rotation", () => {
  it("normalizes degrees into [0,360)", () => {
    expect(normDeg(0)).toBe(0);
    expect(normDeg(370)).toBe(10);
    expect(normDeg(-90)).toBe(270);
    expect(normDeg(360)).toBe(0);
  });

  it("rotates a point clockwise, matching SVG's positive direction", () => {
    // (10,0) about the origin by +90° lands on (0,10) in SVG's y-down space.
    const p = rotatePoint(10, 0, 0, 0, 90);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(10, 6);
  });

  it("is a no-op at 0 degrees", () => {
    expect(rotatePoint(3, 7, 1, 1, 0)).toEqual({ x: 3, y: 7 });
  });

  it("round-trips a point through +deg then -deg", () => {
    const a = rotatePoint(37, -12, 5, 5, 57);
    const b = rotatePoint(a.x, a.y, 5, 5, -57);
    expect(b.x).toBeCloseTo(37, 6);
    expect(b.y).toBeCloseTo(-12, 6);
  });

  it("stores an absolute normalized angle", () => {
    expect(rotateShape(path("p", [0, 0, 1, 1]), 450).rot).toBe(90);
    expect(rotateShape(path("p", [0, 0, 1, 1]), -45).rot).toBe(315);
  });

  it("hits a rotated shape where it is drawn, not where it used to be", () => {
    // A wide, short rect. Rotated 90° about its centre it becomes tall and narrow,
    // so the old left edge is no longer under the old point.
    const flat = shape({ kind: "rect", x: 0, y: 40, w: 100, h: 20 });
    const turned = { ...flat, rot: 90 } as Shape;
    // Pivot is (50,50). Unrotated the left edge sits at x=0,y=50; rotated it moves
    // to (50,0) — the top of the turned rect.
    expect(hitTest([flat], 0, 50, 2)).toBe("s");
    expect(hitTest([turned], 0, 50, 2)).toBeNull();
    expect(hitTest([turned], 50, 0, 2)).toBe("s");
  });

  it("keeps the pivot itself invariant under rotation", () => {
    const s = shape({ kind: "rect", x: 0, y: 0, w: 80, h: 40, fill: "#3b82f6", rot: 33 });
    const { cx, cy } = shapePivot(s);
    // A filled shape contains its own centre at any angle.
    expect(distToShapeRotated(s, cx, cy)).toBe(0);
  });

  it("agrees with the unrotated math when rot is 0", () => {
    const s = shape({ kind: "rect", x: 0, y: 0, w: 10, h: 10 });
    expect(distToShapeRotated(s, 5, 30)).toBe(distToShape(s, 5, 30));
  });

  it("rotates freehand strokes and text too, not just boxed shapes", () => {
    const stroke = { ...path("p", [0, 50, 100, 50]), rot: 90 } as Shape;
    // Horizontal line through the pivot (50,50) becomes vertical.
    expect(hitTest([stroke], 50, 10, 3)).toBe("p");
    expect(hitTest([stroke], 10, 50, 3)).toBeNull();

    const txt = shape({ kind: "text", x: 0, y: 100, text: "hi", size: 20, tw: 100, th: 20, rot: 90 });
    const { cx, cy } = shapePivot(txt);
    expect(distToShapeRotated(txt, cx, cy)).toBe(0);
  });

  it("emits a rotate transform in the SVG only when rotated", () => {
    const doc = emptyDoc();
    doc.shapes.push(shape({ kind: "rect", x: 0, y: 0, w: 100, h: 50, rot: 45 }));
    const svg = toSvg(doc);
    expect(svg).toContain('transform="rotate(45 50 25)"');

    const flat = emptyDoc();
    flat.shapes.push(shape({ kind: "rect", x: 0, y: 0, w: 100, h: 50 }));
    expect(toSvg(flat)).not.toContain("transform=");
  });

  it("wraps a rotated arrow in a group so shaft and head turn together", () => {
    const doc = emptyDoc();
    doc.shapes.push(shape({ kind: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, rot: 30 }));
    const svg = toSvg(doc);
    // One group carries both the opacity and the transform for shaft + head.
    expect(svg).toMatch(/<g opacity="1" transform="rotate\(30 50 0\)">[\s\S]*<line[\s\S]*<polygon[\s\S]*<\/g>/);
  });

  it("survives a round trip through validation", () => {
    const doc = validateDoc({ v: 1, shapes: [{ ...path("p", [0, 0, 1, 1]), rot: 123.4 }] }, CAPS);
    expect(doc?.shapes[0].rot).toBe(123.4);
  });

  it("defaults a missing or non-finite rotation to 0", () => {
    const bare = { ...path("p", [0, 0, 1, 1]) } as Record<string, unknown>;
    delete bare.rot;
    expect(validateShape(bare, CAPS)?.rot).toBe(0);
    expect(validateShape({ ...bare, rot: Number.NaN }, CAPS)?.rot).toBe(0);
    expect(validateShape({ ...bare, rot: Number.POSITIVE_INFINITY }, CAPS)?.rot).toBe(0);
    // Out-of-range angles are normalized rather than rejected.
    expect(validateShape({ ...bare, rot: -30 }, CAPS)?.rot).toBe(330);
  });
});

describe("rotation regressions", () => {
  // Each of these covers a defect found in review; they fail against the old code.

  it("keeps a rotated shape's anchor corner fixed on screen while scaling", () => {
    // scaleShape moves the bounds centre, which is the render pivot — so a naive
    // scale swings a rotated shape away from the corner the user is dragging.
    // useSketch.resizeSelected compensates; this asserts the maths it relies on.
    const before = shape({ kind: "rect", x: 0, y: 0, w: 100, h: 100, rot: 90 });
    const ox = 0;
    const oy = 0;
    const scaled = scaleShape(before, ox, oy, 2, 2);

    const p0 = shapePivot(before);
    const p1 = shapePivot(scaled);
    const a0 = rotatePoint(ox, oy, p0.cx, p0.cy, before.rot);
    const a1 = rotatePoint(ox, oy, p1.cx, p1.cy, before.rot);
    const fixed = translateShape(scaled, a0.x - a1.x, a0.y - a1.y);

    // The anchor renders in the same place before and after.
    const p2 = shapePivot(fixed);
    const a2 = rotatePoint(ox + (a0.x - a1.x), oy + (a0.y - a1.y), p2.cx, p2.cy, fixed.rot);
    expect(a2.x).toBeCloseTo(a0.x, 6);
    expect(a2.y).toBeCloseTo(a0.y, 6);
    // …and without the compensation it would NOT have been.
    expect(Math.hypot(a1.x - a0.x, a1.y - a0.y)).toBeGreaterThan(1);
  });

  it("inverting the render rotation is what makes a rotated handle grabbable", () => {
    // SketchCanvas maps the pointer with rotatePoint(-rot) before testing handles
    // and before differencing a resize drag. Pin the identity that relies on.
    const pivot = { cx: 200, cy: 200 };
    const rot = 90;
    // A handle drawn at unrotated (100,100) appears here once the group is rotated.
    const onScreen = rotatePoint(100, 100, pivot.cx, pivot.cy, rot);
    // Mapping the screen point back must recover the unrotated coordinates.
    const back = rotatePoint(onScreen.x, onScreen.y, pivot.cx, pivot.cy, -rot);
    expect(back.x).toBeCloseTo(100, 6);
    expect(back.y).toBeCloseTo(100, 6);
    // Using the raw screen point instead would be off by a lot — the old bug.
    expect(Math.hypot(onScreen.x - 100, onScreen.y - 100)).toBeGreaterThan(50);
  });

  it("composites a translucent arrow once, so shaft and head don't darken where they overlap", () => {
    const doc = emptyDoc();
    doc.shapes.push(shape({ kind: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, opacity: 0.5 }));
    const svg = toSvg(doc);
    // Opacity belongs on the wrapping group, exactly once.
    expect(svg).toContain('<g opacity="0.5"');
    expect(svg.match(/opacity="0\.5"/g)).toHaveLength(1);
    expect(svg).not.toMatch(/<line[^>]*opacity=/);
    expect(svg).not.toMatch(/<polygon[^>]*opacity=/);
  });

  it("leaves rect corners to the SVG default (miter), unlike freehand strokes", () => {
    const doc = emptyDoc();
    doc.shapes.push(shape({ kind: "rect", x: 0, y: 0, w: 10, h: 10 }));
    // The PNG rasterizer mirrors this by forcing lineJoin="miter" for rects.
    expect(toSvg(doc)).not.toMatch(/<rect[^>]*stroke-linejoin/);
  });
});

describe("transforms", () => {
  it("translate moves every kind and never mutates the input", () => {
    const p = path("p", [0, 0, 10, 10]);
    expect(translateShape(p, 5, -3).pts).toEqual([5, -3, 15, 7]);
    expect(p.pts).toEqual([0, 0, 10, 10]); // untouched

    expect(shapeBounds(translateShape(shape({ kind: "rect", x: 10, y: 10, w: 20, h: 30 }), 5, 5))).toMatchObject({
      x: 15,
      y: 15,
    });

    const a = translateShape(shape({ kind: "arrow", x1: 0, y1: 0, x2: 10, y2: 10 }), 2, 2) as Extract<
      Shape,
      { kind: "arrow" }
    >;
    expect([a.x1, a.y1, a.x2, a.y2]).toEqual([2, 2, 12, 12]);
  });

  it("preserves rotation through translate and scale", () => {
    const s = shape({ kind: "rect", x: 0, y: 0, w: 10, h: 10, rot: 42 });
    expect(translateShape(s, 5, 5).rot).toBe(42);
    expect(scaleShape(s, 0, 0, 2, 2).rot).toBe(42);
  });

  it("scale about an origin keeps that origin fixed", () => {
    expect(scaleShape(path("p", [0, 0, 10, 0]), 0, 0, 2, 2).pts).toEqual([0, 0, 20, 0]);
  });

  it("scaling text scales its font and measured box together", () => {
    const t = scaleShape(
      shape({ kind: "text", x: 0, y: 0, text: "hi", size: 20, tw: 40, th: 20 }),
      0,
      0,
      2,
      2,
    ) as Extract<Shape, { kind: "text" }>;
    expect(t.size).toBe(40);
    expect(t.tw).toBe(80);
    expect(t.th).toBe(40);
  });
});

describe("hitTest", () => {
  it("hits within sw/2 + radius and misses outside", () => {
    const s = path("s", [0, 0, 100, 0]); // sw 4 ⇒ tol 2 + radius
    expect(hitTest([s], 50, 3, 2)).toBe("s");
    expect(hitTest([s], 50, 20, 2)).toBeNull();
  });

  it("returns the topmost of two overlapping shapes (array order is paint order)", () => {
    const under = path("under", [0, 0, 100, 0]);
    const over = path("over", [0, 0, 100, 0]);
    expect(hitTest([under, over], 50, 0, 2)).toBe("over");
    expect(hitTest([over, under], 50, 0, 2)).toBe("under");
  });

  it("hits a rect outline but not its hollow interior", () => {
    const r = shape({ kind: "rect", x: 0, y: 0, w: 100, h: 100, sw: 2 });
    expect(hitTest([r], 0, 50, 2)).toBe("s");
    expect(hitTest([r], 50, 50, 2)).toBeNull();
  });

  it("hits inside a text box", () => {
    const t = shape({ kind: "text", x: 10, y: 100, text: "hi", size: 24, tw: 40, th: 24, sw: 2 });
    expect(hitTest([t], 20, 95, 0)).toBe("s");
    expect(hitTest([t], 300, 95, 0)).toBeNull();
  });

  it("returns null on an empty board", () => {
    expect(hitTest([], 0, 0, 10)).toBeNull();
  });

  it("measures an ellipse against its ring, not its interior", () => {
    const e = shape({ kind: "ellipse", cx: 100, cy: 100, rx: 50, ry: 50, sw: 2 });
    expect(distToShape(e, 150, 100)).toBeCloseTo(0, 5);
    expect(distToShape(e, 100, 100)).toBeGreaterThan(10);
  });
});

describe("triangle and arrow", () => {
  const tri = shape({ kind: "triangle", x: 0, y: 0, w: 100, h: 100, sw: 4 });

  it("inscribes a triangle in its box: apex top-centre, base at the bottom", () => {
    expect(trianglePoints(tri as Extract<Shape, { kind: "triangle" }>)).toEqual([
      [50, 0],
      [100, 100],
      [0, 100],
    ]);
  });

  it("hits a triangle's edge but not its hollow interior", () => {
    expect(hitTest([tri], 50, 100, 2)).toBe("s");
    expect(hitTest([tri], 50, 60, 2)).toBeNull();
  });

  it("hits anywhere inside once filled", () => {
    expect(hitTest([{ ...tri, fill: "#3b82f6" } as Shape], 50, 60, 2)).toBe("s");
  });

  it("puts the arrow head at the far end and hits along the shaft", () => {
    const a = shape({ kind: "arrow", x1: 0, y1: 0, x2: 100, y2: 0 });
    expect(arrowHead(a as Extract<Shape, { kind: "arrow" }>)[0]).toEqual([100, 0]);
    expect(hitTest([a], 50, 0, 2)).toBe("s");
    expect(hitTest([a], 50, 40, 2)).toBeNull();
  });

  it("keeps the arrow head inside a very short shaft", () => {
    const a = shape({ kind: "arrow", x1: 0, y1: 0, x2: 4, y2: 0 });
    for (const [hx] of arrowHead(a as Extract<Shape, { kind: "arrow" }>)) {
      expect(hx).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("fill and opacity", () => {
  it("an undefined fill reads as unfilled, not as a solid hit box", () => {
    const legacy = shape({ kind: "rect", x: 0, y: 0, w: 100, h: 100, sw: 2 });
    delete (legacy as unknown as Record<string, unknown>).fill;
    expect(hitTest([legacy], 50, 50, 2)).toBeNull();
  });

  it("round-trips fill and opacity through validation", () => {
    const v = validateShape(
      { ...path("r", []), kind: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#ff0000", opacity: 0.5 },
      CAPS,
    );
    expect(v?.fill).toBe("#ff0000");
    expect(v?.opacity).toBe(0.5);
  });

  it("defaults a missing or out-of-range opacity to fully opaque", () => {
    const base = { ...path("p", [0, 0, 1, 1]) } as Record<string, unknown>;
    delete base.opacity;
    expect(validateShape(base, CAPS)?.opacity).toBe(1);
    expect(validateShape({ ...base, opacity: 0 }, CAPS)?.opacity).toBe(1);
    expect(validateShape({ ...base, opacity: 5 }, CAPS)?.opacity).toBe(1);
  });

  it("rejects a malformed fill rather than trusting it into the SVG", () => {
    const v = validateShape(
      { ...path("r", []), kind: "rect", x: 0, y: 0, w: 10, h: 10, fill: 'red" onload="x' },
      CAPS,
    );
    expect(v?.fill).toBeNull();
  });
});

describe("validation", () => {
  const good = path("s", [0, 0, 10, 10]);

  it("accepts a well-formed shape", () => {
    expect(validateShape({ ...good }, CAPS)).not.toBeNull();
  });

  it("rejects non-finite and absurd coordinates", () => {
    expect(validateShape({ ...good, pts: [0, 0, Number.NaN, 1] }, CAPS)).toBeNull();
    expect(validateShape({ ...good, pts: [0, 0, Number.POSITIVE_INFINITY, 1] }, CAPS)).toBeNull();
    expect(validateShape({ ...good, pts: [0, 0, 1e300, 1] }, CAPS)).toBeNull();
  });

  it("rejects malformed point arrays", () => {
    expect(validateShape({ ...good, pts: [0, 0, 1] }, CAPS)).toBeNull();
    expect(validateShape({ ...good, pts: [] }, CAPS)).toBeNull();
  });

  it("rejects a bad colour, width, kind, or missing id", () => {
    expect(validateShape({ ...good, color: "red" }, CAPS)).toBeNull();
    expect(validateShape({ ...good, color: "#fff" }, CAPS)).toBeNull();
    expect(validateShape({ ...good, sw: 0 }, CAPS)).toBeNull();
    expect(validateShape({ ...good, sw: 500 }, CAPS)).toBeNull();
    expect(validateShape({ ...good, kind: "polygon" }, CAPS)).toBeNull();
    expect(validateShape({ ...good, id: "" }, CAPS)).toBeNull();
  });

  it("truncates over-long text rather than dropping the shape", () => {
    const v = validateShape(
      { ...path("t", []), kind: "text", x: 0, y: 0, text: "z".repeat(1000), size: 16, tw: 10, th: 10 },
      CAPS,
    );
    expect(v?.kind).toBe("text");
    expect((v as { text: string }).text).toHaveLength(CAPS.maxTextLen);
  });

  it("never returns the input object itself", () => {
    const evil = { ...good, extra: "ignored" };
    const v = validateShape(evil, CAPS);
    expect(v).not.toBe(evil);
    expect((v as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it("preserves paint order and drops malformed entries when loading a doc", () => {
    const doc = validateDoc(
      { v: 1, shapes: [path("a", [0, 0, 1, 1]), { junk: true }, path("b", [0, 0, 1, 1])] },
      CAPS,
    );
    expect(doc?.shapes.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("stops loading at the shape cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => path(`s${i}`, [0, 0, 1, 1]));
    const doc = validateDoc({ v: 1, shapes: many }, { maxShapes: 4, maxTextLen: 200 });
    expect(doc?.shapes).toHaveLength(4);
  });

  it("rejects a doc that isn't shaped like one", () => {
    expect(validateDoc(null, CAPS)).toBeNull();
    expect(validateDoc({ v: 1 }, CAPS)).toBeNull();
    expect(validateDoc("nope", CAPS)).toBeNull();
  });
});

describe("background", () => {
  it("defaults to transparent", () => {
    expect(emptyDoc().background).toBeNull();
  });

  it("omits the background rect entirely when transparent", () => {
    const svg = toSvg(emptyDoc());
    // Not a white rect, not an empty one — no rect at all, or the export would be
    // opaque and defeat the point.
    expect(svg).not.toContain("<rect");
  });

  it("paints a background rect covering the board when one is set", () => {
    const doc = emptyDoc();
    doc.background = "#111827";
    const svg = toSvg(doc);
    expect(svg).toContain('<rect width="1920" height="1080" fill="#111827"/>');
  });

  it("draws the background beneath the shapes", () => {
    const doc = emptyDoc();
    doc.background = "#ffffff";
    doc.shapes.push(path("p", [0, 0, 10, 10]));
    const svg = toSvg(doc);
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf("<path"));
  });

  it("lets an explicit option override the document, including forcing transparent", () => {
    const doc = emptyDoc();
    doc.background = "#ffffff";
    expect(toSvg(doc, { background: "#ef4444" })).toContain('fill="#ef4444"');
    expect(toSvg(doc, { background: null })).not.toContain("<rect");
  });

  it("round-trips a background through validation", () => {
    const doc = validateDoc({ v: 1, shapes: [], background: "#dbeafe" }, CAPS);
    expect(doc?.background).toBe("#dbeafe");
  });

  it("treats a missing or malformed background as transparent", () => {
    // A document saved before the field existed must not become opaque.
    expect(validateDoc({ v: 1, shapes: [] }, CAPS)?.background).toBeNull();
    expect(validateDoc({ v: 1, shapes: [], background: "white" }, CAPS)?.background).toBeNull();
    expect(validateDoc({ v: 1, shapes: [], background: 'x" onload="y' }, CAPS)?.background).toBeNull();
  });

  it("escapes the background colour it emits", () => {
    // Belt and braces: validation already rejects this, but toSvg must not trust it.
    const doc = emptyDoc();
    doc.background = '#fff" onload="alert(1)';
    expect(toSvg(doc)).not.toContain('onload="alert(1)"');
  });
});

describe("background image", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

  it("accepts the raster types the importer produces", () => {
    expect(validateBackgroundImage(PNG)).toBe(PNG);
    expect(validateBackgroundImage("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).not.toBeNull();
    expect(validateBackgroundImage("data:image/webp;base64,UklGRh4AAABXRUJQ")).not.toBeNull();
  });

  it("rejects anything that is not a base64 raster data URL", () => {
    // An SVG background would let arbitrary markup into the exported file, and a
    // remote URL would make an "offline" export silently phone home.
    expect(validateBackgroundImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(validateBackgroundImage("https://example.com/x.png")).toBeNull();
    expect(validateBackgroundImage("data:text/html;base64,PGh0bWw+")).toBeNull();
    expect(validateBackgroundImage('data:image/png;base64,AAA" onload="alert(1)')).toBeNull();
    expect(validateBackgroundImage("")).toBeNull();
    expect(validateBackgroundImage(null)).toBeNull();
    expect(validateBackgroundImage(undefined)).toBeNull();
    expect(validateBackgroundImage(42)).toBeNull();
  });

  it("rejects an oversized payload", () => {
    const huge = `data:image/png;base64,${"A".repeat(MAX_BG_IMAGE_CHARS)}`;
    expect(validateBackgroundImage(huge)).toBeNull();
  });

  it("embeds the image in the SVG so the export stays self-contained", () => {
    const svg = toSvg(emptyDoc(), { image: PNG });
    expect(svg).toContain(`<image href="${PNG}"`);
    expect(svg).toContain(`width="1920" height="1080"`);
  });

  it("omits the image element when there is none, and when it is invalid", () => {
    expect(toSvg(emptyDoc())).not.toContain("<image");
    expect(toSvg(emptyDoc(), { image: "https://example.com/x.png" })).not.toContain("<image");
  });

  it("layers colour, then image, then shapes", () => {
    const doc = emptyDoc();
    doc.background = "#ffffff";
    doc.shapes.push(path("p", [0, 0, 10, 10]));
    const svg = toSvg(doc, { image: PNG });
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf("<image"));
    expect(svg.indexOf("<image")).toBeLessThan(svg.indexOf("<path"));
  });
});

describe("load recovery invariants", () => {
  // useSketch.load() separates a storage read from a content parse and recovers the
  // two kv keys independently. These pin the model-side behaviour it depends on:
  // a bad document must be *reported* as unusable, never throw, so the caller can
  // tell "corrupt content" (safe to start fresh) from "unreadable storage" (must
  // not overwrite). A validator that threw would collapse that distinction.

  it("reports an unusable document by returning null rather than throwing", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { v: 1 }, { shapes: "no" }]) {
      expect(() => validateDoc(bad, CAPS)).not.toThrow();
      expect(validateDoc(bad, CAPS)).toBeNull();
    }
  });

  it("never throws on a hostile background image, however malformed", () => {
    for (const bad of [null, undefined, 0, {}, [], "data:image/png;base64, ", "\n\n"]) {
      expect(() => validateBackgroundImage(bad)).not.toThrow();
      expect(validateBackgroundImage(bad)).toBeNull();
    }
  });

  it("recovers a document whose shapes are partly corrupt instead of losing all of them", () => {
    const doc = validateDoc(
      { v: 1, shapes: [path("keep", [0, 0, 1, 1]), null, { kind: "nope" }, path("keep2", [0, 0, 1, 1])] },
      CAPS,
    );
    expect(doc?.shapes.map((s) => s.id)).toEqual(["keep", "keep2"]);
  });
});

describe("toSvg", () => {
  it("emits explicit width/height so it rasterizes in WebKit", () => {
    const svg = toSvg(emptyDoc());
    expect(svg).toContain('width="1920"');
    expect(svg).toContain('height="1080"');
    expect(svg).toContain('viewBox="0 0 1920 1080"');
  });

  it("escapes text — it lands in a file on this user's disk", () => {
    const doc = emptyDoc();
    doc.shapes.push(
      shape({ kind: "text", x: 0, y: 0, text: '</text><script>alert("x")</script>', size: 16, tw: 10, th: 10 }),
    );
    const svg = toSvg(doc);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;/text&gt;");
  });

  it("renders shapes in array order", () => {
    const doc = emptyDoc();
    doc.shapes.push(path("first", [0, 0, 10, 10]), shape({ kind: "rect", x: 0, y: 0, w: 5, h: 5 }));
    const svg = toSvg(doc);
    expect(svg.indexOf("<path")).toBeLessThan(svg.indexOf("<rect x="));
  });
});

// The colour row is seven assignable slots, so what a slot may hold and what a
// stored palette is coerced to are now load-bearing. `palette invariants` exists
// because DEFAULT_SLOT_COLORS and EXTRA_COLORS are concatenated into
// PICKER_COLORS: moving a colour between the two lists without deleting it from
// the other silently duplicates it in the picker.
describe("palette invariants", () => {
  it("has seven slots and ten extras", () => {
    expect(PALETTE_SLOTS).toBe(7);
    expect(DEFAULT_SLOT_COLORS).toHaveLength(7);
    expect(EXTRA_COLORS).toHaveLength(10);
    expect(PICKER_COLORS).toHaveLength(17);
  });

  it("never offers the same colour twice", () => {
    expect(new Set(PICKER_COLORS).size).toBe(PICKER_COLORS.length);
  });

  it("offers only colours validateShape would accept", () => {
    // Same shape as COLOR_RE, lowercase — a slot colour becomes shape.color, and a
    // value that failed validation would vanish on the next load.
    for (const c of PICKER_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("names every pickable colour", () => {
    // A missing entry renders `sketch.colorNames.undefined` as the aria-label.
    for (const c of PICKER_COLORS) expect(COLOR_NAME_KEYS[c]).toBeTruthy();
    expect(Object.keys(COLOR_NAME_KEYS)).toHaveLength(PICKER_COLORS.length);
  });

  it("names the board backgrounds too, which share the same label helper", () => {
    // The background row is white/black/transparent/image; the two COLOURS are
    // labelled through COLOR_NAME_KEYS, so adding one that is not a slot colour
    // would need an entry here as well.
    for (const c of BACKGROUND_COLORS) expect(COLOR_NAME_KEYS[c]).toBeTruthy();
  });
});

describe("normalizeSlots", () => {
  it("keeps the good entries and falls back only the bad one", () => {
    // The whole reason the function exists: a single corrupt entry must not cost
    // the user their other six.
    const out = normalizeSlots(["#ef4444", "#zzzzzz", "#3b82f6"]);
    expect(out[0]).toBe("#ef4444");
    expect(out[1]).toBe(DEFAULT_SLOT_COLORS[1]);
    expect(out[2]).toBe("#3b82f6");
    expect(out.slice(3)).toEqual([...DEFAULT_SLOT_COLORS].slice(3));
  });

  it("pads a short palette and truncates an over-long one", () => {
    expect(normalizeSlots(["#8b5cf6"])).toEqual(["#8b5cf6", ...[...DEFAULT_SLOT_COLORS].slice(1)]);
    expect(normalizeSlots(Array(20).fill("#06b6d4"))).toEqual(Array(7).fill("#06b6d4"));
  });

  it("preserves duplicates", () => {
    // A behavioural contract, not an accident: setSlot's follow rule is written
    // around two slots being allowed to hold the same colour.
    const dup = ["#ef4444", "#ef4444", ...[...DEFAULT_SLOT_COLORS].slice(2)];
    expect(normalizeSlots(dup)).toEqual(dup);
  });

  it("rejects anything that is not an array", () => {
    const def = [...DEFAULT_SLOT_COLORS];
    expect(normalizeSlots("#ef4444")).toEqual(def);
    expect(normalizeSlots(42)).toEqual(def);
    expect(normalizeSlots({})).toEqual(def);
    expect(normalizeSlots(null)).toEqual(def);
    expect(normalizeSlots(undefined)).toEqual(def);
    // Array-LIKE: would pass a typeof/length check, so pin that Array.isArray gates it.
    expect(normalizeSlots({ 0: "#ef4444", length: 7 })).toEqual(def);
  });

  it("rejects a colour that is not offered, including a differently-cased one", () => {
    expect(normalizeSlots(["#123456"])[0]).toBe(DEFAULT_SLOT_COLORS[0]);
    expect(normalizeSlots(["#EF4444"])[0]).toBe(DEFAULT_SLOT_COLORS[0]);
  });

  it("always returns exactly PALETTE_SLOTS offered colours", () => {
    for (const input of [null, [], ["#ef4444"], Array(20).fill("#06b6d4"), ["x", 1, {}, null]]) {
      const out = normalizeSlots(input);
      expect(out).toHaveLength(PALETTE_SLOTS);
      for (const c of out) expect(PICKER_COLORS).toContain(c);
    }
  });

  it("returns a fresh array, never the caller's", () => {
    // Guards a future "fast path: return x when already valid", which would hand
    // the caller a live reference to the parsed kv array.
    const input = [...DEFAULT_SLOT_COLORS];
    expect(normalizeSlots(input)).not.toBe(input);
    expect(normalizeSlots(null)).not.toBe(normalizeSlots(null));
  });

  it("does not pollute Object.prototype", () => {
    normalizeSlots(JSON.parse('{"__proto__":{"polluted":1}}'));
    normalizeSlots(["__proto__", "constructor"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
