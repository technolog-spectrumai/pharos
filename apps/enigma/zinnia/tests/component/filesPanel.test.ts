import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import FilesPanel from "../../src/files/FilesPanel.vue";
import { i18n } from "../../src/i18n";

// Everything below the panel is mocked at the Tauri boundary. What is being
// tested is the panel's own judgement: what it lists, what it opens, what it
// refuses, and what it says.
const invoke = vi.fn();
const readDir = vi.fn();
const stat = vi.fn();
const readTextFile = vi.fn();
const openDialog = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: (...a: unknown[]) => readDir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readTextFile: (...a: unknown[]) => readTextFile(...a),
  writeTextFile: vi.fn(),
}));

const SVG = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";
const ROOT = "/home/u/work";

function mountPanel() {
  return mount(FilesPanel, { global: { plugins: [i18n], stubs: { teleport: true } } });
}

/** The read chain is deeper than one microtask: a dynamic `import()` of the fs
 *  plugin, then readDir, then a stat per row. Drain until it settles. */
async function settle() {
  for (let i = 0; i < 8; i++) await flushPromises();
}

/** Put the store into the state a picked root leaves behind. It is a
 *  module-level store, so it is reached the same way the panel reaches it. */
async function withRoot(root = ROOT) {
  const { useWorkspace } = await import("../../src/files/useWorkspace");
  const workspace = useWorkspace();
  workspace.root.value = root;
  return workspace;
}

/** `readDir` answers per directory, so a tree is described as a map. */
function tree(byDir: Record<string, Array<[string, boolean]>>) {
  readDir.mockImplementation(async (dir: string) =>
    (byDir[dir] ?? []).map(([name, isDirectory]) => ({ name, isDirectory })));
}

beforeEach(async () => {
  localStorage.clear();
  for (const fn of [invoke, readDir, stat, readTextFile, openDialog]) fn.mockReset();
  stat.mockResolvedValue({ size: 12, mtime: null });
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { useWorkspace } = await import("../../src/files/useWorkspace");
  const workspace = useWorkspace();
  workspace.root.value = "";
  workspace.expanded.value = new Set();
  workspace.error.value = "";
  await workspace.refresh(); // no root: clears the cached tree, reads nothing
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the files panel", () => {
  it("offers a folder picker before anything else", async () => {
    const w = mountPanel();
    await settle();
    expect(w.get('[data-testid="files-empty"]').exists()).toBe(true);
    expect(w.find('[data-testid="files-tree"]').exists()).toBe(false);
    expect(readDir).not.toHaveBeenCalled();
  });

  it("lists the picked folder, directories first", async () => {
    tree({ [ROOT]: [["drawing.svg", false], ["notes", true]] });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    expect(w.get('[data-testid="files-row-notes"]').exists()).toBe(true);
    expect(w.get('[data-testid="files-row-drawing.svg"]').exists()).toBe(true);
    expect(workspace.rows.value.map((r) => r.name)).toEqual(["notes", "drawing.svg"]);
  });

  it("reads a folder only when it is expanded, and nests what it finds", async () => {
    // The whole reason the tree is lazy: the picked folder can be a home
    // directory, and reading all of it to draw twelve rows is a stall.
    tree({
      [ROOT]: [["notes", true]],
      [`${ROOT}/notes`]: [["talk.pxml", false]],
    });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();
    expect(readDir).toHaveBeenCalledTimes(1);
    expect(w.find('[data-testid="files-row-talk.pxml"]').exists()).toBe(false);

    await w.get('[data-testid="files-row-notes"]').trigger("click");
    await settle();
    expect(readDir).toHaveBeenCalledWith(`${ROOT}/notes`);
    const child = w.get('[data-testid="files-row-talk.pxml"]');
    expect(child.exists()).toBe(true);
    // Indented one level deeper than its folder — that is the whole tree.
    // (jsdom folds the calc: depth 1 is 1 x 0.75rem plus the 0.5rem gutter.)
    expect(child.attributes("style")).toContain("1.25rem");
    expect(w.get('[data-testid="files-row-notes"]').attributes("style")).toContain("0.5rem");
    expect(w.emitted("open")).toBeUndefined();
  });

  it("collapses without re-reading the disk", async () => {
    tree({ [ROOT]: [["notes", true]], [`${ROOT}/notes`]: [["a.svg", false]] });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-notes"]').trigger("click");
    await settle();
    const reads = readDir.mock.calls.length;
    await w.get('[data-testid="files-row-notes"]').trigger("click");
    await settle();
    expect(w.find('[data-testid="files-row-a.svg"]').exists()).toBe(false);
    await w.get('[data-testid="files-row-notes"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="files-row-a.svg"]').exists()).toBe(true);
    expect(readDir.mock.calls.length).toBe(reads);
  });

  it("hands a file to the editor its content calls for", async () => {
    tree({ [ROOT]: [["drawing.svg", false]] });
    readTextFile.mockResolvedValue(SVG);
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-drawing.svg"]').trigger("click");
    await settle();

    const opened = w.emitted("open")?.[0][0] as { kind: string; name: string };
    expect(opened.kind).toBe("sketch");
    expect(opened.name).toBe("drawing.svg");
  });

  it("does not try to open a file no editor here reads", async () => {
    tree({ [ROOT]: [["photo.png", false]] });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-photo.png"]').trigger("click");
    await settle();
    expect(readTextFile).not.toHaveBeenCalled();
    expect(w.emitted("open")).toBeUndefined();
  });

  it("filters the tree and keeps the folders that lead to a match", async () => {
    tree({
      [ROOT]: [["notes", true], ["budget.json", false]],
      [`${ROOT}/notes`]: [["talk.pxml", false]],
    });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();
    await w.get('[data-testid="files-row-notes"]').trigger("click");
    await settle();

    await w.get('[data-testid="files-filter"]').setValue("talk");
    await settle();
    expect(w.get('[data-testid="files-row-talk.pxml"]').exists()).toBe(true);
    // Kept although its own name does not match: without it the hit would sit
    // indented under nothing.
    expect(w.get('[data-testid="files-row-notes"]').exists()).toBe(true);
    expect(w.find('[data-testid="files-row-budget.json"]').exists()).toBe(false);
  });

  it("says when a filter matches nothing", async () => {
    tree({ [ROOT]: [["budget.json", false]] });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-filter"]').setValue("zzz");
    await settle();
    expect(w.get('[data-testid="files-nothing"]').text()).toBe("Nothing matches that.");
  });

  it("shows a filesystem message verbatim, not as a missing key", async () => {
    // A read error has no catalogue entry and is more useful as it came.
    readDir.mockRejectedValue(new Error("forbidden path"));
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();
    expect(w.get('[data-testid="files-error"]').text()).toBe("forbidden path");
  });

  it("asks for a folder with the grant that covers what is inside it", async () => {
    // `recursive: true` is what extends the fs grant to subfolders. Without it
    // the picked folder opens and every folder in it refuses.
    openDialog.mockResolvedValue(null);
    const w = mountPanel();
    await settle();
    await w.get('[data-testid="files-pick"]').trigger("click");
    await settle();
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, recursive: true }));
  });
});
