import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";
import { KIND_FILES, type EditorKind } from "../../src/tabs";
import { sniffIsDocument } from "../../src/formats/document";
import { sniffIsPresentation } from "../../src/formats/presentation";
import { isSheet } from "../../src/formats/sheet";

// The host owns the file; the mounted editor owns the buffer. What matters
// here is the seam between them — dirty flows up, save asks the editor for its
// content — and that the TAB decides which editor this is, not the filename.
function mountHost(kind: EditorKind) {
  return mount(EditorHost, {
    props: { kind },
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

const EDITOR_FOR: Record<EditorKind, string> = {
  sketch: "SketchEditor",
  document: "DocumentEditor",
  deck: "PresentationEditor",
  sheet: "SheetEditor",
  // ACE, with its language picker on. Not typechecked here (vitest transpiles
  // without it), so an omission would silently drop this kind from the suites
  // below rather than fail.
  code: "TextEditor",
};

describe("the editor host", () => {
  for (const kind of Object.keys(EDITOR_FOR) as EditorKind[]) {
    it(`mounts the ${kind} editor because its tab says so`, async () => {
      const w = mountHost(kind);
      await flushPromises();
      expect(w.findComponent({ name: EDITOR_FOR[kind] }).exists()).toBe(true);
      // …and only that one: a tab is one editor, not a chooser.
      for (const [other, name] of Object.entries(EDITOR_FOR)) {
        if (other !== kind) expect(w.findComponent({ name }).exists()).toBe(false);
      }
      // The file commands live in the app menu now, so what the host owes the
      // outside world is the command surface, not a toolbar.
      const host = w.vm as unknown as Record<string, unknown>;
      for (const command of ["newFile", "openFile", "saveFile", "saveAs"]) {
        expect(typeof host[command], command).toBe("function");
      }
    });
  }

  it("publishes dirty when the editor reports changes", async () => {
    // The dot is drawn by the app header now; what the host is responsible for
    // is telling the truth about the file it owns.
    const w = mountHost("sketch");
    await flushPromises();
    const host = w.vm as unknown as { dirty: boolean };
    expect(host.dirty).toBe(false);
    w.findComponent({ name: "SketchEditor" }).vm.$emit("update:dirty", true);
    await flushPromises();
    expect(host.dirty).toBe(true);
  });

  it("names a new file after its own kind", async () => {
    for (const kind of Object.keys(EDITOR_FOR) as EditorKind[]) {
      const w = mountHost(kind);
      await flushPromises();
      const shown = (w.vm as unknown as { name: string }).name;
      const ext = KIND_FILES[kind].extensions[0];
      expect(shown, `${kind} should default to a .${ext} name`).toMatch(new RegExp(`\\.${ext}$`));
    }
  });

  it("seeds a new file its own editor can reopen", async () => {
    // The structured kinds parse on open, so an unseeded buffer would come back
    // as "not a document" the moment the tab was reopened.
    const cases: Array<[EditorKind, (t: string) => boolean]> = [
      ["document", sniffIsDocument],
      ["deck", sniffIsPresentation],
      ["sheet", isSheet],
    ];
    for (const [kind, accepts] of cases) {
      const w = mountHost(kind);
      await flushPromises();
      const handle = w.findComponent({ name: EDITOR_FOR[kind] }).vm as unknown as
        { getContent(): string };
      expect(accepts(handle.getContent()), `${kind} seed must sniff as ${kind}`).toBe(true);
    }
  });
});
