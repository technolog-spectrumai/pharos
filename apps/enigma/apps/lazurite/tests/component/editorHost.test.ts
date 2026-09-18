import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";
import { KIND_FILES, type EditorKind } from "../../src/kinds";
import { dumps as dumpDoc, newDocument, sniffIsDocument } from "../../src/formats/document";
import { dumps as dumpDeck, newPresentation, sniffIsPresentation } from "../../src/formats/presentation";
import { dumps as dumpSheet, isSheet, newWorkbook } from "../../src/formats/sheet";

// The host owns the file; the mounted editor owns the buffer. What matters
// here is that the FILE decides which editor mounts, that dirty flows up, and
// that nothing from one file leaks into the next.
function mountHost() {
  return mount(EditorHost, {
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

type HostVm = {
  newFile(kind: EditorKind): Promise<void>;
  openLocal(name: string, path: string, text: string): void;
  name: string; dirty: boolean; canSave: boolean; hasFile: boolean;
};

const EDITORS = ["DocumentEditor", "PresentationEditor", "SheetEditor", "SketchEditor", "TextEditor"];

/** Which editor component is mounted, and whether the code picker is on —
 *  the picker is what tells the code editor from the Markdown one. */
function mounted(w: ReturnType<typeof mountHost>) {
  const names = EDITORS.filter((name) => w.findComponent({ name }).exists());
  return { names, picker: w.find('[data-testid="language-select"]').exists() };
}

describe("the editor host", () => {
  it("starts with no file and no editor", async () => {
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    expect(vm.hasFile).toBe(false);
    expect(vm.canSave).toBe(false);
    expect(mounted(w).names).toEqual([]);
    expect(w.find('[data-testid="start"]').exists()).toBe(true);
    // The command surface is there regardless; the menu asks it.
    const host = w.vm as unknown as Record<string, unknown>;
    for (const command of ["newFile", "openFile", "saveFile", "saveAs", "openLocal"]) {
      expect(typeof host[command], command).toBe("function");
    }
  });

  it("mounts the editor the file asks for", async () => {
    const cases: Array<[string, string, string, boolean]> = [
      ["talk.pxml", dumpDeck(newPresentation("t")), "PresentationEditor", false],
      ["old-talk.xml", dumpDeck(newPresentation("t")), "PresentationEditor", false],
      ["paper.xml", dumpDoc(newDocument("p")), "DocumentEditor", false],
      ["note.md", "# note", "TextEditor", false],
      ["note.markdown", "# note", "TextEditor", false],
      ["script.py", "print(1)", "TextEditor", true],
      ["pom.xml", "<project/>", "TextEditor", true],
      ["budget.json", dumpSheet(newWorkbook("budget")), "SheetEditor", false],
      ["package.json", '{"name":"x"}', "TextEditor", true],
      ["plan.svg", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'/>", "SketchEditor", false],
    ];
    for (const [name, text, editor, picker] of cases) {
      const w = mountHost();
      await flushPromises();
      (w.vm as unknown as HostVm).openLocal(name, `/w/${name}`, text);
      await flushPromises();
      expect(mounted(w), name).toEqual({ names: [editor], picker });
      expect(w.find('[data-testid="start"]').exists(), name).toBe(false);
    }
  });

  it("swaps the editor, its toolbar and the file's identity when another file opens", async () => {
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;

    vm.openLocal("talk.pxml", "/w/talk.pxml", dumpDeck(newPresentation("t")));
    await flushPromises();
    expect(w.find('[data-testid="add-slide"]').exists()).toBe(true);
    w.findComponent({ name: "PresentationEditor" }).vm.$emit("update:dirty", true);
    await flushPromises();
    expect(vm.dirty).toBe(true);

    // A clean file replaces it: no discard prompt is owed for openLocal's
    // caller, which has already read the new file. The old dirt must not
    // follow the new name.
    vm.openLocal("idea.md", "/w/idea.md", "# idea");
    await flushPromises();
    expect(vm.name).toBe("idea.md");
    expect(vm.dirty).toBe(false);
    expect(mounted(w)).toEqual({ names: ["TextEditor"], picker: false });
    expect(w.find('[data-testid="add-slide"]').exists()).toBe(false);
    expect(w.find('[data-testid="editor-undo"]').exists()).toBe(true);

    vm.openLocal("main.ts", "/w/main.ts", "export {}");
    await flushPromises();
    expect(mounted(w)).toEqual({ names: ["TextEditor"], picker: true });
  });

  it("publishes dirty when the editor reports changes", async () => {
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    await vm.newFile("document");
    await flushPromises();
    expect(vm.dirty).toBe(false);
    w.findComponent({ name: "DocumentEditor" }).vm.$emit("update:dirty", true);
    await flushPromises();
    expect(vm.dirty).toBe(true);
  });

  it("names a new file after the kind it was asked for", async () => {
    for (const kind of Object.keys(KIND_FILES) as EditorKind[]) {
      const w = mountHost();
      await flushPromises();
      const vm = w.vm as unknown as HostVm;
      await vm.newFile(kind);
      await flushPromises();
      const ext = KIND_FILES[kind].extensions[0];
      expect(vm.name, `${kind} should default to a .${ext} name`).toMatch(new RegExp(`\\.${ext}$`));
      // Never written anywhere, so Save is Save As and is on.
      expect(vm.canSave, kind).toBe(true);
    }
  });

  it("seeds a new file its own editor can reopen", async () => {
    const cases: Array<[EditorKind, string, (t: string) => boolean]> = [
      ["document", "DocumentEditor", sniffIsDocument],
      ["deck", "PresentationEditor", sniffIsPresentation],
      ["sheet", "SheetEditor", isSheet],
    ];
    for (const [kind, editor, accepts] of cases) {
      const w = mountHost();
      await flushPromises();
      await (w.vm as unknown as HostVm).newFile(kind);
      await flushPromises();
      const handle = w.findComponent({ name: editor }).vm as unknown as { getContent(): string };
      expect(accepts(handle.getContent()), `${kind} seed must sniff as ${kind}`).toBe(true);
    }
  });

  it("opens a file from disk clean, with nothing to save until it changes", async () => {
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    vm.openLocal("idea.md", "/w/idea.md", "# idea");
    await flushPromises();
    expect(vm.hasFile).toBe(true);
    expect(vm.dirty).toBe(false);
    expect(vm.canSave).toBe(false);
  });
});

describe("a drawing the editor refuses", () => {
  it("reopens as plain text without renaming it, and the next file gets its own editor", async () => {
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    vm.openLocal("evil.svg", "/w/evil.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>");
    await flushPromises();
    await w.get('[data-testid="svg-open-text"]').trigger("click");
    await flushPromises();
    expect(mounted(w)).toEqual({ names: ["TextEditor"], picker: false });
    expect(vm.name).toBe("evil.svg");

    vm.openLocal("fine.svg", "/w/fine.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await flushPromises();
    expect(mounted(w).names).toEqual(["SketchEditor"]);
  });
});

describe("the discard prompt", () => {
  it("asks before New throws away unsaved work, and cancel keeps it", async () => {
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    vm.openLocal("draft.md", "/w/draft.md", "# draft");
    await flushPromises();
    w.findComponent({ name: "TextEditor" }).vm.$emit("update:dirty", true);
    await flushPromises();
    expect(vm.dirty).toBe(true);

    const pending = vm.newFile("deck");
    await flushPromises();
    expect(w.find('[data-testid="discard-cancel"]').exists()).toBe(true);
    await w.get('[data-testid="discard-cancel"]').trigger("click");
    await pending;
    // Still the draft, still dirty, still in its own editor.
    expect(vm.name).toBe("draft.md");
    expect(vm.dirty).toBe(true);
    expect(w.findComponent({ name: "PresentationEditor" }).exists()).toBe(false);

    const again = vm.newFile("deck");
    await flushPromises();
    await w.get('[data-testid="discard-confirm"]').trigger("click");
    await again;
    expect(vm.name).toMatch(/\.pxml$/);
    expect(vm.dirty).toBe(false);
    expect(w.findComponent({ name: "PresentationEditor" }).exists()).toBe(true);
  });
});
