// The text editor of Files → Local, on its own. It owns the buffer and nothing
// else: LocalPanel holds the path, the lock state and the passphrase, and does
// every read and write. So the contract pinned here is the seam between the two
// — what `save` hands up, when the buffer counts as unsaved (the parent's
// discard prompt hangs on that flag), and that markSaved() re-baselines it.
//
// ACE itself cannot run in jsdom, so aceSetup's default export is replaced by a
// small recording editor (tests/stubs/fakeAce.ts); the real mode table and theme
// names stay, because "which highlighting does this file get" is behaviour.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("../../src/components/local/aceSetup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/components/local/aceSetup")>()),
  default: (await import("../stubs/fakeAce")).fakeAce,
}));

import { i18n } from "../../src/i18n";
import NoteEditor from "../../src/components/local/NoteEditor.vue";
import { THEME_DARK, THEME_LIGHT } from "../../src/components/local/aceSetup";
import { fakeAce } from "../stubs/fakeAce";

(i18n.global.locale as unknown as { value: string }).value = "en";

type Exposed = { markSaved: () => void; getContent: () => string; isDirty: () => boolean };

function mountEditor(over: Record<string, unknown> = {}) {
  const wrapper = mount(NoteEditor, {
    props: { path: "/home/a/todo.txt", name: "todo.txt", content: "milk", locked: false, ...over },
    global: { plugins: [i18n] },
  });
  const editor = fakeAce.last();
  return { wrapper, editor, vm: wrapper.vm as unknown as Exposed };
}

/** The toolbar's Save button (the only plain <button> that is not an icon button). */
const saveButton = (w: ReturnType<typeof mountEditor>["wrapper"]) =>
  w.findAll("button").find((b) => b.text().includes("Save"))!;
const encryptButton = (w: ReturnType<typeof mountEditor>["wrapper"]) => w.find("button[aria-label='Encrypt…']");

beforeEach(() => {
  fakeAce.reset();
});

describe("NoteEditor — mounting ACE", () => {
  it("opens the file's text with the highlighting its name implies, and takes focus", () => {
    const { editor } = mountEditor({ name: "README.md", content: "# hi" });
    expect(editor.options).toMatchObject({ mode: "ace/mode/markdown", theme: THEME_LIGHT, wrap: true, tabSize: 2 });
    expect(editor.getValue()).toBe("# hi");
    expect(editor.focused).toBe(1);
    // Ctrl/Cmd-S is wired inside ACE, where the window never sees the keystroke.
    expect(editor.commands.map((c) => c.name)).toEqual(["saveNote"]);
    expect(editor.commands[0].bindKey).toEqual({ win: "Ctrl-S", mac: "Cmd-S" });
  });

  it("follows the darkMode prop, live", async () => {
    const dark = mountEditor({ darkMode: true });
    expect(dark.editor.options.theme).toBe(THEME_DARK);

    const light = mountEditor({ darkMode: false });
    expect(light.editor.options.theme).toBe(THEME_LIGHT);
    // The app's theme toggle flips the prop on an open editor.
    await light.wrapper.setProps({ darkMode: true });
    await light.wrapper.setProps({ darkMode: false });
    expect(light.editor.themes).toEqual([THEME_DARK, THEME_LIGHT]);
  });

  it("re-highlights when Save As renames the file", async () => {
    const { wrapper, editor } = mountEditor({ path: null, name: "untitled.txt" });
    await wrapper.setProps({ path: "/home/a/conf.json", name: "conf.json" });
    expect(editor.modes).toEqual(["ace/mode/json"]);
  });

  it("tears ACE down when it leaves the page", () => {
    const { wrapper, editor } = mountEditor();
    wrapper.unmount();
    expect(editor.destroyed).toBe(1);
  });
});

