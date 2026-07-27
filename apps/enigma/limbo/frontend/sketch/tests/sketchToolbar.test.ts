import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SketchToolbar from "../../src/components/sketch/SketchToolbar.vue";
import { getSketch, resetSketch } from "../../src/components/sketch/useSketch";
import { COLOR_NAME_KEYS, DEFAULT_SLOT_COLORS, PICKER_COLORS } from "../../src/components/sketch/sketchModel";
import { i18n } from "../../src/i18n";

// The colour row does two different things depending on a mode flag, and the whole
// design rests on the editing branch being a TOOL preference — never a document
// edit. These mount the real toolbar against the real sketch singleton to pin the
// wiring, because the two branches are one `if` apart in onSlotClick and a
// copy-paste of pickColor into the wrong branch would silently restyle shapes.

// Rows are scoped by their `title`, not by document order — the board-background
// row also renders colour chips, so an unscoped `[style*=background]` sweep picks
// those up too.

/** Swatch buttons in the colour row, in slot order. The pencil carries no
 *  background style, so this is exactly the seven slot chips. */
function slotButtons(w: ReturnType<typeof mountToolbar>) {
  return w.find("[title='Colour']").findAll("button[style*='background']");
}

/** Swatch buttons in the fill row. Excludes its "no fill" button, which is an icon. */
function fillButtons(w: ReturnType<typeof mountToolbar>) {
  return w.find("[title='Fill']").findAll("button[style*='background']");
}

function panel(w: ReturnType<typeof mountToolbar>) {
  return w.find("[role='dialog']");
}

function mountToolbar() {
  return mount(SketchToolbar, {
    props: { sketch: getSketch(), tool: "draw" as const, textSize: 24 },
    global: { plugins: [i18n] },
  });
}

beforeEach(() => {
  localStorage.clear();
  resetSketch();
  i18n.global.locale.value = "en";
});

describe("SketchToolbar palette slots", () => {
  it("picks a drawing colour when edit mode is off", async () => {
    const w = mountToolbar();
    await slotButtons(w)[1].trigger("click");

    expect(getSketch().currentColor.value).toBe(DEFAULT_SLOT_COLORS[1]);
    expect(panel(w).exists()).toBe(false);
  });

  it("opens the picker instead of drawing when edit mode is on", async () => {
    const w = mountToolbar();
    const before = getSketch().currentColor.value;

    await w.find("button[aria-pressed]").trigger("click");
    await slotButtons(w)[0].trigger("click");

    expect(panel(w).exists()).toBe(true);
    expect(panel(w).findAll("button")).toHaveLength(PICKER_COLORS.length);
    // The click that opened the picker must NOT also have set the drawing colour.
    expect(getSketch().currentColor.value).toBe(before);
  });

  it("assigns the picked colour to that slot and closes", async () => {
    const w = mountToolbar();
    await w.find("button[aria-pressed]").trigger("click");
    await slotButtons(w)[0].trigger("click");

    const target = PICKER_COLORS[PICKER_COLORS.length - 1]; // navy — not a default
    await panel(w).findAll("button")[PICKER_COLORS.length - 1].trigger("click");

    expect(getSketch().slots.value[0]).toBe(target);
    expect(getSketch().slots.value.slice(1)).toEqual([...DEFAULT_SLOT_COLORS].slice(1));
    expect(panel(w).exists()).toBe(false);
    // Edit mode stays on so several slots can be reassigned in one visit.
    expect(w.find("button[aria-pressed='true']").exists()).toBe(true);
  });

  it("never touches the drawing or the undo stack", async () => {
    // The single most important guard in the feature: a palette edit that pushed an
    // undo entry would make Ctrl-Z revert a preference instead of the last shape.
    const sketch = getSketch();
    sketch.addRect(0, 0, 10, 10);
    const shapesBefore = JSON.stringify(sketch.doc.value.shapes);
    const undoBefore = sketch.canUndo.value;

    const w = mountToolbar();
    await w.find("button[aria-pressed]").trigger("click");
    await slotButtons(w)[0].trigger("click");
    await panel(w).findAll("button")[PICKER_COLORS.length - 1].trigger("click");

    expect(JSON.stringify(sketch.doc.value.shapes)).toBe(shapesBefore);
    expect(sketch.canUndo.value).toBe(undoBefore);
  });

  it("leaving edit mode closes an open picker", async () => {
    const w = mountToolbar();
    const pencil = w.find("button[aria-pressed]");
    await pencil.trigger("click");
    await slotButtons(w)[2].trigger("click");
    expect(panel(w).exists()).toBe(true);

    await pencil.trigger("click");
    expect(panel(w).exists()).toBe(false);
  });

  it("mirrors the slots into the fill row", async () => {
    // Fill only renders for a fillable tool, hence the prop change.
    const w = mountToolbar();
    await w.setProps({ tool: "rect" });

    const fills = fillButtons(w);
    expect(fills).toHaveLength(DEFAULT_SLOT_COLORS.length);
    expect(fills.map((b) => b.attributes("style"))).toEqual(slotButtons(w).map((b) => b.attributes("style")));
  });
});

