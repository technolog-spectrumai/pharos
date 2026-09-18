import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";
import { dumps as dumpDeck, newPresentation } from "../../src/formats/presentation";

// The file lifecycle end to end at the host: open → edit → Save writes the
// same path → reopen shows what was written → Save As moves it. The disk is a
// map behind mocked fs/dialog plugins; the editor is the real ACE.
const disk = new Map<string, string>();
const writeTextFile = vi.fn(async (path: string, text: string) => { disk.set(path, text); });
const readTextFile = vi.fn(async (path: string) => {
  if (!disk.has(path)) throw new Error(`no such file: ${path}`);
  return disk.get(path)!;
});
const openDialog = vi.fn();
const saveDialog = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...a: [string, string]) => writeTextFile(...a),
  readTextFile: (...a: [string]) => readTextFile(...a),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
  save: (...a: unknown[]) => saveDialog(...a),
}));

type HostVm = {
  newFile(kind: string): Promise<void>;
  openFile(): Promise<void>;
  openLocal(name: string, path: string, text: string): void;
  saveFile(): Promise<void>;
  saveAs(): Promise<boolean>;
  name: string; dirty: boolean; canSave: boolean;
};

function mountHost() {
  return mount(EditorHost, {
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

async function aceOf(w: ReturnType<typeof mountHost>) {
  const ace = (await import("../../src/editors/aceSetup")).default;
  return ace.edit(w.get('[data-testid="ace-host"]').element as HTMLElement);
}

beforeEach(() => {
  disk.clear();
  for (const fn of [writeTextFile, readTextFile, openDialog, saveDialog]) fn.mockClear();
  openDialog.mockReset();
  saveDialog.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the file lifecycle", () => {
  it("edits a Markdown note, saves it in place, and reopens what was written", async () => {
    disk.set("/notes/idea.md", "# Idea");
    openDialog.mockResolvedValue("/notes/idea.md");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;

    await vm.openFile();
    await flushPromises();
    // The dialog offered every kind at once — the file decides the editor.
    const filters = openDialog.mock.calls[0][0].filters as Array<{ extensions: string[] }>;
    expect(filters[0].extensions).toEqual(expect.arrayContaining(["md", "markdown", "pxml", "xml", "txt"]));
    expect(vm.name).toBe("idea.md");
    expect(w.find('[data-testid="language-select"]').exists()).toBe(false);

    const editor = await aceOf(w);
    editor.session.insert({ row: 0, column: 6 }, "\n\nMore.");
    await flushPromises();
    expect(vm.dirty).toBe(true);
    expect(vm.canSave).toBe(true);

    await vm.saveFile();
    await flushPromises();
    expect(writeTextFile).toHaveBeenCalledWith("/notes/idea.md", "# Idea\n\nMore.");
    expect(saveDialog).not.toHaveBeenCalled(); // it had a path: no Save As
    expect(vm.dirty).toBe(false);
    expect(vm.canSave).toBe(false);

    // Reopen: a fresh editor, fed from disk.
    await vm.openFile();
    await flushPromises();
    expect((await aceOf(w)).getValue()).toBe("# Idea\n\nMore.");
    expect(vm.dirty).toBe(false);
  });

  it("saves a panel-opened file back to its own path", async () => {
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    vm.openLocal("todo.txt", "/w/todo.txt", "a");
    await flushPromises();
    (await aceOf(w)).session.insert({ row: 0, column: 1 }, "b");
    await flushPromises();
    await vm.saveFile();
    expect(writeTextFile).toHaveBeenCalledWith("/w/todo.txt", "ab");
    expect(saveDialog).not.toHaveBeenCalled();
  });

  it("asks where a new file goes, offering its own kind first, and keeps the new name", async () => {
    saveDialog.mockResolvedValue("/notes/fresh.md");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    await vm.newFile("markdown");
    await flushPromises();
    (await aceOf(w)).session.insert({ row: 0, column: 0 }, "# Fresh");
    await flushPromises();

    await vm.saveFile(); // never written, so Save is Save As
    await flushPromises();
    const opts = saveDialog.mock.calls[0][0] as { defaultPath: string; filters: Array<{ extensions: string[] }> };
    expect(opts.defaultPath).toMatch(/\.md$/);
    expect(opts.filters[0].extensions).toEqual(["md", "markdown"]);
    expect(writeTextFile).toHaveBeenCalledWith("/notes/fresh.md", "# Fresh");
    expect(vm.name).toBe("fresh.md");
    expect(vm.dirty).toBe(false);
  });

  it("Save As writes a copy under the new name and leaves the original untouched", async () => {
    disk.set("/w/a.md", "one");
    saveDialog.mockResolvedValue("/w/b.md");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    vm.openLocal("a.md", "/w/a.md", "one");
    await flushPromises();
    (await aceOf(w)).session.insert({ row: 0, column: 3 }, " two");
    await flushPromises();

    expect(await vm.saveAs()).toBe(true);
    expect(disk.get("/w/b.md")).toBe("one two");
    expect(disk.get("/w/a.md")).toBe("one");
    expect(vm.name).toBe("b.md");
    // Subsequent saves go to the new path.
    (await aceOf(w)).session.insert({ row: 0, column: 7 }, " three");
    await flushPromises();
    await vm.saveFile();
    expect(disk.get("/w/b.md")).toBe("one two three");
  });

  it("switching file types through Open swaps the editor", async () => {
    disk.set("/w/talk.pxml", dumpDeck(newPresentation("Talk")));
    disk.set("/w/n.md", "# n");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;

    openDialog.mockResolvedValueOnce("/w/talk.pxml");
    await vm.openFile();
    await flushPromises();
    expect(w.findComponent({ name: "PresentationEditor" }).exists()).toBe(true);

    openDialog.mockResolvedValueOnce("/w/n.md");
    await vm.openFile();
    await flushPromises();
    expect(w.findComponent({ name: "PresentationEditor" }).exists()).toBe(false);
    expect(w.findComponent({ name: "TextEditor" }).exists()).toBe(true);
    expect(vm.name).toBe("n.md");
  });

  it("asks before Open discards unsaved changes", async () => {
    disk.set("/w/other.md", "other");
    openDialog.mockResolvedValue("/w/other.md");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    vm.openLocal("a.md", "/w/a.md", "a");
    await flushPromises();
    (await aceOf(w)).session.insert({ row: 0, column: 1 }, "!");
    await flushPromises();

    const pending = vm.openFile();
    await flushPromises();
    await w.get('[data-testid="discard-cancel"]').trigger("click");
    await pending;
    expect(openDialog).not.toHaveBeenCalled();
    expect(vm.name).toBe("a.md");
    expect(vm.dirty).toBe(true);
  });
});

/** Give every element a box for the duration of one test: the sheet waits for
 *  real layout before creating its grid, and jsdom lays nothing out. */
async function withLayout<T>(run: () => Promise<T>): Promise<T> {
  const el = HTMLElement.prototype;
  const w = Object.getOwnPropertyDescriptor(el, "clientWidth");
  const h = Object.getOwnPropertyDescriptor(el, "clientHeight");
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => 1280 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 720 });
  try {
    return await run();
  } finally {
    if (w) Object.defineProperty(el, "clientWidth", w);
    if (h) Object.defineProperty(el, "clientHeight", h);
  }
}

describe("the sheet's file lifecycle", () => {
  it("opens a workbook, marks an edit dirty, saves it in place, reopens it, then switches away", () => withLayout(async () => {
    const { dumps, loads, newWorkbook } = await import("../../src/formats/sheet");
    type Book = ReturnType<typeof newWorkbook> & { sheets: Record<string, { cellData: unknown }> };
    // The stub keeps the workbook it was handed and returns that same object
    // from save(), so changing it IS an edit in the grid.
    const univer = await import("@univerjs/presets") as unknown as
      { createUniver(): { univerAPI: { getActiveWorkbook(): { save(): Book } } } };
    const liveBook = () => univer.createUniver().univerAPI.getActiveWorkbook().save();

    disk.set("/w/budget.json", dumps(newWorkbook("budget")));
    disk.set("/w/n.md", "# n");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    const gridUp = () => Boolean((w.findComponent({ name: "SheetEditor" }).vm as unknown as
      { $: { setupState: { api: unknown } } } | undefined)?.$.setupState.api);

    openDialog.mockResolvedValueOnce("/w/budget.json");
    await vm.openFile();
    await vi.waitFor(() => expect(gridUp()).toBe(true));
    expect(vm.name).toBe("budget.json");
    expect(vm.dirty).toBe(false);

    const book = liveBook();
    book.sheets[book.sheetOrder[0]].cellData = { 0: { 0: { v: 42, t: 2 } } };
    // The sheet polls its grid once a second; the host hears it as dirty.
    await vi.waitFor(() => expect(vm.dirty).toBe(true), { timeout: 3000 });
    expect(vm.canSave).toBe(true);

    await vm.saveFile();
    await flushPromises();
    expect(saveDialog).not.toHaveBeenCalled(); // it has a path: in place
    const written = loads(disk.get("/w/budget.json")!) as Book;
    expect(written.sheets[written.sheetOrder[0]].cellData).toEqual({ 0: { 0: { v: 42, t: 2 } } });
    expect(vm.dirty).toBe(false);

    // Reopen from disk: the edit is what comes back.
    openDialog.mockResolvedValueOnce("/w/budget.json");
    await vm.openFile();
    await vi.waitFor(() => expect(gridUp()).toBe(true));
    const reopened = liveBook();
    expect(reopened.sheets[reopened.sheetOrder[0]].cellData).toEqual({ 0: { 0: { v: 42, t: 2 } } });

    // …and a note replaces the grid, which is disposed rather than left alive.
    const { stats } = univer as unknown as { stats: { disposed: number } };
    const disposed = stats.disposed;
    openDialog.mockResolvedValueOnce("/w/n.md");
    await vm.openFile();
    await flushPromises();
    expect(w.findComponent({ name: "SheetEditor" }).exists()).toBe(false);
    expect(w.findComponent({ name: "TextEditor" }).exists()).toBe(true);
    expect(stats.disposed).toBe(disposed + 1);
  }), 10_000);
});

describe("the drawing's file lifecycle", () => {
  it("opens an SVG, marks an edit dirty, saves plain SVG in place, reopens it, then switches away", async () => {
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 100\">" +
      "<rect x=\"1\" y=\"2\" width=\"10\" height=\"10\" fill=\"none\" stroke=\"#123456\" stroke-width=\"2\" opacity=\"1\"/></svg>";
    disk.set("/w/plan.svg", svg);
    disk.set("/w/n.md", "# n");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    const sketchOf = () => (w.findComponent({ name: "SketchEditor" }).vm as unknown as { $: { setupState: {
      sketch: { addText(x: number, y: number, t: string, s: number, tw: number, th: number): void } } } }).$.setupState.sketch;

    openDialog.mockResolvedValueOnce("/w/plan.svg");
    await vm.openFile();
    await flushPromises();
    expect(w.findComponent({ name: "SketchEditor" }).exists()).toBe(true);
    expect(vm.name).toBe("plan.svg");
    expect(vm.dirty).toBe(false);

    sketchOf().addText(20, 30, "kitchen", 24, 80, 29);
    await flushPromises();
    expect(vm.dirty).toBe(true);

    await vm.saveFile();
    await flushPromises();
    expect(saveDialog).not.toHaveBeenCalled();
    const written = disk.get("/w/plan.svg")!;
    // Still an SVG file: parses as SVG, keeps the original viewBox and shape,
    // and carries the new text as an ordinary <text> element.
    const doc = new DOMParser().parseFromString(written, "image/svg+xml");
    expect(doc.documentElement.nodeName).toBe("svg");
    expect(doc.documentElement.getAttribute("viewBox")).toBe("0 0 200 100");
    expect(doc.getElementsByTagName("rect").length).toBeGreaterThan(0);
    expect([...doc.getElementsByTagName("text")].map((t) => t.textContent)).toContain("kitchen");
    expect(vm.dirty).toBe(false);

    openDialog.mockResolvedValueOnce("/w/plan.svg");
    await vm.openFile();
    await flushPromises();
    const reopened = (w.findComponent({ name: "SketchEditor" }).vm as unknown as { getContent(): string }).getContent();
    expect(reopened).toContain("kitchen");
    expect(vm.dirty).toBe(false);

    openDialog.mockResolvedValueOnce("/w/n.md");
    await vm.openFile();
    await flushPromises();
    expect(w.findComponent({ name: "SketchEditor" }).exists()).toBe(false);
    expect(w.findComponent({ name: "TextEditor" }).exists()).toBe(true);
  });

  it("names a new drawing .svg and asks where it goes", async () => {
    saveDialog.mockResolvedValue("/w/new.svg");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    await vm.newFile("sketch");
    await flushPromises();
    expect(vm.name).toMatch(/\.svg$/);
    await vm.saveFile();
    await flushPromises();
    const opts = saveDialog.mock.calls[0][0] as { filters: Array<{ extensions: string[] }> };
    expect(opts.filters[0].extensions).toEqual(["svg"]);
    expect(disk.get("/w/new.svg")).toContain("<svg");
    expect(vm.name).toBe("new.svg");
  });
});
