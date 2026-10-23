import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import SketchCanvas from "wisteria/SketchCanvas.vue";
import SketchToolbar from "wisteria/SketchToolbar.vue";
import { backgroundImageFromFile } from "wisteria/sketchExport";
import type { Sketch } from "wisteria/useSketch";
import { SVG_FONT_STACK } from "wisteria/sketchModel";
import SvgEditor from "../../src/components/local/SvgEditor.vue";
import { i18n } from "../../src/i18n";

// The editor's user-facing contract, as distinct from the parser's (see
// tests/unit/svgDocument.test.ts). Three things matter here:
//
//   * it clones NoteEditor's interface, because LocalPanel's save path is shared
//     verbatim — a drifting `getContent`/`markSaved`/`isDirty` would break saving
//     with no type error, since the parent holds the ref loosely;
//   * a file it cannot open says WHY and offers the editor that can;
//   * parts it cannot edit are announced rather than left looking broken.

const invokeMock = vi.fn(async () => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [])) }));
const exportPngMock = vi.fn(async () => true);
// The engine is wisteria (Rutile); this editor is enigma's wrapper
// around it, and the export is still mocked because jsdom has no canvas.
vi.mock("wisteria/sketchExport", () => ({
  exportPng: (...a: unknown[]) => exportPngMock(...(a as [])),
  backgroundImageFromFile: vi.fn(async () => "data:image/png;base64,AAA"),
}));

(i18n.global.locale as unknown as { value: string }).value = "en";

const OK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<rect x="1" y="2" width="10" height="10" fill="none" stroke="#123456" stroke-width="2" opacity="1"/>` +
  `</svg>`;

function mountEditor(content: string, over: Record<string, unknown> = {}) {
  return mount(SvgEditor, {
    props: { path: "/tmp/a.svg", name: "a.svg", content, locked: false, ...over },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

beforeEach(() => {
  localStorage.clear();
  exportPngMock.mockClear();
  exportPngMock.mockResolvedValue(true);
});

describe("the NoteEditor interface, cloned", () => {
  it("exposes getContent / markSaved / isDirty", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    const vm = w.vm as unknown as {
      getContent: () => string;
      markSaved: () => void;
      isDirty: () => boolean;
    };
    expect(typeof vm.getContent).toBe("function");
    expect(typeof vm.markSaved).toBe("function");
    expect(typeof vm.isDirty).toBe("function");
    expect(vm.isDirty()).toBe(false);
  });

  it("getContent returns SVG text — which is why the sealed write needs no Rust change", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    const out = (w.vm as unknown as { getContent: () => string }).getContent();
    expect(out.startsWith("<?xml")).toBe(true);
    expect(out).toContain("<svg");
    expect(out).toContain('viewBox="0 0 100 100"');
  });

  it("a freshly opened, untouched file is not dirty", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    expect(w.emitted("update:dirty")).toBeUndefined();
  });

  it("saving emits the serialized document", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    await w.find('[data-testid="svg-save"]').trigger("click");
    const ev = w.emitted("save");
    expect(ev).toBeTruthy();
    expect(String(ev![0][0])).toContain("<svg");
  });

  it("a brand-new drawing starts from a blank document, not a parse error", async () => {
    const w = mountEditor("", { path: null, name: "untitled.svg" });
    await flushPromises();
    expect(w.find('[data-testid="svg-refusal"]').exists()).toBe(false);
    expect(w.find('[data-testid="svg-save"]').exists()).toBe(true);
  });
});

describe("a file it cannot open", () => {
  it("refuses active content and says what it found", async () => {
    const w = mountEditor(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
    await flushPromises();
    const msg = w.find('[data-testid="svg-refusal"]');
    expect(msg.exists()).toBe(true);
    expect(msg.text()).toContain("script");
    // Nothing to save: the document was never built.
    expect(w.find('[data-testid="svg-save"]').exists()).toBe(false);
  });

  it("offers the XML editor rather than dead-ending", async () => {
    const w = mountEditor(`<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>`);
    await flushPromises();
    await w.find('[data-testid="svg-open-xml"]').trigger("click");
    expect(w.emitted("open-as-xml")).toBeTruthy();
  });

  it("refuses a remote reference — an offline app must not fetch", async () => {
    const w = mountEditor(
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>`,
    );
    await flushPromises();
    expect(w.find('[data-testid="svg-refusal"]').text()).toContain("outside the file");
  });

  it("never renders the refused markup", async () => {
    const w = mountEditor(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>`,
    );
    await flushPromises();
    expect(w.html()).not.toContain("alert(1)");
    expect(w.html()).not.toContain("<script");
  });
});

describe("parts it cannot edit", () => {
  it("announces them instead of leaving them looking broken", async () => {
    const w = mountEditor(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<g><circle cx="1" cy="1" r="1"/></g><path d="M0 0 A 5 5 0 0 1 9 9"/></svg>`,
    );
    await flushPromises();
    const notice = w.find('[data-testid="svg-opaque-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain("2");
  });

  it("says nothing when the whole file is editable", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    expect(w.find('[data-testid="svg-opaque-notice"]').exists()).toBe(false);
  });
});

