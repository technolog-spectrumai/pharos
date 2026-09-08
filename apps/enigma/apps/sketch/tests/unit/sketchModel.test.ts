import { describe, expect, it } from "vitest";
import {
  arrowHead,
  BACKGROUND_COLORS,
  BOARD_H,
  BOARD_W,
  boardWidth,
  boardWidthFor,
  distToShape,
  distToShapeRotated,
  emptyDoc,
  hitTest,
  MAX_BG_IMAGE_CHARS,
  MAX_BOARD_W,
  MIN_BOARD_W,
  normDeg,
  pathD,
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
  nearestSnap,
  snapPoints,
  snapPointsOf,
  DEFAULT_HEAD_WIDTH,
  DEFAULT_CAPS,
} from "wisteria/sketchModel";

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
    expect(svg).toMatch(/<g data-en-kind="arrow" opacity="1" transform="rotate\(30 50 0\)">[\s\S]*<line[\s\S]*<polygon[\s\S]*<\/g>/);
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
    expect(svg).toContain(`<g data-en-kind="arrow" opacity="0.5"`);
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
    expect(svg).toContain('<rect data-en-bg="1" width="1920" height="1080" fill="#111827"/>');
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
    expect(svg).toContain(`<image data-en-bgimg="1" href="${PNG}"`);
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


// The board is BOARD_H tall and elastic in width so it fills its container instead
// of letterboxing a fixed 16:9 sheet. These pin the two things that makes safe:
// the width matches the container's aspect exactly (no letterbox left to draw), and
// an already-saved drawing keeps validating whatever width it is opened at.
describe("elastic board width", () => {
  it("matches the container's aspect, so nothing is letterboxed", () => {
    // The reported bug: a 1280x602 widget letterboxed a 16:9 board to 1070 wide and
    // wasted 210px. The board must now be as wide as the container's aspect implies.
    expect(boardWidthFor(1280, 602)).toBe(Math.round((BOARD_H * 1280) / 602));
    // Aspect, not absolute size — a half-size window gets the same board.
    expect(boardWidthFor(640, 301)).toBe(boardWidthFor(1280, 602));
    // A 16:9 container still yields exactly the classic board.
    expect(boardWidthFor(1920, 1080)).toBe(BOARD_W);
    expect(boardWidthFor(800, 450)).toBe(BOARD_W);
  });

  it("keeps the aspect it promises, to within rounding", () => {
    for (const [w, h] of [
      [1280, 602],
      [1000, 1000],
      [2560, 900],
      [700, 1200],
    ]) {
      const bw = boardWidthFor(w, h);
      // Only meaningful when the clamp did not bite.
      if (bw > MIN_BOARD_W && bw < MAX_BOARD_W) {
        expect(Math.abs(bw / BOARD_H - w / h)).toBeLessThan(0.01);
      }
    }
  });

  it("clamps a degenerate or absurd container instead of producing a broken board", () => {
    expect(boardWidthFor(10_000, 10)).toBe(MAX_BOARD_W);
    expect(boardWidthFor(10, 10_000)).toBe(MIN_BOARD_W);
    // Unmeasured / zero-size element (the first frame) falls back to the default.
    for (const [w, h] of [
      [0, 0],
      [1280, 0],
      [Number.NaN, 100],
      [-5, 100],
    ]) {
      expect(boardWidthFor(w, h)).toBe(BOARD_W);
    }
  });

  it("coerces an untrusted width", () => {
    expect(boardWidth(undefined)).toBe(BOARD_W);
    expect(boardWidth(null)).toBe(BOARD_W);
    expect(boardWidth(Number.NaN)).toBe(BOARD_W);
    expect(boardWidth(Number.POSITIVE_INFINITY)).toBe(BOARD_W);
    expect(boardWidth(1e9)).toBe(MAX_BOARD_W);
    expect(boardWidth(1)).toBe(MIN_BOARD_W);
    expect(boardWidth(2296)).toBe(2296);
  });

  it("still accepts a shape drawn at the far edge of the widest board", () => {
    // Regression: COORD_MAX used to be 2*1920, so a shape drawn near the right edge
    // of a very wide window would be silently DELETED by validateDoc when the same
    // board was reopened on a narrower one.
    const far = { ...path("p", [MAX_BOARD_W - 1, 10, MAX_BOARD_W, 20]) };
    const doc = validateDoc({ v: 1, shapes: [far] }, CAPS);
    expect(doc?.shapes).toHaveLength(1);
    expect((doc?.shapes[0] as PathShape).pts).toEqual([MAX_BOARD_W - 1, 10, MAX_BOARD_W, 20]);
  });

  it("exports at the width it is given, and at the classic board when given none", () => {
    const doc = emptyDoc();
    doc.background = "#ffffff";
    doc.shapes.push(shape({ kind: "rect", x: 0, y: 0, w: 10, h: 10 }));

    const wide = toSvg(doc, { width: 2296 });
    expect(wide).toContain('viewBox="0 0 2296 1080"');
    expect(wide).toContain('width="2296" height="1080"');
    // The background must cover the WHOLE elastic board, not just the classic part.
    expect(wide).toContain('<rect data-en-bg="1" width="2296" height="1080" fill="#ffffff"/>');

    const bare = toSvg(doc);
    expect(bare).toContain('viewBox="0 0 1920 1080"');
  });

  it("covers rather than stretches a background image on a non-16:9 board", () => {
    // The stored image is cropped to the classic board, so on an elastic board its
    // aspect no longer matches; without `slice` it would visibly squash.
    const img = `data:image/png;base64,${"A".repeat(40)}=`;
    const svg = toSvg(emptyDoc(), { image: img, width: 2296 });
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).toContain('width="2296" height="1080"');
  });
});

