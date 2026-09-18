import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import App from "../../src/App.vue";
import TagModal from "../../src/files/TagModal.vue";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";
import { useWorkspace } from "petalite/files";

// Tags: three words per file, plain text, by path. Rust holds them
// (mocked here); what the page owes is the cap, the warning, and chips that
// follow the open file.
const stored = new Map<string, string[]>();
const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  switch (cmd) {
    case "tags_get": return stored.get(args.path as string) ?? [];
    case "tags_set": {
      const tags = (args.tags as string[]).map((t) => t.trim()).filter(Boolean);
      if (tags.length > 3) throw "too_many_tags: at most 3 tags per file";
      stored.set(args.path as string, tags);
      return tags;
    }
    case "is_file_locked": return false;
    case "secret_status": return { remembered: false, storage: null };
    default: return null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, Record<string, unknown>]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

async function settle() {
  for (let i = 0; i < 6; i++) await flushPromises();
}

beforeEach(() => {
  stored.clear();
  invoke.mockClear();
  localStorage.clear();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useWorkspace().root.value = "/w";
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the tag modal", () => {
  function mountModal(sealed = false) {
    return mount(TagModal, {
      props: { open: false, name: "a.md", path: "/w/a.md", sealed },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
  }

  it("shows three fields, filled from the file's tags, and says they are plain text", async () => {
    stored.set("/w/a.md", ["work", "ideas"]);
    const w = mountModal();
    await w.setProps({ open: true });
    await settle();
    expect(w.findAll('[data-testid^="tag-field-"]')).toHaveLength(3);
    expect((w.get('[data-testid="tag-field-0"]').element as HTMLInputElement).value).toBe("work");
    expect((w.get('[data-testid="tag-field-1"]').element as HTMLInputElement).value).toBe("ideas");
    expect((w.get('[data-testid="tag-field-2"]').element as HTMLInputElement).value).toBe("");
    expect(w.get('[data-testid="tags-note"]').text()).toContain("plain text");
    expect(w.get('[data-testid="tags-note"]').text()).toContain("never encrypted");
    expect(w.find('[data-testid="tags-sealed-note"]').exists()).toBe(false);
  });

  it("warns harder for an encrypted file, and saves what was typed", async () => {
    const w = mountModal(true);
    await w.setProps({ open: true });
    await settle();
    expect(w.get('[data-testid="tags-sealed-note"]').text()).toContain("stays readable");
    await w.get('[data-testid="tag-field-0"]').setValue(" taxes ");
    await w.get('[data-testid="tag-field-2"]').setValue("2026");
    await w.get('[data-testid="tags-save"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("tags_set", { path: "/w/a.md", tags: [" taxes ", "", "2026"] });
    expect(w.emitted("saved")?.[0][0]).toEqual(["taxes", "2026"]);
    expect(w.emitted("update:open")?.at(-1)).toEqual([false]);
  });

  it("shows a refusal from Rust and stays open", async () => {
    invoke.mockImplementationOnce(async () => []).mockImplementationOnce(async () => { throw "too_many_tags: at most 3 tags per file"; });
    const w = mountModal();
    await w.setProps({ open: true });
    await settle();
    await w.get('[data-testid="tags-save"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="tags-error"]').text()).toBe("A file can have at most three tags.");
    expect(w.emitted("saved")).toBeUndefined();
  });
});

describe("tags in the header", () => {
  it("shows the open file's tags as chips, and none for a file not yet on disk", async () => {
    stored.set("/w/a.md", ["work", "q3"]);
    const w = mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
    await flushPromises();
    expect(w.find('[data-testid="file-tags"]').exists()).toBe(false);

    const host = w.findComponent(EditorHost).vm as unknown as {
      openLocal(n: string, p: string, t: string): void; newFile(k: string): Promise<void>;
    };
    host.openLocal("a.md", "/w/a.md", "# a");
    await settle();
    expect(invoke).toHaveBeenCalledWith("tags_get", { path: "/w/a.md" });
    expect(w.get('[data-testid="file-tag-0"]').text()).toBe("work");
    expect(w.get('[data-testid="file-tag-1"]').text()).toBe("q3");

    await w.get('[data-testid="file-tags"]').trigger("click");
    await settle();
    await w.get('[data-testid="tag-field-2"]').setValue("later");
    await w.get('[data-testid="tags-save"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="file-tag-2"]').text()).toBe("later");

    // A new, unsaved file has no path to file a tag under.
    await host.newFile("markdown");
    await settle();
    expect(w.find('[data-testid="file-tags"]').exists()).toBe(false);
  });
});
