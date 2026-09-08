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

describe("the undo stack", () => {
  async function mountCode(name = "a.txt", content = "hello") {
    const w = mount(TextEditor, {
      props: { path: null, name, content, withPicker: true },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    return w;
  }
  const undoBtn = (w: ReturnType<typeof mount>) =>
    w.get('[data-testid="editor-undo"]').element as HTMLButtonElement;
  const redoBtn = (w: ReturnType<typeof mount>) =>
    w.get('[data-testid="editor-redo"]').element as HTMLButtonElement;

  it("offers nothing to undo on a file just opened", async () => {
    // `session.setValue` resets the manager. Without that, the first undo
    // would offer to undo the act of opening the file.
    const w = await mountCode();
    expect(undoBtn(w).disabled).toBe(true);
    expect(redoBtn(w).disabled).toBe(true);
  });

  /** The live ACE instance behind a mounted editor. `ace.edit` hands back the
   *  one already managing an element rather than making a second — which is
   *  what lets a test drive a real edit instead of simulating one. */
  async function aceOf(w: ReturnType<typeof mount>) {
    const ace = (await import("../../src/editors/aceSetup")).default;
    return ace.edit(w.get('[data-testid="ace-host"]').element as HTMLElement);
  }

  it("follows the stack as the buffer changes", async () => {
    const w = await mountCode();
    const editor = await aceOf(w);

    editor.session.insert({ row: 0, column: 5 }, " there");
    await flushPromises();
    expect(editor.getValue()).toBe("hello there");
    expect(undoBtn(w).disabled).toBe(false);
    expect(redoBtn(w).disabled).toBe(true);

    await w.get('[data-testid="editor-undo"]').trigger("click");
    await flushPromises();
    expect(editor.getValue()).toBe("hello");
    // Undoing is what fills the redo side.
    expect(redoBtn(w).disabled).toBe(false);

    await w.get('[data-testid="editor-redo"]').trigger("click");
    await flushPromises();
    expect(editor.getValue()).toBe("hello there");
  });

  it("keeps the host's dirty flag in step with an undo", async () => {
    // Undoing back to the saved text is not "still edited" — the host's save
    // button reads this, and the two must agree about what is on screen.
    const w = await mountCode();
    const editor = await aceOf(w);
    const vm = w.vm as unknown as { isDirty(): boolean };

    editor.session.insert({ row: 0, column: 5 }, " there");
    await flushPromises();
    expect(vm.isDirty()).toBe(true);

    await w.get('[data-testid="editor-undo"]').trigger("click");
    await flushPromises();
    expect(vm.isDirty()).toBe(false);
  });

  it("is absent from the refusal fallback, which stays bare", async () => {
    const w = mount(TextEditor, {
      props: { path: null, name: "a.svg", content: "<svg/>" },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(w.find('[data-testid="editor-undo"]').exists()).toBe(false);
    expect(w.find('[data-testid="editor-redo"]').exists()).toBe(false);
  });
});

describe("a picture in the code view", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("shows the image instead of a buffer", async () => {
    const w = mount(TextEditor, {
      props: { path: null, name: "photo.png", content: PNG, withPicker: true },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(w.get('[data-testid="image-preview"]').attributes("src")).toBe(PNG);
    // No editor at all — an undo stack over a data: URI would be nonsense.
    expect(w.find('[data-testid="ace-host"]').exists()).toBe(false);
    expect(w.find('[data-testid="editor-undo"]').exists()).toBe(false);
    expect(w.find('[data-testid="language-select"]').exists()).toBe(false);
  });

  it("goes back to being an editor for a text file", async () => {
    const w = mount(TextEditor, {
      props: { path: null, name: "notes.txt", content: "hello", withPicker: true },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(w.find('[data-testid="image-view"]').exists()).toBe(false);
    expect(w.get('[data-testid="ace-host"]').exists()).toBe(true);
  });
});

describe("host routing", () => {

  it("refuses to save a picture, so its bytes cannot be written back as text", async () => {
    // Save As would write the `data:` URI out as text — a corrupt copy of the
    // file it came from. The whole save path is closed for a picture.
    const w = mount(EditorHost, {
      props: { kind: "code" },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    const vm = w.vm as unknown as {
      openRemote(name: string, text: string): void;
      canSave: boolean; dirty: boolean;
    };
    vm.openRemote("photo.png", "data:image/png;base64,iVBORw0KGgo=");
    await flushPromises();
    expect(w.find('[data-testid="image-preview"]').exists()).toBe(true);
    expect(vm.canSave).toBe(false);
    // …and no unsaved dot beside something that cannot be saved.
    expect(vm.dirty).toBe(false);

    // A text file handed over the same way is still savable.
    vm.openRemote("notes.txt", "hello");
    await flushPromises();
    expect(vm.canSave).toBe(true);
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