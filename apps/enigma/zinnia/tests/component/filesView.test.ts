import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import FilesView from "../../src/views/FilesView.vue";
import { i18n } from "../../src/i18n";

// Everything below the view is mocked at the Tauri boundary. What is being
// tested is the view's own judgement: what it offers, what it refuses, and what
// it says.
const invoke = vi.fn();
const readDir = vi.fn();
const stat = vi.fn();
const readTextFile = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: (...a: unknown[]) => readDir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readTextFile: (...a: unknown[]) => readTextFile(...a),
  writeTextFile: vi.fn(),
}));

function mountFiles() {
  return mount(FilesView, { global: { plugins: [i18n], stubs: { teleport: true } } });
}

/** The read chain is deeper than one microtask: a dynamic `import()` of the fs
 *  plugin, then readDir, then a stat per row. Drain until it settles. */
async function settle() {
  for (let i = 0; i < 8; i++) await flushPromises();
}

/** Put the workspace store into the state a picked root leaves behind. It is a
 *  module-level store, so it is reached the same way the view reaches it. */
async function withRoot(root: string) {
  const { useWorkspace } = await import("../../src/files/useWorkspace");
  localStorage.setItem("zinnia:workspace", JSON.stringify({ root }));
  const workspace = useWorkspace();
  workspace.root.value = root;
  workspace.relative.value = "";
  return workspace;
}

beforeEach(async () => {
  localStorage.clear();
  invoke.mockReset();
  readDir.mockReset();
  stat.mockReset();
  readTextFile.mockReset();
  stat.mockResolvedValue({ size: 12, mtime: null });
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { useWorkspace } = await import("../../src/files/useWorkspace");
  const workspace = useWorkspace();
  workspace.root.value = "";
  workspace.entries.value = [];
  workspace.error.value = "";
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the Files tab", () => {
  it("offers a folder picker before anything else", async () => {
    const w = mountFiles();
    await settle();
    expect(w.get('[data-testid="workspace-empty"]').exists()).toBe(true);
    expect(w.get('[data-testid="workspace-pick"]').exists()).toBe(true);
  });

  it("lists the picked folder, directories first", async () => {
    readDir.mockResolvedValue([
      { name: "drawing.svg", isDirectory: false },
      { name: "notes", isDirectory: true },
    ]);
    const workspace = await withRoot("/home/u/work");
    const w = mountFiles();
    await settle();
    await workspace.refresh();
    await settle();

    expect(w.get('[data-testid="entry-notes"]').exists()).toBe(true);
    expect(w.get('[data-testid="entry-drawing.svg"]').exists()).toBe(true);
    expect(workspace.entries.value.map((e) => e.name)).toEqual(["notes", "drawing.svg"]);
  });

  it("hands a file to the editor its content calls for", async () => {
    readDir.mockResolvedValue([{ name: "drawing.svg", isDirectory: false }]);
    readTextFile.mockResolvedValue("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const workspace = await withRoot("/home/u/work");
    const w = mountFiles();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="entry-drawing.svg"]').trigger("click");
    await settle();

    const opened = w.emitted("open")?.[0][0] as { kind: string; name: string };
    expect(opened.kind).toBe("sketch");
    expect(opened.name).toBe("drawing.svg");
  });

  it("does not try to open a file no editor here reads", async () => {
    readDir.mockResolvedValue([{ name: "photo.png", isDirectory: false }]);
    const workspace = await withRoot("/home/u/work");
    const w = mountFiles();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="entry-photo.png"]').trigger("click");
    await settle();
    expect(readTextFile).not.toHaveBeenCalled();
    expect(w.emitted("open")).toBeUndefined();
  });

  it("steps into a folder rather than opening it", async () => {
    readDir.mockResolvedValue([{ name: "notes", isDirectory: true }]);
    const workspace = await withRoot("/home/u/work");
    const w = mountFiles();
    await settle();
    await workspace.refresh();
    await settle();

    readDir.mockResolvedValue([]);
    await w.get('[data-testid="entry-notes"]').trigger("click");
    await settle();
    expect(workspace.relative.value).toBe("notes");
    expect(w.emitted("open")).toBeUndefined();
  });

  it("shows a filesystem message verbatim, not as a missing key", async () => {
    // A read error has no catalogue entry and is more useful as it came.
    readDir.mockRejectedValue(new Error("forbidden path"));
    const workspace = await withRoot("/home/u/work");
    const w = mountFiles();
    await settle();
    await workspace.refresh();
    await settle();
    expect(w.get('[data-testid="workspace-error"]').text()).toBe("forbidden path");
  });
});
