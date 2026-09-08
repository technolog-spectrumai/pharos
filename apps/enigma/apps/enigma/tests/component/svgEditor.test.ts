import { describe, expect, it, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
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
// The engine moved to packages/wisteria; this editor is enigma's wrapper
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
