import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SketchToolbar from "../../src/sketch/SketchToolbar.vue";
import { createSketch, type Sketch } from "../../src/sketch/useSketch";
import {
  COLOR_NAME_KEYS, DEFAULT_SLOT_COLORS, OTHER_COLORS, PICKER_COLORS, ZOOM_STEPS,
} from "../../src/sketch/sketchModel";
import { DEFAULT_PALETTE } from "../../src/systemColors";
import { i18n } from "../../src/i18n";

// The toolbar's settings live behind five titled pickers. The whole design rests
// on the palette-editing branch being a TOOL preference — never a document edit —
// so these mount the real toolbar against a real sketch to pin the wiring: the two
// branches are one `if` apart in onSlotClick, and a copy-paste of pickColor into
// the wrong one would silently restyle shapes.
//
// Everything is addressed by data-testid. Never by role: there are five dialogs
// now, and a first-match `[role='dialog']` probe would silently retarget.

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
const slotChip = (w: W, i: number) => w.find(`[data-testid="slot-${i}"]`);
/** A catalogue chip in the pen picker, addressed by colour rather than position. */
const swatch = (w: W, group: string, hex: string) =>
  w.find(`[data-testid="swatch-${group}-${hex.slice(1)}"]`);
const swatches = (w: W) => w.findAll('[data-testid^="swatch-"]');

const openPen = async (w: W) => {
  await trigger(w, "pen").trigger("click");
};

beforeEach(() => {
  localStorage.clear();
  sketch = createSketch();
  i18n.global.locale.value = "en";
});