// setSlot is the only writer of the palette and the only caller of persistPalette,
// so its guards and its persistence live or die together. kvGet/kvPut fall through
// to localStorage under jsdom (isTauri() is false), so this needs no mocking.
describe("palette state and persistence", () => {
  it("rejects an out-of-range or non-integer slot index", async () => {
    const sketch = getSketch();
    await sketch.load();
    const before = [...sketch.slots.value];

    for (const i of [-1, 7, 99, 1.5, Number.NaN]) sketch.setSlot(i, "#1e40af");
    expect(sketch.slots.value).toEqual(before);
  });

  it("rejects a colour that is not offered", async () => {
    const sketch = getSketch();
    await sketch.load();
    sketch.setSlot(0, "#123456");
    expect(sketch.slots.value[0]).toBe(DEFAULT_SLOT_COLORS[0]);
  });

  it("round-trips the palette through storage", async () => {
    const sketch = getSketch();
    await sketch.load();
    sketch.setSlot(0, "#1e40af");
    await Promise.resolve();

    resetSketch();
    const fresh = getSketch();
    await fresh.load();
    expect(fresh.slots.value[0]).toBe("#1e40af");
  });

  it("resets to defaults on reload", async () => {
    const sketch = getSketch();
    await sketch.load();
    sketch.setSlot(0, "#1e40af");
    await sketch.reload();
    // reload() re-reads, so the persisted value comes back — the point is that the
    // ref was reset in between rather than carrying the old profile's palette.
    expect(sketch.slots.value).toHaveLength(DEFAULT_SLOT_COLORS.length);
  });

  describe("the active colour follows its slot", () => {
    it("moves when the old colour has left the row", async () => {
      const sketch = getSketch();
      await sketch.load();
      sketch.currentColor.value = DEFAULT_SLOT_COLORS[0];
      sketch.setSlot(0, "#1e40af");
      expect(sketch.currentColor.value).toBe("#1e40af");
    });

    it("stays put when another slot still holds it", async () => {
      const sketch = getSketch();
      await sketch.load();
      sketch.setSlot(1, DEFAULT_SLOT_COLORS[0]); // duplicate the colour into slot 1
      sketch.currentColor.value = DEFAULT_SLOT_COLORS[0];
      sketch.setSlot(0, "#1e40af");
      expect(sketch.currentColor.value).toBe(DEFAULT_SLOT_COLORS[0]);
    });

    it("does not yank an off-palette colour when an unrelated slot changes", async () => {
      // The case that rules out the "is currentColor still on the row?" shortcut.
      const sketch = getSketch();
      await sketch.load();
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
  const KEY = "enigma:db:sketch:default:palette";

  it("starts fresh and repairs the record on the next swap", async () => {
    localStorage.setItem(KEY, '["#ef4444","#10b98'); // truncated JSON

    const sketch = getSketch();
    await sketch.load();
    expect(sketch.slots.value).toEqual([...DEFAULT_SLOT_COLORS]);

    sketch.setSlot(0, "#1e40af");
    await Promise.resolve();
    expect(localStorage.getItem(KEY)).not.toBe('["#ef4444","#10b98');

    resetSketch();
    const fresh = getSketch();
    await fresh.load();
    expect(fresh.slots.value[0]).toBe("#1e40af");
  });

  it("still recovers when the record parses but is the wrong shape", async () => {
    localStorage.setItem(KEY, '{"nope":1}');
    const sketch = getSketch();
    await sketch.load();
    expect(sketch.slots.value).toEqual([...DEFAULT_SLOT_COLORS]);

    sketch.setSlot(0, "#1e40af");
    await Promise.resolve();
    expect(JSON.parse(localStorage.getItem(KEY) as string)[0]).toBe("#1e40af");
  });
});
