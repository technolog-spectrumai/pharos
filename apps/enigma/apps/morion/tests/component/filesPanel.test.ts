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
const readFile = vi.fn();
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
  readFile: (...a: unknown[]) => readFile(...a),
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
  const { useWorkspace } = await import("petalite/files");
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
  for (const fn of [invoke, readDir, stat, readTextFile, readFile, openDialog]) fn.mockReset();
  stat.mockResolvedValue({ size: 12, mtime: null });
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { useWorkspace, setSealProbe } = await import("petalite/files");
  // The store no longer imports the seal probe; `main.ts` injects it, and so
  // must a test that expects padlocks. Installed as the real `probeSealed`, so
  // these tests still assert against `is_file_locked` at the Tauri boundary
  // rather than against a stub of the app's own code.
  const { probeSealed } = await import("padova");
  setSealProbe((path) => probeSealed(path));
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
    // An .svg is a drawing: it opens in the drawing editor, as SVG.
    expect(opened.kind).toBe("sketch");
    expect(opened.name).toBe("drawing.svg");
  });

  it("opens a file no editor claims as plain text", async () => {
    // Nothing is unopenable any more. Refusing would be the app deciding a
    // file is none of the user's business, and the Code tab reads anything.
    tree({ [ROOT]: [["server.log", false]] });
    readTextFile.mockResolvedValue("started");
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-server.log"]').trigger("click");
    await settle();
    const opened = w.emitted("open")?.[0][0] as { kind: string; name: string };
    expect(opened.kind).toBe("code");
    expect(opened.name).toBe("server.log");
  });

  it("reads a picture as bytes, not as text", async () => {
    // readTextFile decodes UTF-8, and a PNG through that comes back as
    // replacement characters — a lossy copy that could be saved over the real
    // file. This is why images were unopenable before.
    tree({ [ROOT]: [["photo.png", false]] });
    readFile.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-photo.png"]').trigger("click");
    await settle();
    expect(readFile).toHaveBeenCalledWith(`${ROOT}/photo.png`);
    expect(readTextFile).not.toHaveBeenCalled();

    const opened = w.emitted("open")?.[0][0] as { kind: string; content: string };
    expect(opened.kind).toBe("code");
    expect(opened.content).toBe("data:image/png;base64,iVBORw==");
  });

  it("hands a Markdown note to the Markdown tab", async () => {
    tree({ [ROOT]: [["idea.md", false]] });
    readTextFile.mockResolvedValue("# idea");
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-idea.md"]').trigger("click");
    await settle();
    const opened = w.emitted("open")?.[0][0] as
      { kind: string; name: string; path: string; content: string };
    expect(opened.kind).toBe("markdown");
    expect(opened.name).toBe("idea.md");
    // The path travels with the bytes, so Save can write them back in place.
    expect(opened.path).toBe(`${ROOT}/idea.md`);
    expect(opened.content).toBe("# idea");
  });

  it("opens a search hit the way it opens a clicked row", async () => {
    // The hit sits in a folder the tree never expanded, so nothing was probed
    // or listed for it; the panel asks the probe, reads the file, and emits
    // the same payload a row click would.
    tree({ [ROOT]: [["deep", true]] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "workspace_search") {
        return [{ path: `${ROOT}/deep/found.md`, relPath: "deep/found.md", name: "found.md", tags: [], matched: ["text"], snippet: "the needle", score: 20, sealed: false }];
      }
      return false; // is_file_locked
    });
    readTextFile.mockResolvedValue("# found\nthe needle");
    vi.useFakeTimers();
    try {
      const workspace = await withRoot();
      const w = mountPanel();
      await settle();
      await workspace.refresh();
      await settle();

      await w.get('[data-testid="workspace-search"]').setValue("needle");
      await vi.advanceTimersByTimeAsync(250);
      await settle();
      expect(invoke).toHaveBeenCalledWith("workspace_search", { query: "needle", mode: "hybrid" });

      await w.get('[data-testid="search-result-0"]').trigger("click");
      await settle();
      expect(invoke).toHaveBeenCalledWith("is_file_locked", { path: `${ROOT}/deep/found.md` });
      expect(readTextFile).toHaveBeenCalledWith(`${ROOT}/deep/found.md`);
      const opened = w.emitted("open")?.[0][0] as
        { kind: string; name: string; path: string; content: string };
      expect(opened.kind).toBe("markdown");
      expect(opened.name).toBe("found.md");
      expect(opened.path).toBe(`${ROOT}/deep/found.md`);
      expect(opened.content).toBe("# found\nthe needle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a sealed search hit to the passphrase flow exactly as it does a sealed row", async () => {
    tree({ [ROOT]: [] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "workspace_search") {
        return [{ path: `${ROOT}/vault.md`, relPath: "vault.md", name: "vault.md", tags: [], matched: ["name"], snippet: "", score: 100, sealed: true }];
      }
      return true; // is_file_locked
    });
    vi.useFakeTimers();
    try {
      const workspace = await withRoot();
      const w = mountPanel();
      await settle();
      await workspace.refresh();
      await settle();

      await w.get('[data-testid="workspace-search"]').setValue("vault");
      await vi.advanceTimersByTimeAsync(250);
      await settle();
      await w.get('[data-testid="search-result-0"]').trigger("click");
      await settle();
      expect(readTextFile).not.toHaveBeenCalled();
      expect(w.emitted("open")).toBeUndefined();
      expect(w.emitted("open-sealed")?.[0][0]).toEqual({ name: "vault.md", path: `${ROOT}/vault.md` });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands a sealed Markdown note to the passphrase flow without reading it", async () => {
    // Markdown changed nothing about locking: a sealed .md is badged by the
    // same probe, never read here, and opened through the host's passphrase.
    tree({ [ROOT]: [["secret.md", false]] });
    invoke.mockImplementation(async (cmd: string) => cmd === "is_file_locked");
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-secret.md"]').trigger("click");
    await settle();
    expect(readTextFile).not.toHaveBeenCalled();
    expect(w.emitted("open")).toBeUndefined();
    expect(w.emitted("open-sealed")?.[0][0]).toEqual({ name: "secret.md", path: `${ROOT}/secret.md` });
    expect(w.find('[data-testid="files-open-error"]').exists()).toBe(false);
  });

  it("offers a shield on every file row: encrypt a plain one, decrypt a sealed one", async () => {
    tree({ [ROOT]: [["plain.pdf", false], ["vault.md", false]] });
    invoke.mockImplementation(async (cmd: string, args: { path?: string }) => {
      if (cmd === "is_file_locked") return args.path === `${ROOT}/vault.md`;
      if (cmd === "secret_status") return { remembered: false, storage: null };
      if (cmd === "lock_file" || cmd === "unlock_file") return { name: "x", size: 1 };
      return null;
    });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    // A PDF is not something an editor here opens, and it can still be encrypted.
    expect(w.get('[data-testid="row-shield-plain.pdf"]').attributes("title")).toBe("Encrypt this file");
    await w.get('[data-testid="row-shield-plain.pdf"]').trigger("click");
    await settle();
    // The click did not open the row.
    expect(w.emitted("open")).toBeUndefined();
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-confirm"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("lock_file", { path: `${ROOT}/plain.pdf`, password: "pw" });
    // …and the row was asked again, so the padlock follows the disk.
    expect(invoke.mock.calls.filter(([c, a]) => c === "is_file_locked" && (a as { path: string }).path === `${ROOT}/plain.pdf`).length)
      .toBeGreaterThan(1);

    expect(w.get('[data-testid="row-shield-vault.md"]').attributes("title")).toBe("Decrypt this file permanently");
    await w.get('[data-testid="row-shield-vault.md"]').trigger("click");
    await settle();
    expect(w.find('[data-testid="lock-confirm"]').exists()).toBe(false); // decrypting asks once
    expect(w.get('[data-testid="lock-unlock-hint"]').text()).toContain("plain text on disk");
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("unlock_file", { path: `${ROOT}/vault.md`, password: "pw" });
  });

  it("puts a shield on every folder row that opens the folder modal, not the folder", async () => {
    tree({ [ROOT]: [["notes", true]], [`${ROOT}/notes`]: [["a.md", false]] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: false, storage: null };
      if (cmd === "folder_preview") return { files: 1, plain: 1, sealed: 0, links: 0, truncated: false };
      return false;
    });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="folder-shield-notes"]').trigger("click");
    await settle();
    // The folder did not expand; the modal opened for it.
    expect(readDir).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("folder_preview", { dir: `${ROOT}/notes` });
    expect(w.get('[data-testid="folder-preview"]').text()).toContain("1 files here");
  });

  it("says why a file would not open, in words", async () => {
    tree({ [ROOT]: [["data.bin", false]] });
    readTextFile.mockRejectedValue("not_text: that file is not a text file");
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();
    await w.get('[data-testid="files-row-data.bin"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="files-open-error"]').text()).toBe("That file is not a text file.");
  });

  it("never reads a sealed file itself, whatever its kind", async () => {
    tree({ [ROOT]: [["secret.log", false]] });
    invoke.mockImplementation(async (cmd: string) => cmd === "is_file_locked");
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-secret.log"]').trigger("click");
    await settle();
    expect(readTextFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(w.emitted("open")).toBeUndefined();
    expect(w.emitted("open-sealed")).toHaveLength(1);
  });

  it("stands search results where the tree was while a query is typed, and brings the tree back", async () => {
    tree({ [ROOT]: [["notes", true], ["budget.json", false]] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "workspace_search") {
        return [{ path: `${ROOT}/notes/deep/talk.pxml`, relPath: "notes/deep/talk.pxml", name: "talk.pxml",
                  tags: [], matched: ["name"], snippet: "", score: 80, sealed: false }];
      }
      return false;
    });
    vi.useFakeTimers();
    try {
      const workspace = await withRoot();
      const w = mountPanel();
      await settle();
      await workspace.refresh();
      await settle();
      expect(w.get('[data-testid="files-tree"]').isVisible()).toBe(true);

      await w.get('[data-testid="workspace-search"]').setValue("talk");
      await vi.advanceTimersByTimeAsync(250);
      await settle();
      // Whole-workspace results, including a folder nobody expanded…
      expect(w.get('[data-testid="search-result-0"]').text()).toContain("notes/deep/talk.pxml");
      // …in place of the tree, not above it.
      expect((w.get('[data-testid="files-tree"]').element as HTMLElement).style.display).toBe("none");

      await w.get('[data-testid="workspace-search"]').setValue("");
      await settle();
      expect((w.get('[data-testid="files-tree"]').element as HTMLElement).style.display).not.toBe("none");
      expect(w.get('[data-testid="files-row-budget.json"]').exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says there is no workspace before one is chosen", async () => {
    const w = mountPanel();
    await settle();
    expect(w.get('[data-testid="files-empty"]').text()).toContain("No workspace yet.");
    expect(w.find('[data-testid="files-unreadable"]').exists()).toBe(false);
  });

  it("offers the picker when the remembered folder cannot be read", async () => {
    // The read grant lives in the running process, so this is what every cold
    // start looks like until the folder is picked again. It used to render the
    // raw Rust string over an empty listing, which reads as a broken app.
    readDir.mockRejectedValue(new Error(
      "forbidden path: /home/u/work, maybe it is not allowed on the scope for "
      + "`allow-read-dir` permission in your capability file"));
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    expect(workspace.unreadable.value).toBe(true);
    expect(w.get('[data-testid="files-unreadable"]').text()).toBe("Can\u2019t read this folder.");
    const empty = w.get('[data-testid="files-empty"]');
    expect(empty.text()).toContain("/home/u/work");
    expect(empty.text()).toContain("Choose it again");
    expect(w.get('[data-testid="files-pick"]').exists()).toBe(true);
    // No raw Rust anywhere on screen, and no listing pretending to be one.
    expect(w.html()).not.toContain("capability file");
    expect(w.find('[data-testid="files-tree"]').exists()).toBe(false);
    // Nor a refresh button, which could only fail the same way.
    expect(w.find('[data-testid="files-refresh"]').exists()).toBe(false);
  });

  it("keeps showing the tree when only a SUBFOLDER fails", async () => {
    // A folder that lost its permissions is not a broken workspace: the root
    // still reads, so the tree stays and only that row goes.
    tree({ [ROOT]: [["notes", true], ["a.svg", false]] });
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    readDir.mockRejectedValueOnce(new Error("EACCES"));
    await w.get('[data-testid="files-row-notes"]').trigger("click");
    await settle();
    expect(workspace.unreadable.value).toBe(false);
    expect(w.get('[data-testid="files-tree"]').exists()).toBe(true);
    expect(w.get('[data-testid="files-error"]').text()).toBe("EACCES");
    expect(workspace.isExpanded(`${ROOT}/notes`)).toBe(false);
  });

  it("says so when there is no folder picker to open", async () => {
    // The browser build has no dialog. pickRoot reports it through the store,
    // and the no-folder branch is the only one that can show it — it could not
    // before, so the button did nothing at all.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const w = mountPanel();
    await settle();
    await w.get('[data-testid="files-pick"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="files-pick-error"]').text()).toBe("This needs the desktop app.");
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

  it("asks which files are sealed, once per file, after a listing", async () => {
    // The invariant the badge rests on: read() is the only thing that adds
    // rows, so it is the only place the probe can live without leaving a hole.
    tree({ [ROOT]: [["a.svg", false], ["b.txt", false], ["notes", true]] });
    invoke.mockResolvedValue(false);
    const workspace = await withRoot();
    mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    const probed = invoke.mock.calls
      .filter(([cmd]) => cmd === "is_file_locked")
      .map(([, args]) => (args as { path: string }).path);
    // Files only — a directory is never probed.
    expect(probed.sort()).toEqual([`${ROOT}/a.svg`, `${ROOT}/b.txt`]);
  });

  it("probes a subfolder's files when it is expanded", async () => {
    tree({
      [ROOT]: [["notes", true]],
      [`${ROOT}/notes`]: [["deep.svg", false]],
    });
    invoke.mockResolvedValue(false);
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="files-row-notes"]').trigger("click");
    await settle();
    const probed = invoke.mock.calls
      .filter(([cmd]) => cmd === "is_file_locked")
      .map(([, args]) => (args as { path: string }).path);
    expect(probed).toContain(`${ROOT}/notes/deep.svg`);
  });

  it("badges a sealed file and sends it to the passphrase flow rather than an editor", async () => {
    tree({ [ROOT]: [["secret.svg", false]] });
    invoke.mockImplementation(async (cmd: string) => cmd === "is_file_locked");
    const workspace = await withRoot();
    const w = mountPanel();
    await settle();
    await workspace.refresh();
    await settle();

    const row = w.get('[data-testid="files-row-secret.svg"]');
    expect(row.html()).toContain('icon="lock"');

    await row.trigger("click");
    await settle();
    // Encrypted, so nothing was read and nothing was handed to an editor as
    // ciphertext: the host is asked to open it through the passphrase.
    expect(readTextFile).not.toHaveBeenCalled();
    expect(w.emitted("open")).toBeUndefined();
    expect(w.emitted("open-sealed")?.[0][0]).toEqual({ name: "secret.svg", path: `${ROOT}/secret.svg` });
    expect(row.html()).toContain("opens with a passphrase");
  });

  it("does not probe at all in a browser build", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    tree({ [ROOT]: [["a.svg", false]] });
    const workspace = await withRoot();
    mountPanel();
    await settle();
    await workspace.refresh();
    await settle();
    expect(invoke).not.toHaveBeenCalled();
  });
});