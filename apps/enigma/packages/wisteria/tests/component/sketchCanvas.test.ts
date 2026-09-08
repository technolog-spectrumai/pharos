import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SketchCanvas from "../../src/components/SketchCanvas.vue";
import { createSketch, type Sketch } from "../../src/useSketch";
import { i18n } from "../i18n";

let sketch: Sketch;

function mountCanvas(zoom = 1) {
  return mount(SketchCanvas, {
    props: { sketch, tool: "draw" as const, zoom },
    global: { plugins: [i18n] },
  });
}

beforeEach(() => {
  localStorage.clear();
  sketch = createSketch();
});

describe("SketchCanvas zoom", () => {
  it("scales the element, not the viewBox", async () => {
    // The viewBox is the one thing toBoard() and the template agree on. A
    // zoom that changed it would make that agreement hand-maintained, and
    // hit-testing would drift from paint the first time they disagreed.
    const w = mountCanvas(2);
    const svg = w.get("svg");
    expect(svg.attributes("style")).toContain("width: 200%");
    expect(svg.attributes("style")).toContain("height: 200%");
    // NB `viewBox`, not `viewbox`: SVG attribute names are case-sensitive and
    // the lowercase spelling silently reads back undefined, which would make
    // the comparison below pass without comparing anything.
    expect(svg.attributes("viewBox")).toBe("0 0 1920 1080");

    await w.setProps({ zoom: 1 });
    expect(w.get("svg").attributes("style")).toContain("width: 100%");
  });

  it("keeps the same viewBox at every zoom", async () => {
    const w = mountCanvas(1);
    const before = w.get("svg").attributes("viewBox");
    expect(before).toBeTruthy(); // else the comparison below is vacuous
    await w.setProps({ zoom: 4 });
    expect(w.get("svg").attributes("viewBox")).toBe(before);
  });

  it("is not a document change", async () => {
    // The guarantee the whole design rests on: zoom is display state. If it
    // reached the model it would mark the file dirty, land in the undo stack
    // and change what a saved .svg contains.
    sketch.addRect(10, 10, 40, 40);
    const before = sketch.toText();
    const undoBefore = sketch.canUndo.value;

    const w = mountCanvas(1);
    await w.setProps({ zoom: 3 });

    expect(sketch.toText()).toBe(before);
    expect(sketch.canUndo.value).toBe(undoBefore);
  });

  it("defaults to 1 when no zoom is given", () => {
    const w = mount(SketchCanvas, {
      props: { sketch, tool: "draw" as const },
      global: { plugins: [i18n] },
    });
    expect(w.get("svg").attributes("style")).toContain("width: 100%");
  });
});
