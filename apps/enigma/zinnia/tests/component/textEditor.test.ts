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

describe("the language picker", () => {
  /** The trigger's text is what the picker currently claims the file is. */
  async function mountCode(name: string, content = "") {
    const w = mount(TextEditor, {
      props: { path: null, name, content, withPicker: true },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    return w;
  }
  const shown = (w: ReturnType<typeof mount>) =>
    w.get('[data-testid="language-select"] [data-testid="select-trigger"]').text();

  async function choose(w: ReturnType<typeof mount>, testid: string) {
    await w.get('[data-testid="language-select"] [data-testid="select-trigger"]').trigger("click");
    await w.get(`[data-testid="language-select"] [data-testid="${testid}"]`).trigger("click");
    await flushPromises();
  }

  it("is absent in the refusal fallback", async () => {
    // The fallback is deliberately bare: nothing was chosen about that file.
    const w = mount(TextEditor, {
      props: { path: null, name: "a.svg", content: "<svg/>" },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(w.find('[data-testid="language-select"]').exists()).toBe(false);
  });

  it("names the language it detected from the file", async () => {
    expect(shown(await mountCode("script.py"))).toBe("Python");
    expect(shown(await mountCode("styles.css"))).toBe("CSS");
  });

  it("says plain text for a name it cannot place", async () => {
    // The empty-label path: SelectMenu supplies the one translatable name.
    expect(shown(await mountCode("mystery.xyz"))).toBe("Plain text");
  });

  it("takes the language the user picks", async () => {
    const w = await mountCode("script.py");
    await choose(w, "select-option-JSON");
    expect(shown(w)).toBe("JSON");
  });

  it("lets a pick outlive a Save As rename", async () => {
    // A pick is an instruction and a rename is a guess; the guess must not win.
    // Save As renames without remounting, which is what makes this reachable.
    const w = await mountCode("script.py");
    await choose(w, "select-option-JSON");
    await w.setProps({ name: "script.rb" });
    await flushPromises();
    expect(shown(w)).toBe("JSON");
  });

  it("still follows a rename while nobody has picked", async () => {
    const w = await mountCode("a.py");
    await w.setProps({ name: "a.css" });
    await flushPromises();
    expect(shown(w)).toBe("CSS");
  });

  it("offers plain text as a choice, not only as a fallback", async () => {
    const w = await mountCode("script.py");
    await choose(w, "select-option-empty");
    expect(shown(w)).toBe("Plain text");
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

  it("the code tab opens a buffer the files panel handed it", async () => {
    // The whole panel walk in one place: a .py is routed to this tab, the host
    // remounts the editor for it, the picker detects Python from the name, and
    // the buffer arrives dirty because nothing on disk holds it yet.
    const w = mount(EditorHost, {
      props: { kind: "code" },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(w.find('[data-testid="ace-host"]').exists()).toBe(true);
    const trigger = '[data-testid="language-select"] [data-testid="select-trigger"]';
    // A new Code file is born plain text — the language is nobody's choice yet.
    expect(w.get(trigger).text()).toBe("Plain text");

    const vm = w.vm as unknown as {
      openRemote(name: string, text: string): void;
      dirty: boolean;
    };
    vm.openRemote("script.py", "print(1)");
    await flushPromises();
    expect(w.get(trigger).text()).toBe("Python");
    expect(vm.dirty).toBe(true);
  });
});