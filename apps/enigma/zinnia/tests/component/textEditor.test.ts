import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import TextEditor from "../../src/editors/TextEditor.vue";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";

// ACE itself is stubbed (tests/stubs/ace.ts) — what these cover is the editor
// CONTRACT and the host's routing seam, which is where a regression would land.

describe("the text editor", () => {
  it("implements the contract the host holds it by", async () => {
    const w = mount(TextEditor, {
      props: { path: "/tmp/a.md", name: "a.md", content: "# hi" },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    const vm = w.vm as unknown as {
      markSaved(): void; getContent(): string; isDirty(): boolean;
    };
    expect(typeof vm.markSaved).toBe("function");
    expect(typeof vm.getContent).toBe("function");
    expect(vm.isDirty()).toBe(false);
  });

  it("shows the host's save error through the error prop", () => {
    const w = mount(TextEditor, {
      props: { path: null, name: "x.txt", content: "", error: "disk full" },
      global: { plugins: [i18n] },
    });
    expect(w.text()).toContain("disk full");
  });
});

describe("host routing", () => {
  it("a refused svg can be reopened as plain text", async () => {
    const w = mount(EditorHost, {
      props: { kind: "sketch" },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    await flushPromises();
    // Force a refusing document through the seam the real flow uses.
    const sketchEditor = w.findComponent({ name: "SketchEditor" });
    expect(sketchEditor.exists()).toBe(true);
    sketchEditor.vm.$emit("open-as-text");
    await flushPromises();
    expect(w.findComponent({ name: "SketchEditor" }).exists()).toBe(false);
    expect(w.find('[data-testid="ace-host"]').exists()).toBe(true);
  });
});
