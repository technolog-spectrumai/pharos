import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SketchEditor from "../../src/editors/SketchEditor.vue";
import { i18n } from "../../src/i18n";

// The drawing editor under this app's contract. Ported from enigma's
// svgEditor.test.ts, which covers the same engine behind a vault; what
// changes is the save path (the host's) and the export (the app menu's).
//
// jsdom has no canvas, so the PNG rasteriser is mocked. The SVG codec, the
// model and the toolbar are real.
const exportPngMock = vi.fn(async () => true);
vi.mock("wisteria/sketchExport", () => ({
  exportPng: (...a: unknown[]) => exportPngMock(...(a as [])),
  backgroundImageFromFile: vi.fn(async () => "data:image/png;base64,AAA"),
}));

const OK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<rect x="1" y="2" width="10" height="10" fill="none" stroke="#123456" stroke-width="2" opacity="1"/>` +
  `</svg>`;

type Vm = {
  getContent(): string; markSaved(): void; isDirty(): boolean;
  exports: Array<{ labelKey: string; icon: string; run(): Promise<void> }>;
};

function mountEditor(content: string, over: Record<string, unknown> = {}) {
  return mount(SketchEditor, {
    props: { path: "/tmp/a.svg", name: "a.svg", content, ...over },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

/** The live drawing session — how a test makes an edit the way a tool would. */
function sketchOf(w: ReturnType<typeof mountEditor>) {
  return (w.vm as unknown as { $: { setupState: { sketch: {
    addText(x: number, y: number, text: string, size: number, tw: number, th: number): void;
  } } } }).$.setupState.sketch;
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  exportPngMock.mockClear();
  exportPngMock.mockResolvedValue(true);
});

describe("the drawing editor", () => {
  it("implements the contract the host holds it by", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    const vm = w.vm as unknown as Vm;
    expect(typeof vm.getContent).toBe("function");
    expect(typeof vm.markSaved).toBe("function");
    expect(vm.isDirty()).toBe(false);
  });

  it("hands back plain SVG — the file format is SVG, nothing wrapped around it", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    const out = (w.vm as unknown as Vm).getContent();
    expect(out.startsWith("<?xml")).toBe(true);
    expect(out).toContain("<svg");
    expect(out).toContain('viewBox="0 0 100 100"');
    const doc = new DOMParser().parseFromString(out, "image/svg+xml");
    expect(doc.documentElement.nodeName).toBe("svg");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  });

  it("opens untouched as clean, and an edit as dirty until saved", async () => {
    const w = mountEditor(OK_SVG);
    await flushPromises();
    const vm = w.vm as unknown as Vm;
    expect(w.emitted("update:dirty")).toBeUndefined();

    sketchOf(w).addText(10, 10, "hello", 24, 50, 29);
    await flushPromises();
    expect(vm.isDirty()).toBe(true);
    expect(w.emitted("update:dirty")?.at(-1)).toEqual([true]);
    expect(vm.getContent()).toContain("hello");

    vm.markSaved();
    expect(vm.isDirty()).toBe(false);
  });

  it("starts a new drawing from an empty buffer rather than refusing it", async () => {
    const w = mountEditor("", { path: null, name: "untitled.svg" });
    await flushPromises();
    expect(w.find('[data-testid="svg-refusal"]').exists()).toBe(false);
    expect((w.vm as unknown as Vm).getContent()).toContain("<svg");
  });

  it("shows the host's save error through the error prop", async () => {
    const w = mountEditor(OK_SVG, { error: "disk full" });
    await flushPromises();
    expect(w.text()).toContain("disk full");
  });
});

describe("a file it cannot open", () => {
  it("refuses active content, says what it found, and offers plain text", async () => {
    const w = mountEditor(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
    await flushPromises();
    expect(w.get('[data-testid="svg-refusal"]').text()).toContain("script");
    expect(w.html()).not.toContain("alert(1)");
    await w.get('[data-testid="svg-open-text"]').trigger("click");
    expect(w.emitted("open-as-text")).toBeTruthy();
  });

  it("refuses a remote reference — an offline app must not fetch", async () => {
    const w = mountEditor(
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>`,
    );
    await flushPromises();
    expect(w.get('[data-testid="svg-refusal"]').text()).toContain("outside the file");
  });
});

describe("parts it cannot edit", () => {
  it("announces them, and keeps them in what it writes", async () => {
    const w = mountEditor(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<g><circle cx="1" cy="1" r="1"/></g><path d="M0 0 A 5 5 0 0 1 9 9"/></svg>`,
    );
    await flushPromises();
    expect(w.get('[data-testid="svg-opaque-notice"]').text()).toContain("2");
    const out = (w.vm as unknown as Vm).getContent();
    expect(out).toContain("<circle");
    expect(out).toContain("A 5 5 0 0 1 9 9");
  });
});

describe("PNG export", () => {
  it("is offered to the app menu, and names the PNG after the drawing", async () => {
    const w = mountEditor(OK_SVG, { name: "floorplan.svg" });
    await flushPromises();
    const [png] = (w.vm as unknown as Vm).exports;
    expect(png.labelKey).toBe("sketch.exportPng");
    await png.run();
    await flushPromises();
    expect(exportPngMock).toHaveBeenCalledTimes(1);
    const args = exportPngMock.mock.calls[0] as unknown[];
    expect(args[1]).toBe("floorplan.png");
    expect(args[3]).toBe(100); // the document's own width, not a fixed board
    // Exporting is not editing.
    expect((w.vm as unknown as Vm).isDirty()).toBe(false);
    expect(w.emitted("save")).toBeUndefined();
  });
});