describe("sticky snap points", () => {
  const base = { color: "#111111", sw: 2, opacity: 1, fill: null, rot: 0 };
  const near = (pts: [number, number][], x: number, y: number) =>
    pts.some(([px, py]) => Math.hypot(px - x, py - y) < 0.001);

  it("offers a rect its four corners and four edge centres", () => {
    const pts = snapPointsOf({ ...base, id: "r", kind: "rect", x: 0, y: 0, w: 100, h: 40 } as Shape);
    expect(pts).toHaveLength(8);
    for (const [x, y] of [[0, 0], [100, 0], [100, 40], [0, 40]]) {
      expect(near(pts, x, y)).toBe(true);          // corners
    }
    for (const [x, y] of [[50, 0], [100, 20], [50, 40], [0, 20]]) {
      expect(near(pts, x, y)).toBe(true);          // edge centres
    }
  });

  it("offers a triangle three vertices and three edge centres", () => {
    const pts = snapPointsOf({ ...base, id: "t", kind: "triangle", x: 0, y: 0, w: 100, h: 100 } as Shape);
    expect(pts).toHaveLength(6);
  });

  it("offers a line both ends and its middle", () => {
    const pts = snapPointsOf({
      ...base, id: "l", kind: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, head: false,
    } as Shape);
    expect(pts).toHaveLength(3);
    expect(near(pts, 50, 0)).toBe(true);
  });

  it("offers a circle its four quadrant points and no edge centres", () => {
    // A circle has no corners and no edges to halve.
    const pts = snapPointsOf({ ...base, id: "c", kind: "ellipse", cx: 50, cy: 50, rx: 10, ry: 10 } as Shape);
    expect(pts).toHaveLength(4);
    expect(near(pts, 40, 50)).toBe(true);
    expect(near(pts, 50, 60)).toBe(true);
  });

  it("offers a freehand path only its two ends", () => {
    // Every sample point would be hundreds of targets a millimetre apart.
    const pts = snapPointsOf({
      ...base, id: "p", kind: "path", pts: [0, 0, 5, 5, 10, 0, 20, 30],
    } as Shape);
    expect(pts).toEqual([[0, 0], [20, 30]]);
  });

  it("offers text nothing", () => {
    const pts = snapPointsOf({
      ...base, id: "x", kind: "text", x: 0, y: 0, text: "hi", size: 12, tw: 20, th: 14,
    } as Shape);
    expect(pts).toEqual([]);
  });

  it("follows a rotated shape", () => {
    // Snapping to where a shape ISN'T is worse than not snapping at all.
    const upright = snapPointsOf({ ...base, id: "r", kind: "rect", x: 0, y: 0, w: 100, h: 40 } as Shape);
    const turned = snapPointsOf({ ...base, id: "r", kind: "rect", x: 0, y: 0, w: 100, h: 40, rot: 90 } as Shape);
    expect(turned).toHaveLength(8);
    expect(turned).not.toEqual(upright);
    // A 90° turn about the centre (50,20) carries the top-left corner (0,0)
    // to (70,-30) — outside the upright box, which is the point.
    expect(near(turned, 70, -30)).toBe(true);
  });

  it("takes the nearest point inside the radius and nothing outside it", () => {
    const pts: [number, number][] = [[0, 0], [100, 0]];
    expect(nearestSnap(4, 3, pts, 12)).toEqual({ x: 0, y: 0 });
    expect(nearestSnap(96, 0, pts, 12)).toEqual({ x: 100, y: 0 });
    expect(nearestSnap(50, 0, pts, 12)).toBeNull();
  });

  it("is stable when two points coincide", () => {
    // Two shapes sharing a corner must not make the snap flicker between them.
    const pts: [number, number][] = [[10, 10], [10, 10]];
    expect(nearestSnap(11, 11, pts)).toEqual({ x: 10, y: 10 });
  });

  it("collects every shape's points for the board", () => {
    const shapes = [
      { ...base, id: "r", kind: "rect", x: 0, y: 0, w: 10, h: 10 },
      { ...base, id: "l", kind: "arrow", x1: 0, y1: 0, x2: 10, y2: 0 },
    ] as Shape[];
    expect(snapPoints(shapes)).toHaveLength(8 + 3);
  });
});