describe("NoteEditor — unsaved changes", () => {
  it("reports dirty once when the buffer diverges, and clean again when typed back", async () => {
    const { wrapper, editor, vm } = mountEditor();
    editor.type("milk, eggs");
    editor.type("milk, eggs, bread");
    await wrapper.vm.$nextTick();
    // One transition, one event — the parent toggles its discard prompt on it.
    expect(wrapper.emitted("update:dirty")).toEqual([[true]]);
    expect(vm.isDirty()).toBe(true);
    expect(wrapper.find("[title='Unsaved changes']").exists()).toBe(true);

    editor.type("milk");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("update:dirty")).toEqual([[true], [false]]);
    expect(wrapper.find("[title='Unsaved changes']").exists()).toBe(false);
  });

  it("markSaved re-baselines against the buffer as it is now", async () => {
    const { wrapper, editor, vm } = mountEditor();
    editor.type("milk, eggs");
    vm.markSaved();
    expect(vm.isDirty()).toBe(false);
    expect(wrapper.emitted("update:dirty")).toEqual([[true], [false]]);

    // The old text is now the divergent one.
    editor.type("milk");
    expect(vm.isDirty()).toBe(true);
    editor.type("milk, eggs");
    expect(vm.isDirty()).toBe(false);
  });

  it("getContent hands over the live buffer, not the text it was opened with", () => {
    const { editor, vm } = mountEditor();
    editor.type("rewritten");
    expect(vm.getContent()).toBe("rewritten");
  });
});

describe("NoteEditor — saving", () => {
  it("emits the live buffer from the Save button and from Ctrl-S alike", async () => {
    const { wrapper, editor } = mountEditor();
    editor.type("milk, eggs");
    await wrapper.vm.$nextTick();
    await saveButton(wrapper).trigger("click");
    editor.type("milk, eggs, jam");
    editor.press("saveNote");
    expect(wrapper.emitted("save")).toEqual([["milk, eggs"], ["milk, eggs, jam"]]);
  });

  it("refuses to save while a write is already in flight", async () => {
    const { wrapper, editor } = mountEditor({ busy: true });
    editor.type("changed");
    await saveButton(wrapper).trigger("click");
    editor.press("saveNote");
    expect(wrapper.emitted("save")).toBeUndefined();
  });

  it("greys Save out for an untouched existing file, but never for a note with nowhere to go yet", async () => {
    const existing = mountEditor();
    expect(saveButton(existing.wrapper).classes()).toContain("pointer-events-none");
    existing.editor.type("changed");
    await existing.wrapper.vm.$nextTick();
    expect(saveButton(existing.wrapper).classes()).not.toContain("pointer-events-none");

    // A new note must be savable before it is typed into, or Save As is unreachable.
    const fresh = mountEditor({ path: null, name: "untitled.txt", content: "" });
    expect(saveButton(fresh.wrapper).classes()).not.toContain("pointer-events-none");
  });

  it("shows the parent's save error above the buffer", () => {
    const { wrapper } = mountEditor({ error: "disk full" });
    expect(wrapper.find("p.text-warn-dark").text()).toBe("disk full");
  });
});

describe("NoteEditor — toolbar", () => {
  it("offers Encrypt on a plain file and says it is plain", async () => {
    const { wrapper } = mountEditor();
    expect(wrapper.text()).toContain("Plain text");
    await encryptButton(wrapper).trigger("click");
    expect(wrapper.emitted("encrypt")).toEqual([[]]);
  });

  it("has no Encrypt on a file that is already sealed", () => {
    const { wrapper } = mountEditor({ locked: true });
    expect(wrapper.text()).toContain("Encrypted on disk");
    expect(encryptButton(wrapper).exists()).toBe(false);
  });

  it("disables Encrypt while a write is in flight", async () => {
    const { wrapper } = mountEditor({ busy: true });
    await encryptButton(wrapper).trigger("click");
    expect(wrapper.emitted("encrypt")).toBeUndefined();
  });

  it("Back is a request to the parent, which decides about unsaved work", async () => {
    const { wrapper } = mountEditor();
    await wrapper.find("button[aria-label='Back']").trigger("click");
    expect(wrapper.emitted("back")).toEqual([[]]);
  });
});