describe("SketchToolbar palette slots", () => {
  it("picks a drawing colour when edit mode is off", async () => {
    const w = mountToolbar();
    await openPen(w);
    await slotChip(w, 1).trigger("click");

    expect(sketch.currentColor.value).toBe(DEFAULT_SLOT_COLORS[1]);
    // Picking is done, so the picker closes — the new equivalent of the old
    // "no dialog opened" assertion.
    expect(modal(w, "pen").exists()).toBe(false);
  });

  it("arms the slot instead of drawing when edit mode is on", async () => {
    const w = mountToolbar();
    const before = sketch.currentColor.value;

    await openPen(w);
    await w.find('[data-testid="palette-edit"]').trigger("click");
    await slotChip(w, 0).trigger("click");

    expect(modal(w, "pen").exists()).toBe(true);
    expect(slotChip(w, 0).attributes("aria-expanded")).toBe("true");
    // The click that armed the slot must NOT also have set the drawing colour.
    expect(sketch.currentColor.value).toBe(before);
  });

  it("offers BOTH shade sets, from the configured system palette", async () => {
    // The feature's core guarantee: a drawing stores a concrete hex, so the
    // shade that reads on the OTHER board has to be reachable, not inferred
    // from whichever theme happens to be on.
    const w = mountToolbar();
    await openPen(w);

    expect(swatch(w, "light", DEFAULT_PALETTE.accent.light).exists()).toBe(true);
    expect(swatch(w, "dark", DEFAULT_PALETTE.accent.dark).exists()).toBe(true);
    expect(swatch(w, "light", DEFAULT_PALETTE.warning.light).exists()).toBe(true);
    expect(swatch(w, "dark", DEFAULT_PALETTE.warning.dark).exists()).toBe(true);

    // Five roles + plain ink, per set, plus the plain colours.
    const expected = 2 * (Object.keys(DEFAULT_PALETTE).length + 1) + OTHER_COLORS.length;
    expect(swatches(w)).toHaveLength(expected);
  });

  it("assigns the picked colour to that slot and stays in edit mode", async () => {
    const w = mountToolbar();
    await openPen(w);
    await w.find('[data-testid="palette-edit"]').trigger("click");
    await slotChip(w, 0).trigger("click");

    const target = OTHER_COLORS[OTHER_COLORS.length - 1];
    await swatch(w, "other", target).trigger("click");

    expect(sketch.slots.value[0]).toBe(target);
    expect(sketch.slots.value.slice(1)).toEqual([...DEFAULT_SLOT_COLORS].slice(1));
    expect(slotChip(w, 0).attributes("aria-expanded")).toBe("false");
    // Edit mode stays on so several slots can be reassigned in one visit.
    expect(modal(w, "pen").exists()).toBe(true);
    expect(w.find('[data-testid="palette-edit"][aria-pressed="true"]').exists()).toBe(true);
  });

  it("never touches the drawing or the undo stack", async () => {
    // The single most important guard in the feature: a palette edit that pushed an
    // undo entry would make Ctrl-Z revert a preference instead of the last shape.
    sketch.addRect(0, 0, 10, 10);
    const shapesBefore = JSON.stringify(sketch.doc.value.shapes);
    const undoBefore = sketch.canUndo.value;

    const w = mountToolbar();
    await openPen(w);
    await w.find('[data-testid="palette-edit"]').trigger("click");
    await slotChip(w, 0).trigger("click");
    await swatch(w, "other", OTHER_COLORS[OTHER_COLORS.length - 1]).trigger("click");

    expect(JSON.stringify(sketch.doc.value.shapes)).toBe(shapesBefore);
    expect(sketch.canUndo.value).toBe(undoBefore);
  });

  it("leaving edit mode disarms the armed slot", async () => {
    const w = mountToolbar();
    await openPen(w);
    const pencil = w.find('[data-testid="palette-edit"]');
    await pencil.trigger("click");
    await slotChip(w, 2).trigger("click");
    expect(slotChip(w, 2).attributes("aria-expanded")).toBe("true");

    await pencil.trigger("click");
    expect(slotChip(w, 2).attributes("aria-expanded")).toBeUndefined();
    expect(modal(w, "pen").exists()).toBe(true);
  });

  it("closing the picker also leaves edit mode", async () => {
    // The invariant that replaced "openSlot implies paletteEditing": a pencil
    // left pressed behind a closed picker is invisible state, and the next
    // colour click would reassign a slot instead of picking a colour.
    const w = mountToolbar();
    await openPen(w);
    await w.find('[data-testid="palette-edit"]').trigger("click");
    await slotChip(w, 2).trigger("click");

    await w.find('[data-testid="picker-close"]').trigger("click");
    expect(modal(w, "pen").exists()).toBe(false);

    await openPen(w);
    expect(w.find('[data-testid="palette-edit"][aria-pressed="true"]').exists()).toBe(false);
    expect(slotChip(w, 2).attributes("aria-expanded")).toBeUndefined();
  });

  it("mirrors the slots into the fill picker", async () => {
    // One palette behind both, shown one picker at a time.
    const w = mountToolbar();
    await openPen(w);
    const penStyles = [...Array(DEFAULT_SLOT_COLORS.length)].map((_, i) =>
      slotChip(w, i).attributes("style"),
    );
    await w.find('[data-testid="picker-close"]').trigger("click");

    await w.setProps({ tool: "rect" });
    await trigger(w, "fill").trigger("click");
    const fills = w.findAll('[data-testid^="fill-slot-"]');

    expect(fills).toHaveLength(DEFAULT_SLOT_COLORS.length);
    expect(fills.map((b) => b.attributes("style"))).toEqual(penStyles);
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
describe("palette state and persistence", () => {
  it("rejects an out-of-range or non-integer slot index", async () => {
    await sketch.loadPalette();
    const before = [...sketch.slots.value];

    for (const i of [-1, 7, 99, 1.5, Number.NaN]) sketch.setSlot(i, "#1e40af");
    expect(sketch.slots.value).toEqual(before);
  });

  it("rejects anything that is not a colour", async () => {
    // This guard used to be a whitelist of the built-in catalogue. It stopped
    // being right when Settings made the system roles user-defined: a whitelist
    // would silently refuse the very colours the picker had just offered, and a
    // slot would appear to accept a click and not change. What still has to be
    // guarded is junk reaching a persisted palette, which is a shape check.
    await sketch.loadPalette();
    for (const junk of ["red", "#12", "#1234567", "rgb(0,0,0)", "", "javascript:alert(1)"]) {
      sketch.setSlot(0, junk);
      expect(sketch.slots.value[0], junk).toBe(DEFAULT_SLOT_COLORS[0]);
    }
  });

  it("accepts a colour the user configured in Settings", async () => {
    // The other half of the change above: a system shade is not in the built-in
    // catalogue once the user edits it, and it must still be assignable.
    await sketch.loadPalette();
    sketch.setSlot(0, "#123456");
    expect(sketch.slots.value[0]).toBe("#123456");
  });

  it("round-trips the palette through storage", async () => {
    await sketch.loadPalette();
    sketch.setSlot(0, "#1e40af");
    await Promise.resolve();
    const fresh = createSketch();
    await fresh.loadPalette();
    expect(fresh.slots.value[0]).toBe("#1e40af");
  });

  it("a second editor starts from the defaults until it reads the palette", async () => {
    await sketch.loadPalette();
    sketch.setSlot(0, "#1e40af");

    // Opening another drawing builds a new instance. It must not inherit the
    // first one's refs — it starts at the defaults and only the stored palette
    // (read explicitly) brings the user's choice back.
    const second = createSketch();
    expect(second.slots.value).toEqual([...DEFAULT_SLOT_COLORS]);
    await second.loadPalette();
    expect(second.slots.value[0]).toBe("#1e40af");
    expect(second.slots.value).toHaveLength(DEFAULT_SLOT_COLORS.length);
  });

  describe("the active colour follows its slot", () => {
    it("moves when the old colour has left the row", async () => {
      await sketch.loadPalette();
      sketch.currentColor.value = DEFAULT_SLOT_COLORS[0];
      sketch.setSlot(0, "#1e40af");
      expect(sketch.currentColor.value).toBe("#1e40af");
    });

    it("stays put when another slot still holds it", async () => {
      await sketch.loadPalette();
      sketch.setSlot(1, DEFAULT_SLOT_COLORS[0]); // duplicate the colour into slot 1
      sketch.currentColor.value = DEFAULT_SLOT_COLORS[0];
      sketch.setSlot(0, "#1e40af");
      expect(sketch.currentColor.value).toBe(DEFAULT_SLOT_COLORS[0]);
    });

    it("does not yank an off-palette colour when an unrelated slot changes", async () => {
      // The case that rules out the "is currentColor still on the row?" shortcut.
      await sketch.loadPalette();
      sketch.currentColor.value = "#abcdef"; // never on the row
      sketch.setSlot(3, "#1e40af");
      expect(sketch.currentColor.value).toBe("#abcdef");
    });
  });
});

describe("colour name strings", () => {
  // tests/unit/i18n.test.ts checks en and pl against EACH OTHER. It cannot catch a
  // colour name that COLOR_NAME_KEYS references but neither locale defines — that
  // renders the raw key path ("sketch.colorNames.navy") as the swatch's aria-label
  // in both languages, equally and silently.
  it("resolves every name COLOR_NAME_KEYS points at, in both locales", () => {
    for (const locale of ["en", "pl"] as const) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, never>;
      const names = (messages.sketch as Record<string, unknown>).colorNames as Record<string, string>;
      for (const c of PICKER_COLORS) {
        const key = COLOR_NAME_KEYS[c];
        expect(names[key], `${locale} is missing sketch.colorNames.${key} (for ${c})`).toBeTruthy();
      }
    }
  });
});

describe("a corrupt stored palette", () => {
  // Regression: JSON.parse used to sit inside the same try as the kvGet, so a
  // readable-but-corrupt record was misread as a STORAGE failure. paletteReady then
  // stayed false forever, every later swap was silently dropped, and because load()
  // is one-shot and nothing else writes this key, the bad record outlived every
  // restart. Storage failure and content corruption need opposite responses.
  const KEY = "zinnia:sketch:palette"; // paletteStore.ts, zinnia's own key

  it("starts fresh and repairs the record on the next swap", async () => {
    localStorage.setItem(KEY, '["#ef4444","#10b98'); // truncated JSON
    await sketch.loadPalette();
    expect(sketch.slots.value).toEqual([...DEFAULT_SLOT_COLORS]);

    sketch.setSlot(0, "#1e40af");
    await Promise.resolve();
    expect(localStorage.getItem(KEY)).not.toBe('["#ef4444","#10b98');
    const fresh = createSketch();
    await fresh.loadPalette();
    expect(fresh.slots.value[0]).toBe("#1e40af");
  });

  it("still recovers when the record parses but is the wrong shape", async () => {
    localStorage.setItem(KEY, '{"nope":1}');
    await sketch.loadPalette();
    expect(sketch.slots.value).toEqual([...DEFAULT_SLOT_COLORS]);

    sketch.setSlot(0, "#1e40af");
    await Promise.resolve();
    expect(JSON.parse(localStorage.getItem(KEY) as string)[0]).toBe("#1e40af");
  });
});