describe("PNG export", () => {
  it("rasterizes at the DOCUMENT's dimensions, not a fixed board", async () => {
    const w = mountEditor(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect x="1" y="1" width="2" height="2"/></svg>`,
    );
    await flushPromises();
    await w.find('[data-testid="svg-export-png"]').trigger("click");
    await flushPromises();

    expect(exportPngMock).toHaveBeenCalledTimes(1);
    const args = exportPngMock.mock.calls[0] as unknown[];
    expect(args[3]).toBe(640); // width
    expect(args[4]).toBe(480); // height
  });

  it("names the PNG after the drawing, not 'untitled'", async () => {
    const w = mountEditor(OK_SVG, { name: "floorplan.svg" });
    await flushPromises();
    await w.find('[data-testid="svg-export-png"]').trigger("click");
    await flushPromises();
    expect((exportPngMock.mock.calls[0] as unknown[])[1]).toBe("floorplan.png");
  });

  it("exporting never touches the drawing or marks it unsaved", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    await w.find('[data-testid="svg-export-png"]').trigger("click");
    await flushPromises();
    expect((w.vm as unknown as { isDirty: () => boolean }).isDirty()).toBe(false);
    expect(w.emitted("save")).toBeUndefined();
  });

  it("surfaces an export failure instead of silently doing nothing", async () => {
    exportPngMock.mockRejectedValueOnce(new Error("disk full"));
    const w = mountEditor(OK_SVG);
    await flushPromises();
    await w.find('[data-testid="svg-export-png"]').trigger("click");
    await flushPromises();
    expect(w.text()).toContain("disk full");
  });

  it("has no export button on a file it refused to open", async () => {
    const w = mountEditor(`<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>`);
    await flushPromises();
    expect(w.find('[data-testid="svg-export-png"]').exists()).toBe(false);
  });
});

// ── the editor around the canvas ────────────────────────────────────────────
// What follows drives the editor the way its children do: the canvas asks for
// text, the toolbar asks for an image or a clear, the window delivers
// shortcuts. The document is read back through getContent(), i.e. through
// exactly what a save would write.

type Exposed = { getContent: () => string; markSaved: () => void; isDirty: () => boolean };
const content = (w: VueWrapper) => (w.vm as unknown as Exposed).getContent();
/** The editor's live sketch, as it hands it to the canvas. */
const sketchOf = (w: VueWrapper) => w.findComponent(SketchCanvas).props("sketch") as Sketch;

function press(key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}, target?: EventTarget) {
  const ev = new KeyboardEvent("keydown", {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    bubbles: true,
    cancelable: true,
  });
  (target ?? window).dispatchEvent(ev);
  return ev;
}

/** Place text through the canvas → modal round trip, as the text tool does. */
async function addText(w: VueWrapper, words: string) {
  w.findComponent(SketchCanvas).vm.$emit("requestText", 30, 40);
  await flushPromises();
  await w.find("input[placeholder='Type something…']").setValue(words);
  // The prompt's own Save — the header has a Save button too.
  await textPrompt(w).findAll("button").find((b) => b.text() === "Save")!.trigger("click");
  await flushPromises();
}
/** The open text prompt (the toolbar has modals of its own). */
const textPrompt = (w: VueWrapper) =>
  w.findAllComponents({ name: "OyaModal" }).find((m) => m.find("input[placeholder='Type something…']").exists())!;

describe("around the canvas", () => {
  // jsdom has no 2D context; the editor measures text with one and estimates
  // without. Every test below starts from "no context" (which also keeps jsdom's
  // not-implemented warning out of the log); the metrics test supplies one.
  let getContext: MockInstance;
  beforeEach(() => {
    getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => {
    getContext.mockRestore();
  });

  describe("the header", () => {
    it("offers Encrypt on a plain drawing, and nothing of the sort on a sealed one", async () => {
      const plain = mountEditor(OK_SVG);
      await flushPromises();
      expect(plain.text()).toContain("Plain text");
      await plain.find("button[aria-label='Encrypt…']").trigger("click");
      expect(plain.emitted("encrypt")).toEqual([[]]);

      const sealed = mountEditor(OK_SVG, { locked: true });
      await flushPromises();
      expect(sealed.text()).toContain("Encrypted on disk");
      expect(sealed.find("button[aria-label='Encrypt…']").exists()).toBe(false);
    });

    it("Back is the parent's decision", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      await w.find("button[aria-label='Back']").trigger("click");
      expect(w.emitted("back")).toEqual([[]]);
    });

    it("greys Save out until something changes — except on a drawing with nowhere to go yet", async () => {
      const existing = mountEditor(OK_SVG);
      await flushPromises();
      expect(existing.find('[data-testid="svg-save"]').classes()).toContain("pointer-events-none");

      const fresh = mountEditor("", { path: null, name: "untitled.svg" });
      await flushPromises();
      expect(fresh.find('[data-testid="svg-save"]').classes()).not.toContain("pointer-events-none");
    });

    it("will not save while a write is in flight, by button or by shortcut", async () => {
      const w = mountEditor(OK_SVG, { busy: true });
      await flushPromises();
      await w.find('[data-testid="svg-save"]').trigger("click");
      press("s", { ctrl: true });
      expect(w.emitted("save")).toBeUndefined();
    });

    it("shows the parent's save error", async () => {
      const w = mountEditor(OK_SVG, { error: "wrong passphrase" });
      await flushPromises();
      expect(w.find("p.text-warn-dark").text()).toBe("wrong passphrase");
    });
  });

  describe("more files it cannot open", () => {
    it("refuses a DOCTYPE outright — entity expansion is a parser-level bomb", async () => {
      const w = mountEditor(`<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"/>`);
      await flushPromises();
      expect(w.find('[data-testid="svg-refusal"]').text()).toBe(
        "It declares XML entities, which this editor will not expand.",
      );
    });

    it("refuses text that is not SVG at all", async () => {
      const w = mountEditor("just some notes, saved as .svg by mistake");
      await flushPromises();
      expect(w.find('[data-testid="svg-refusal"]').text()).toBe("It isn't a readable SVG file.");
      expect(w.find("button[aria-label='Encrypt…']").exists()).toBe(false);
    });
  });

  describe("editing marks the drawing unsaved", () => {
    it("an edit is dirty, markSaved re-baselines, and a further edit is dirty again", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      await addText(w, "first");
      expect(w.emitted("update:dirty")).toEqual([[true]]);
      expect(w.find("[title='Unsaved changes']").exists()).toBe(true);

      (w.vm as unknown as Exposed).markSaved();
      await flushPromises();
      expect(w.emitted("update:dirty")).toEqual([[true], [false]]);
      expect(w.find('[data-testid="svg-save"]').classes()).toContain("pointer-events-none");

      await addText(w, "second");
      expect(w.emitted("update:dirty")).toEqual([[true], [false], [true]]);
    });

    it("Clear board from the toolbar empties the document", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      expect(content(w)).toContain("<rect");
      w.findComponent(SketchToolbar).vm.$emit("clear");
      await flushPromises();
      expect(content(w)).not.toContain("<rect");
      expect((w.vm as unknown as Exposed).isDirty()).toBe(true);
    });
  });

  describe("the text tool", () => {
    it("asks for the words where the canvas was clicked, and places them", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      await addText(w, "  Hello  ");
      expect(content(w)).toContain(">Hello</text>");
      expect(w.find("input[placeholder='Type something…']").exists()).toBe(false);
    });

    it("boxes the words with real font metrics, so the far end of a word is still clickable", async () => {
      const ctx = { font: "", measureText: vi.fn((t: string) => ({ width: t.length * 20 })) };
      getContext.mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
      const w = mountEditor(OK_SVG);
      await flushPromises();
      await addText(w, "Hello");
      expect(ctx.measureText).toHaveBeenCalledWith("Hello");
      // Measured in the stack the exported SVG renders with, at the tool's size.
      expect(ctx.font).toBe(`24px ${SVG_FONT_STACK}`);
      // 5 × 20 = 100 units wide from x = 30: the estimate (5 × 24 × 0.6 = 72)
      // would end at 102 and miss a click at 125.
      const s = sketchOf(w);
      expect(s.selectAt(125, 35, 0)).not.toBeNull();
      expect(s.selected.value?.kind).toBe("text");
    });

    it("blank words add nothing and keep the prompt up", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const before = content(w);
      await addText(w, "   ");
      expect(content(w)).toBe(before);
      expect(w.find("input[placeholder='Type something…']").exists()).toBe(true);
    });

    it("Enter places the text; Cancel drops the request", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      w.findComponent(SketchCanvas).vm.$emit("requestText", 5, 5);
      await flushPromises();
      const field = w.find("input[placeholder='Type something…']");
      await field.setValue("typed");
      await field.trigger("keyup", { key: "Enter" });
      expect(content(w)).toContain(">typed</text>");

      w.findComponent(SketchCanvas).vm.$emit("requestText", 5, 5);
      await flushPromises();
      await textPrompt(w).findAll("button").find((b) => b.text() === "Cancel")!.trigger("click");
      expect(w.find("input[placeholder='Type something…']").exists()).toBe(false);
    });
  });

  describe("keyboard shortcuts", () => {
    it("Ctrl+S and Cmd+S save the serialized document, and keep the browser's own Save away", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const ctrl = press("s", { ctrl: true });
      press("S", { meta: true });
      expect(ctrl.defaultPrevented).toBe(true);
      expect(w.emitted("save")).toHaveLength(2);
      expect(String(w.emitted("save")![1][0])).toContain("<rect");
    });

    it("undo and redo walk the history: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      await addText(w, "note");
      expect(content(w)).toContain(">note</text>");

      press("z", { ctrl: true });
      expect(content(w)).not.toContain(">note</text>");
      press("z", { ctrl: true, shift: true });
      expect(content(w)).toContain(">note</text>");
      press("z", { meta: true });
      press("y", { ctrl: true });
      expect(content(w)).toContain(">note</text>");
    });

    it("Delete and Backspace remove the selected shape; Escape only lets go of it", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const s = sketchOf(w);

      // An unfilled rect is hit on its outline; its left edge is at x = 1.
      s.selectAt(1, 7, 2);
      expect(s.selected.value).not.toBeNull();
      press("Escape");
      expect(s.selected.value).toBeNull();
      expect(content(w)).toContain("<rect");

      // Nothing selected: Delete is a no-op, not "delete everything".
      press("Delete");
      expect(content(w)).toContain("<rect");

      s.selectAt(1, 7, 2);
      const del = press("Backspace");
      expect(del.defaultPrevented).toBe(true);
      expect(content(w)).not.toContain("<rect");
    });

    it("leaves keys alone while the user is typing in a field", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const s = sketchOf(w);
      s.selectAt(1, 7, 2);
      const field = document.createElement("input");
      document.body.appendChild(field);
      try {
        press("Backspace", {}, field);
        press("s", { ctrl: true }, field);
      } finally {
        field.remove();
      }
      expect(content(w)).toContain("<rect");
      expect(w.emitted("save")).toBeUndefined();
    });

    it("holds shortcuts while a colour picker is open, so Delete edits the picker, not the drawing", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const s = sketchOf(w);
      s.selectAt(1, 7, 2);
      w.findComponent(SketchToolbar).vm.$emit("picker-open", true);
      await flushPromises();
      press("Delete");
      expect(content(w)).toContain("<rect");

      w.findComponent(SketchToolbar).vm.$emit("picker-open", false);
      await flushPromises();
      press("Delete");
      expect(content(w)).not.toContain("<rect");
    });

    it("holds shortcuts while the text prompt is up", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      w.findComponent(SketchCanvas).vm.$emit("requestText", 5, 5);
      await flushPromises();
      press("s", { ctrl: true });
      expect(w.emitted("save")).toBeUndefined();
    });

    it("stops listening once the editor is gone", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      w.unmount();
      press("s", { ctrl: true });
      expect(w.emitted("save")).toBeUndefined();
    });
  });

  describe("background image", () => {
    const imageMock = vi.mocked(backgroundImageFromFile);

    async function pick(w: VueWrapper, files: File[]) {
      const input = w.find("input[type='file']");
      Object.defineProperty(input.element, "files", { value: files, configurable: true });
      await input.trigger("change");
      await flushPromises();
    }

    beforeEach(() => {
      imageMock.mockReset();
      imageMock.mockResolvedValue("data:image/png;base64,AAA");
    });

    it("the toolbar's request opens the hidden file picker", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const input = w.find("input[type='file']");
      expect(input.attributes("accept")).toBe("image/*");
      const click = vi.spyOn(input.element as HTMLInputElement, "click").mockImplementation(() => {});
      w.findComponent(SketchToolbar).vm.$emit("choose-image");
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("a picked image becomes the board's background and is saved with the drawing", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const file = new File(["png"], "photo.png", { type: "image/png" });
      await pick(w, [file]);

      expect(imageMock).toHaveBeenCalledWith(file);
      expect(content(w)).toContain('href="data:image/png;base64,AAA"');
      expect((w.vm as unknown as Exposed).isDirty()).toBe(true);
    });

    it("an empty pick changes nothing", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      await pick(w, []);
      expect(imageMock).not.toHaveBeenCalled();
    });

    it("explains a file it cannot use instead of swallowing it", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const file = new File(["?"], "x.bin");

      imageMock.mockRejectedValueOnce(new Error("not-an-image"));
      await pick(w, [file]);
      expect(w.text()).toContain("That file is not an image we can read.");

      imageMock.mockRejectedValueOnce(new Error("unreadable"));
      await pick(w, [file]);
      expect(w.text()).toContain("That file could not be read.");

      imageMock.mockRejectedValueOnce(new Error("something else"));
      await pick(w, [file]);
      expect(w.text()).toContain("That image could not be used.");
      expect(content(w)).not.toContain("<image");
    });
  });

  describe("PNG export, finishing", () => {
    it("says Saved. only when a file was actually written", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      exportPngMock.mockResolvedValueOnce(false); // the user cancelled the dialog
      await w.find('[data-testid="svg-export-png"]').trigger("click");
      await flushPromises();
      expect(w.text()).not.toContain("Saved.");

      await w.find('[data-testid="svg-export-png"]').trigger("click");
      await flushPromises();
      expect(w.text()).toContain("Saved.");
    });

    it("names the PNG 'drawing' when the file name is only an extension", async () => {
      const w = mountEditor(OK_SVG, { name: ".SVG" });
      await flushPromises();
      await w.find('[data-testid="svg-export-png"]').trigger("click");
      await flushPromises();
      expect((exportPngMock.mock.calls[0] as unknown[])[1]).toBe("drawing.png");
    });

    it("ignores a second press while an export is still running", async () => {
      let finish!: (ok: boolean) => void;
      exportPngMock.mockImplementationOnce(() => new Promise<boolean>((res) => (finish = res)));
      const w = mountEditor(OK_SVG);
      await flushPromises();
      await w.find('[data-testid="svg-export-png"]').trigger("click");
      expect(w.find('[data-testid="svg-export-png"]').attributes("disabled")).toBeDefined();
      await w.find('[data-testid="svg-export-png"]').trigger("click");
      expect(exportPngMock).toHaveBeenCalledTimes(1);
      finish(true);
      await flushPromises();
      expect(w.find('[data-testid="svg-export-png"]').attributes("disabled")).toBeUndefined();
    });
  });

  describe("the toolbar's settings", () => {
    it("hands the chosen tool and zoom to the canvas, and zoom never reaches the file", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      const before = content(w);
      const toolbar = w.findComponent(SketchToolbar);
      toolbar.vm.$emit("update:tool", "rect");
      toolbar.vm.$emit("update:zoom", 2);
      await flushPromises();

      expect(w.findComponent(SketchCanvas).props()).toMatchObject({ tool: "rect", zoom: 2 });
      expect(toolbar.props()).toMatchObject({ tool: "rect", zoom: 2 });
      // Display only: nothing to save, nothing to discard.
      expect(content(w)).toBe(before);
      expect(w.emitted("update:dirty")).toBeUndefined();
    });

    it("new text is set at the size the toolbar chose", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      w.findComponent(SketchToolbar).vm.$emit("update:textSize", 40);
      await flushPromises();
      await addText(w, "big");
      expect(content(w)).toMatch(/<text [^>]*font-size="40"[^>]*>big<\/text>/);
    });

    it("clicking outside the text prompt drops it", async () => {
      const w = mountEditor(OK_SVG);
      await flushPromises();
      w.findComponent(SketchCanvas).vm.$emit("requestText", 5, 5);
      await flushPromises();
      await textPrompt(w).find("[data-testid='oya-modal-overlay']").trigger("click");
      expect(w.find("input[placeholder='Type something…']").exists()).toBe(false);
      expect(content(w)).not.toContain("<text");
    });
  });
});
