import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SketchToolbar from "../../src/sketch/SketchToolbar.vue";
import { createSketch, type Sketch } from "../../src/sketch/useSketch";
import { ZOOM_STEPS } from "../../src/sketch/sketchModel";
import { COLOR_ROLES, NEUTRALS, offeredColors } from "../../src/sketch/sketchPalette";
import { DEFAULT_PALETTE } from "../../src/systemColors";
import { i18n } from "../../src/i18n";

// The toolbar's settings live behind titled pickers, and its colours are
// exactly what Settings holds plus black and white — no assignable slots, no
// per-theme variants. Everything is addressed by data-testid, never by role:
// there are several dialogs and a first-match `[role='dialog']` probe would
// silently retarget.

let sketch: Sketch;

function mountToolbar() {
  return mount(SketchToolbar, {
    props: { sketch, tool: "draw" as const, textSize: 24, zoom: 1 },
    // The pickers teleport; without the stub their bodies render outside the
    // wrapper and every find() below returns nothing.
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

type W = ReturnType<typeof mountToolbar>;
const trigger = (w: W, id: string) => w.find(`[data-testid="trigger-${id}"]`);
const modal = (w: W, id: string) => w.find(`[data-testid="modal-${id}"]`);
const swatch = (w: W, role: string) => w.find(`[data-testid="swatch-${role}"]`);
const swatches = (w: W) => w.findAll('[data-testid^="swatch-"]');

const openPen = async (w: W) => {
  await trigger(w, "pen").trigger("click");
};

beforeEach(() => {
  localStorage.clear();
  sketch = createSketch();
  i18n.global.locale.value = "en";
});

describe("SketchToolbar colours", () => {
  it("offers exactly the system palette plus black and white", async () => {
    // The whole simplification: no catalogue of its own, no light/dark twins.
    const w = mountToolbar();
    await openPen(w);

    expect(swatches(w)).toHaveLength(COLOR_ROLES.length);
    for (const role of COLOR_ROLES) {
      expect(swatch(w, role).exists(), role).toBe(true);
    }
  });

  it("draws with the exact colour Settings holds, unconverted", async () => {
    // A drawing stores the literal hex, so anything that adjusted it here would
    // make the saved file disagree with the palette it came from.
    const w = mountToolbar();
    await openPen(w);
    await swatch(w, "accent").trigger("click");

    expect(sketch.currentColor.value).toBe(DEFAULT_PALETTE.accent);
    expect(modal(w, "pen").exists()).toBe(false); // picking is done
  });

  it("offers plain black and white as fixed neutrals", async () => {
    const w = mountToolbar();
    await openPen(w);
    await swatch(w, "white").trigger("click");
    expect(sketch.currentColor.value).toBe(NEUTRALS.white);
  });

  it("starts on plain black rather than a theme-dependent ink", async () => {
    // Not black-on-light/white-on-dark: the pen's colour is written into the
    // file, so it cannot mean something different depending on the theme.
    expect(sketch.currentColor.value).toBe(NEUTRALS.black);
  });

  it("has no assignable slots left", async () => {
    // Free choice moved to Settings; a slot row would be a second, competing
    // place to define colours.
    const w = mountToolbar();
    await openPen(w);
    expect(w.find('[data-testid="palette-edit"]').exists()).toBe(false);
    expect(w.find('[data-testid="slot-0"]').exists()).toBe(false);
  });

  it("fills the fill picker from the same palette", async () => {
    const w = mountToolbar();
    await w.setProps({ tool: "rect" });
    await trigger(w, "fill").trigger("click");
    const fills = w.findAll('[data-testid^="fill-swatch-"]');
    expect(fills).toHaveLength(COLOR_ROLES.length);
  });

  it("never touches the drawing or the undo stack when picking", async () => {
    // Picking a colour restyles a selection deliberately, but with nothing
    // selected it must not become a document edit.
    sketch.addRect(0, 0, 10, 10);
    sketch.clearSelection();
    const shapesBefore = JSON.stringify(sketch.doc.value.shapes);
    const undoBefore = sketch.canUndo.value;

    const w = mountToolbar();
    await openPen(w);
    await swatch(w, "warning").trigger("click");

    expect(JSON.stringify(sketch.doc.value.shapes)).toBe(shapesBefore);
    expect(sketch.canUndo.value).toBe(undoBefore);
  });
});

describe("SketchToolbar pickers", () => {
  it("shows the current zoom and emits the chosen step", async () => {
    const w = mountToolbar();
    expect(trigger(w, "zoom").text()).toContain("100%");

    await trigger(w, "zoom").trigger("click");
    await w.find('[data-testid="zoom-2"]').trigger("click");

    expect(w.emitted("update:zoom")).toEqual([[2]]);
    expect(modal(w, "zoom").exists()).toBe(false);

    await w.setProps({ zoom: 2 });
    expect(trigger(w, "zoom").text()).toContain("200%");
  });

  it("keeps the brush picker open across all three settings", async () => {
    // Three settings, one visit — closing after each would make setting up a
    // brush three round trips.
    const w = mountToolbar();
    await trigger(w, "brush").trigger("click");

    await w.find('[data-testid="width-8"]').trigger("click");
    expect(sketch.currentWidth.value).toBe(8);
    expect(modal(w, "brush").exists()).toBe(true);

    await w.find('[data-testid="opacity-0.5"]').trigger("click");
    expect(sketch.currentOpacity.value).toBe(0.5);
    expect(modal(w, "brush").exists()).toBe(true);

    await w.find('[data-testid="textsize-36"]').trigger("click");
    expect(w.emitted("update:textSize")).toEqual([[36]]);
    expect(modal(w, "brush").exists()).toBe(true);
  });

  it("offers every zoom step", async () => {
    const w = mountToolbar();
    await trigger(w, "zoom").trigger("click");
    for (const step of ZOOM_STEPS) {
      expect(w.find(`[data-testid="zoom-${step}"]`).exists(), `${step}`).toBe(true);
    }
  });

  it("sets and clears the board background", async () => {
    const w = mountToolbar();
    await trigger(w, "board").trigger("click");
    await w.find('[data-testid="board-ffffff"]').trigger("click");
    expect(sketch.doc.value.background).toBe("#ffffff");
    expect(modal(w, "board").exists()).toBe(false);

    await trigger(w, "board").trigger("click");
    await w.find('[data-testid="board-none"]').trigger("click");
    expect(sketch.doc.value.background).toBe(null);
  });

  it("tells the editor when a picker is up, so shortcuts can be held", async () => {
    // A modal's buttons are not INPUT/TEXTAREA, so the editor's window-level
    // guard does not cover them: without this signal, Delete inside a picker
    // would delete a shape.
    const w = mountToolbar();
    await trigger(w, "brush").trigger("click");
    expect(w.emitted("picker-open")?.at(-1)).toEqual([true]);

    await w.find('[data-testid="picker-close"]').trigger("click");
    expect(w.emitted("picker-open")?.at(-1)).toEqual([false]);
  });

  it("closes the fill picker when fill stops applying", async () => {
    const w = mountToolbar();
    await w.setProps({ tool: "rect" });
    await trigger(w, "fill").trigger("click");
    expect(modal(w, "fill").exists()).toBe(true);

    // The trigger disappears with the tool change; the picker must not outlive it.
    await w.setProps({ tool: "draw" });
    expect(modal(w, "fill").exists()).toBe(false);
  });

  it("only ever shows one picker at a time", async () => {
    const w = mountToolbar();
    await trigger(w, "brush").trigger("click");
    await trigger(w, "pen").trigger("click");
    expect(modal(w, "brush").exists()).toBe(false);
    expect(modal(w, "pen").exists()).toBe(true);
  });
});

// setSlot is the only writer of the palette and the only caller of persistPalette,
// so its guards and its persistence live or die together. kvGet/kvPut fall through
// to localStorage under jsdom (isTauri() is false), so this needs no mocking.