describe("arrow head width", () => {
  const arrow = (over: Record<string, unknown> = {}) => ({
    id: "a", kind: "arrow", x1: 0, y1: 0, x2: 100, y2: 0,
    color: "#111111", sw: 4, opacity: 1, fill: null, rot: 0, ...over,
  }) as Shape;

  const widthOf = (s: Shape) => {
    const [, b, c] = arrowHead(s as never);
    return Math.hypot(b[0] - c[0], b[1] - c[1]);
  };

  it("defaults to the head being 3.6x the line's thickness", () => {
    expect(widthOf(arrow())).toBeCloseTo(4 * DEFAULT_HEAD_WIDTH, 6);
  });

  it("is 50% wider than the head this replaced", () => {
    // The old geometry was half-width = size * 0.4 with size = sw * 3, so a
    // full width of 2.4 * sw. This is that, one half again.
    expect(DEFAULT_HEAD_WIDTH).toBeCloseTo(2.4 * 1.5, 6);
  });

  it("follows the setting", () => {
    expect(widthOf(arrow({ headWidth: 2.4 }))).toBeCloseTo(4 * 2.4, 6);
    expect(widthOf(arrow({ headWidth: 5.4 }))).toBeCloseTo(4 * 5.4, 6);
  });

  it("scales with the line's thickness, not with its length", () => {
    // Tying the width to the head's LENGTH would make it grow sideways
    // whenever the head was clamped short on a stubby arrow.
    expect(widthOf(arrow({ sw: 8 }))).toBeCloseTo(2 * widthOf(arrow({ sw: 4 })), 6);
    expect(widthOf(arrow({ x2: 12 }))).toBeCloseTo(widthOf(arrow()), 6);
  });

  it("keeps a non-default width across a save and reopen", () => {
    // The head polygon is regenerated from the shaft on open, so without the
    // hint every arrow would be re-cut to the CURRENT setting.
    const wide = validateShape({ ...(arrow({ headWidth: 5.4 }) as object) }, DEFAULT_CAPS);
    expect((wide as { headWidth?: number }).headWidth).toBe(5.4);
  });

  it("refuses a nonsense width rather than drawing a spike", () => {
    for (const bad of [0, -3, 99, Number.NaN]) {
      const out = validateShape({ ...(arrow({ headWidth: bad }) as object) }, DEFAULT_CAPS);
      expect((out as { headWidth?: number }).headWidth).toBeUndefined();
    }
  });
});
