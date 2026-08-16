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
      expect(w.find('[data-testid="file-save"]').exists()).toBe(true);
    });
  }

  it("shows the dirty dot when the editor reports changes", async () => {
    const w = mountHost("sketch");
    await flushPromises();
    expect(w.find('[title="Unsaved changes"]').exists()).toBe(false);
    w.findComponent({ name: "SketchEditor" }).vm.$emit("update:dirty", true);
    await flushPromises();
    expect(w.find('[title="Unsaved changes"]').exists()).toBe(true);
  });

  it("names a new file after its own kind", async () => {
    for (const kind of Object.keys(EDITOR_FOR) as EditorKind[]) {
      const w = mountHost(kind);
      await flushPromises();
      const shown = w.get('[data-testid="file-name"]').text();
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
