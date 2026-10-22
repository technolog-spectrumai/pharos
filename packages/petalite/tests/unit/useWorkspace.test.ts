// The workspace store: one folder, browsed as a lazily-loaded tree.
//
// The store is module-level — every app panel sees the same folder — so each
// test re-imports it into a fresh module graph rather than trusting a reset
// to cover every field. That also puts the import itself under test, which is
// where the remembered folder and the recent list are read.
//
// It runs in node. The store needs a `window` only to ask whether it is on the
// desktop, and a `localStorage` only for two keys; both are stubbed here, so
// what is tested is the store's own logic and the calls it makes to the Tauri
// plugins, which are mocked the way the apps' suites mock them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, FileBackend } from "../../src/files/useWorkspace";

const fsPlugin = vi.hoisted(() => ({
  readDir: vi.fn(),
  stat: vi.fn(),
  readTextFile: vi.fn(),
  readFile: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => fsPlugin);
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

const ROOT_KEY = "zinnia:workspace";
const RECENT_KEY = "zinnia:workspaces:recent";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

let storage: ReturnType<typeof memoryStorage>;

/** The desktop is detected by Tauri's injected global, and nothing else. */
function onDesktop() {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
}

/** A folder tree for the fs plugin to read. A name ending in "/" is a folder;
 *  a directory missing from the map is one that cannot be read. */
function disk(tree: Record<string, string[]>) {
  fsPlugin.readDir.mockImplementation(async (dir: string) => {
    const names = tree[dir];
    if (!names) throw new Error(`No such file or directory: ${dir}`);
    return names.map((n) => ({
      name: n.replace(/\/$/, ""),
      isDirectory: n.endsWith("/"),
      isFile: !n.endsWith("/"),
      isSymlink: false,
    }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Probes are fire-and-forget; one turn of the event loop lets every answer
 *  already given land. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function load() {
  vi.resetModules();
  return import("../../src/files");
}

/** A fresh store, on the desktop, with nothing remembered. */
async function workspace() {
  const mod = await load();
  return { ...mod, ws: mod.useWorkspace() };
}

const shape = (rows: { name: string; depth: number }[]) => rows.map((r) => `${"  ".repeat(r.depth)}${r.name}`);

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  onDesktop();
  for (const fn of [...Object.values(fsPlugin), dialog.open]) fn.mockReset();
  fsPlugin.stat.mockResolvedValue({ size: 1, mtime: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the remembered folder", () => {
  it("starts in the folder remembered from the last run", async () => {
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/home/me/work" }));
    const { ws } = await workspace();
    expect(ws.root.value).toBe("/home/me/work");
  });

  it.each([
    ["text that is not JSON", "{oops"],
    ["a record with no root", JSON.stringify({})],
    ["a root that is not a string", JSON.stringify({ root: 42 })],
    ["a JSON null", "null"],
  ])("starts with no folder for %s, rather than failing to load", async (_label, stored) => {
    storage.data.set(ROOT_KEY, stored);
    const { ws } = await workspace();
    expect(ws.root.value).toBe("");
  });

  it("starts with no folder and no recent list when storage cannot be read", async () => {
    // A blocked store throws on access. The panel must still load — with the
    // picker, which is what a first run shows anyway.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: storage is disabled");
      },
    });
    const { ws } = await workspace();
    expect(ws.root.value).toBe("");
    expect(ws.recent.value).toEqual([]);
  });

  it("reads back the recent list, dropping anything that is not a path", async () => {
    storage.data.set(RECENT_KEY, JSON.stringify(["/a", 3, null, "/b", { path: "/c" }]));
    const { ws } = await workspace();
    expect(ws.recent.value).toEqual(["/a", "/b"]);
  });

  it.each([
    ["an object", JSON.stringify({ "/a": true })],
    ["text that is not JSON", "[/a"],
  ])("reads a recent list stored as %s as empty", async (_label, stored) => {
    storage.data.set(RECENT_KEY, stored);
    const { ws } = await workspace();
    expect(ws.recent.value).toEqual([]);
  });
});

describe("choosing a folder", () => {
  it("refuses off the desktop with a message key, and opens no dialog", async () => {
    vi.stubGlobal("window", undefined);
    const { ws } = await workspace();

    await ws.pickRoot();

    expect(ws.error.value).toBe("files.desktopOnly");
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it("asks for one folder with the grant extended to its subfolders, then reads it", async () => {
    // Without `recursive`, the plugin grant covers the folder and not what is
    // inside it, and the first expanded sub-folder fails to read.
    disk({ "/home/me/work": ["notes/", "a.md"] });
    dialog.open.mockResolvedValue("/home/me/work");
    const { ws } = await workspace();

    await ws.pickRoot();

    expect(dialog.open).toHaveBeenCalledWith({ directory: true, multiple: false, recursive: true });
    expect(ws.root.value).toBe("/home/me/work");
    expect(shape(ws.rows.value)).toEqual(["notes", "a.md"]);
    expect(JSON.parse(storage.data.get(ROOT_KEY)!)).toEqual({ root: "/home/me/work" });
    expect(ws.recent.value).toEqual(["/home/me/work"]);
  });

  it("keeps the current folder when the dialog is cancelled, and drops the old complaint", async () => {
    // They opened the picker to change the folder that was complaining. The
    // complaint is about to be re-tested or is no longer the subject.
    disk({});
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/gone" }));
    const { ws } = await workspace();
    await ws.refresh();
    expect(ws.error.value).not.toBe("");

    dialog.open.mockResolvedValue(null);
    await ws.pickRoot();

    expect(ws.root.value).toBe("/gone");
    expect(ws.error.value).toBe("");
  });

  it("starts the new folder from nothing: nothing open, nothing cached", async () => {
    disk({ "/a": ["sub/"], "/a/sub": ["deep.md"], "/b": ["b.md"] });
    const { ws } = await workspace();
    await ws.switchRoot("/a");
    await ws.toggle("/a/sub");
    expect(shape(ws.rows.value)).toEqual(["sub", "  deep.md"]);

    await ws.switchRoot("/b");
    expect(shape(ws.rows.value)).toEqual(["b.md"]);
    expect(ws.isExpanded("/a/sub")).toBe(false);

    // Coming back reads the folder again rather than trusting an old listing.
    fsPlugin.readDir.mockClear();
    await ws.switchRoot("/a");
    expect(shape(ws.rows.value)).toEqual(["sub"]);
    expect(fsPlugin.readDir.mock.calls).toEqual([["/a"]]);
  });

  it("keeps the six most recent folders, newest first, without repeats", async () => {
    const folders = ["/1", "/2", "/3", "/4", "/5", "/6", "/7"];
    disk(Object.fromEntries(folders.map((f) => [f, []])));
    const { ws } = await workspace();

    for (const folder of folders) await ws.switchRoot(folder);
    expect(ws.recent.value).toEqual(["/7", "/6", "/5", "/4", "/3", "/2"]);

    await ws.switchRoot("/3");
    expect(ws.recent.value).toEqual(["/3", "/7", "/6", "/5", "/4", "/2"]);
    expect(JSON.parse(storage.data.get(RECENT_KEY)!)).toEqual(ws.recent.value);
  });

  it("still switches when storage refuses to remember", async () => {
    // A full or blocked store costs the next launch its memory; it must not
    // cost this session its folder.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    disk({ "/w": ["a.md"] });
    const { ws } = await workspace();

    expect(await ws.switchRoot("/w")).toBe(true);
    expect(ws.root.value).toBe("/w");
    expect(ws.recent.value).toEqual(["/w"]);
    expect(shape(ws.rows.value)).toEqual(["a.md"]);
  });
});

describe("reading the tree", () => {
  it("lists folders first, then files, each alphabetically", async () => {
    disk({ "/w": ["b.md", "zeta/", "a.md", "docs/"] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");
    expect(shape(ws.rows.value)).toEqual(["docs", "zeta", "a.md", "b.md"]);
  });

  it("gives each row the size and date its own stat reports", async () => {
    // The plugin's directory entry carries a name and nothing else.
    disk({ "/w": ["a.md", "new.md"] });
    const stamp = new Date("2024-01-02T03:04:05Z");
    fsPlugin.stat.mockImplementation(async (path: string) =>
      path === "/w/a.md" ? { size: 2048, mtime: stamp } : { size: 0, mtime: null },
    );
    const { ws } = await workspace();
    await ws.switchRoot("/w");

    expect(fsPlugin.stat).toHaveBeenCalledWith("/w/a.md");
    expect(ws.rows.value).toEqual([
      { name: "a.md", path: "/w/a.md", isDirectory: false, size: 2048, modified: stamp.getTime(), depth: 0 },
      { name: "new.md", path: "/w/new.md", isDirectory: false, size: 0, modified: undefined, depth: 0 },
    ]);
  });

  it("keeps a row whose stat fails, just without a size or date", async () => {
    // One unreadable file must not blank the whole listing.
    disk({ "/w": ["locked.md", "open.md"] });
    fsPlugin.stat.mockImplementation(async (path: string) => {
      if (path === "/w/locked.md") throw new Error("Permission denied");
      return { size: 5, mtime: null };
    });
    const { ws } = await workspace();
    await ws.switchRoot("/w");

    const [locked, open] = ws.rows.value;
    expect(locked).toMatchObject({ name: "locked.md", path: "/w/locked.md" });
    expect(locked.size).toBeUndefined();
    expect(locked.modified).toBeUndefined();
    expect(open.size).toBe(5);
    expect(ws.error.value).toBe("");
  });

  it("joins names onto the filesystem root without doubling the separator", async () => {
    disk({ "/": ["etc/"], "/etc": ["hosts"] });
    const { ws } = await workspace();
    await ws.switchRoot("/");
    await ws.toggle("/etc");

    expect(ws.rows.value.map((r) => r.path)).toEqual(["/etc", "/etc/hosts"]);
  });

  it("reads nothing off the desktop, keeping the remembered folder for later", async () => {
    vi.stubGlobal("window", {});
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/w" }));
    const { ws } = await workspace();

    await ws.refresh();

    expect(fsPlugin.readDir).not.toHaveBeenCalled();
    expect(ws.root.value).toBe("/w");
    expect(ws.rows.value).toEqual([]);
    expect(ws.loading.value).toBe(false);
  });

  it("reads nothing when no folder has been chosen", async () => {
    const { ws } = await workspace();
    await ws.refresh();
    expect(fsPlugin.readDir).not.toHaveBeenCalled();
    expect(ws.rows.value).toEqual([]);
  });

  it("is loading exactly while the root is being read", async () => {
    const listing = deferred<unknown[]>();
    fsPlugin.readDir.mockReturnValue(listing.promise);
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/w" }));
    const { ws } = await workspace();

    const pending = ws.refresh();
    expect(ws.loading.value).toBe(true);

    listing.resolve([{ name: "a.md", isDirectory: false }]);
    await pending;
    expect(ws.loading.value).toBe(false);
    expect(shape(ws.rows.value)).toEqual(["a.md"]);
  });

  it("treats a root it cannot read as a state, not as a stale listing", async () => {
    // After a restart the plugin grant is gone. The tree on screen belongs to
    // a folder this run cannot read; showing it would invite clicking a row
    // that cannot open.
    disk({ "/w": ["sub/", "a.md"], "/w/sub": [] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");
    await ws.toggle("/w/sub");

    disk({});
    await ws.refresh();

    expect(ws.unreadable.value).toBe(true);
    expect(ws.error.value).toBe("No such file or directory: /w");
    expect(ws.rows.value).toEqual([]);
    expect(ws.isExpanded("/w/sub")).toBe(false);
    expect(ws.loading.value).toBe(false);
  });

  it("recovers once the root can be read again", async () => {
    disk({});
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/w" }));
    const { ws } = await workspace();
    await ws.refresh();
    expect(ws.unreadable.value).toBe(true);

    disk({ "/w": ["a.md"] });
    await ws.refresh();

    expect(ws.unreadable.value).toBe(false);
    expect(ws.error.value).toBe("");
    expect(shape(ws.rows.value)).toEqual(["a.md"]);
  });

  it("reports a rejection that is not an Error as its own text", async () => {
    // Tauri rejects with plain strings; `.message` of a string is undefined.
    fsPlugin.readDir.mockRejectedValue("forbidden path: /w");
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/w" }));
    const { ws } = await workspace();

    await ws.refresh();

    expect(ws.error.value).toBe("forbidden path: /w");
  });
});

describe("opening folders", () => {
  it("reads a folder the first time it opens, and nests its rows one level deeper", async () => {
    disk({ "/w": ["notes/", "z.md"], "/w/notes": ["deep/", "talk.md"], "/w/notes/deep": ["x.md"] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");

    await ws.toggle("/w/notes");
    await ws.toggle("/w/notes/deep");

    expect(shape(ws.rows.value)).toEqual(["notes", "  deep", "    x.md", "  talk.md", "z.md"]);
    expect(ws.isExpanded("/w/notes")).toBe(true);
  });

  it("closes without reading, and reopens from what it read the first time", async () => {
    // Only the refresh button says "read this again". A click that only
    // changes what is on screen must never wait on a disk.
    disk({ "/w": ["notes/"], "/w/notes": ["a.md"] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");

    await ws.toggle("/w/notes");
    await ws.toggle("/w/notes");
    expect(shape(ws.rows.value)).toEqual(["notes"]);
    await ws.toggle("/w/notes");

    expect(shape(ws.rows.value)).toEqual(["notes", "  a.md"]);
    expect(fsPlugin.readDir.mock.calls.filter(([dir]) => dir === "/w/notes")).toHaveLength(1);
  });

  it("reports a folder that will not open, and leaves it closed", async () => {
    disk({ "/w": ["private/", "a.md"] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");

    await ws.toggle("/w/private");

    expect(ws.error.value).toBe("No such file or directory: /w/private");
    expect(ws.isExpanded("/w/private")).toBe(false);
    expect(shape(ws.rows.value)).toEqual(["private", "a.md"]);
    // A sub-folder failing is not the whole tree being unavailable.
    expect(ws.unreadable.value).toBe(false);
  });

  it("clears an earlier complaint when the next folder opens", async () => {
    disk({ "/w": ["private/", "notes/"], "/w/notes": [] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");
    await ws.toggle("/w/private");
    expect(ws.error.value).not.toBe("");

    await ws.toggle("/w/notes");

    expect(ws.error.value).toBe("");
  });

  it("remembers which inner folders were open across closing their parent", async () => {
    // Open state is kept by path, so closing `notes` hides `deep` without
    // forgetting it was open.
    disk({ "/w": ["notes/"], "/w/notes": ["deep/"], "/w/notes/deep": ["x.md"] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");
    await ws.toggle("/w/notes");
    await ws.toggle("/w/notes/deep");

    await ws.toggle("/w/notes");
    expect(shape(ws.rows.value)).toEqual(["notes"]);

    await ws.toggle("/w/notes");
    expect(shape(ws.rows.value)).toEqual(["notes", "  deep", "    x.md"]);
  });

  it("draws a folder that leads back to its own ancestor once, rather than forever", async () => {
    // A backend that canonicalises paths answers a symlink to an ancestor
    // with the ancestor's own path. Opening it must render short, not walk
    // until the stack gives out.
    const { ws, setFileBackend } = await workspace();
    const tree: Record<string, Entry[]> = {
      "/r": [
        { name: "a", path: "/r/a", isDirectory: true },
        { name: "x.txt", path: "/r/x.txt", isDirectory: false },
      ],
      "/r/a": [{ name: "up", path: "/r", isDirectory: true }],
    };
    setFileBackend({
      list: async (dir) => tree[dir] ?? [],
      readText: async () => "",
      readBytes: async () => new Uint8Array(),
    });
    await ws.switchRoot("/r");
    await ws.toggle("/r/a");
    await ws.toggle("/r");

    expect(shape(ws.rows.value)).toEqual(["a", "  up", "x.txt"]);
  });
});

describe("refreshing", () => {
  it("re-reads the root and every open folder, shallowest first", async () => {
    // Opened deep-first here: `notes` was closed and reopened after `deep`.
    disk({ "/w": ["notes/"], "/w/notes": ["deep/"], "/w/notes/deep": [] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");
    await ws.toggle("/w/notes");
    await ws.toggle("/w/notes/deep");
    await ws.toggle("/w/notes");
    await ws.toggle("/w/notes");

    fsPlugin.readDir.mockClear();
    await ws.refresh();

    expect(fsPlugin.readDir.mock.calls).toEqual([["/w"], ["/w/notes"], ["/w/notes/deep"]]);
  });

  it("shows what changed on disk since the last read", async () => {
    disk({ "/w": ["notes/"], "/w/notes": ["old.md"] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");
    await ws.toggle("/w/notes");

    disk({ "/w": ["notes/", "added.md"], "/w/notes": ["old.md", "fresh.md"] });
    await ws.refresh();

    expect(shape(ws.rows.value)).toEqual(["notes", "  fresh.md", "  old.md", "added.md"]);
  });

  it("forgets an open folder that has gone, without complaining about it", async () => {
    // Its parent has just been re-read without it, so the tree is already
    // consistent; an error would report a problem nobody can act on.
    disk({ "/w": ["notes/", "keep/"], "/w/notes": [], "/w/keep": ["k.md"] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");
    await ws.toggle("/w/notes");
    await ws.toggle("/w/keep");

    disk({ "/w": ["keep/"], "/w/keep": ["k.md"] });
    await ws.refresh();

    expect(ws.isExpanded("/w/notes")).toBe(false);
    expect(ws.isExpanded("/w/keep")).toBe(true);
    expect(shape(ws.rows.value)).toEqual(["keep", "  k.md"]);
    expect(ws.error.value).toBe("");
    expect(ws.unreadable.value).toBe(false);
  });
});

describe("sealed files", () => {
  it("draws the listing first, then badges the files the probe answers for", async () => {
    // The names are what the panel draws; waiting on one round trip per file
    // for a padlock would trade the tree for the badge.
    disk({ "/w": ["sub/", "a.md", "b.md"] });
    const answers = new Map<string, ReturnType<typeof deferred<boolean>>>();
    const probe = vi.fn((path: string) => {
      const answer = deferred<boolean>();
      answers.set(path, answer);
      return answer.promise;
    });
    const { ws, setSealProbe } = await workspace();
    setSealProbe(probe);

    await ws.switchRoot("/w");
    expect(shape(ws.rows.value)).toEqual(["sub", "a.md", "b.md"]);
    expect(ws.isSealed("/w/a.md")).toBe(false);
    // Files are asked about; folders never are.
    expect(probe.mock.calls).toEqual([["/w/a.md"], ["/w/b.md"]]);

    answers.get("/w/a.md")!.resolve(true);
    answers.get("/w/b.md")!.resolve(false);
    await settle();

    expect(ws.isSealed("/w/a.md")).toBe(true);
    expect(ws.isSealed("/w/b.md")).toBe(false);
  });

  it("takes a listing's own answer, and asks the probe only about the rest", async () => {
    const { ws, setSealProbe, setFileBackend } = await workspace();
    const probe = vi.fn(async () => true);
    setSealProbe(probe);
    setFileBackend({
      list: async () => [
        { name: "known-yes.md", path: "/w/known-yes.md", isDirectory: false, sealed: true },
        { name: "known-no.md", path: "/w/known-no.md", isDirectory: false, sealed: false },
        { name: "unknown.md", path: "/w/unknown.md", isDirectory: false },
      ],
      readText: async () => "",
      readBytes: async () => new Uint8Array(),
    });

    await ws.switchRoot("/w");
    await settle();

    expect(probe.mock.calls).toEqual([["/w/unknown.md"]]);
    expect(ws.isSealed("/w/known-yes.md")).toBe(true);
    expect(ws.isSealed("/w/known-no.md")).toBe(false);
    expect(ws.isSealed("/w/unknown.md")).toBe(true);
  });

  it("counts a file whose probe rejects as unsealed, and still badges the rest", async () => {
    disk({ "/w": ["bad.md", "good.md"] });
    const { ws, setSealProbe } = await workspace();
    setSealProbe(async (path) => {
      if (path === "/w/bad.md") throw new Error("no such command");
      return true;
    });

    await ws.switchRoot("/w");
    await settle();

    expect(ws.isSealed("/w/bad.md")).toBe(false);
    expect(ws.isSealed("/w/good.md")).toBe(true);
    expect(shape(ws.rows.value)).toEqual(["bad.md", "good.md"]);
  });

  it("keeps a badge through a refresh until the new answer lands", async () => {
    // Badges are never cleared by a refresh: a padlock that blinks off and on
    // for every refresh would be noise, and the answer rarely changes.
    disk({ "/w": ["a.md"] });
    const { ws, setSealProbe } = await workspace();
    setSealProbe(async () => true);
    await ws.switchRoot("/w");
    await settle();
    expect(ws.isSealed("/w/a.md")).toBe(true);

    const later = deferred<boolean>();
    setSealProbe(() => later.promise);
    await ws.refresh();
    expect(ws.isSealed("/w/a.md")).toBe(true);

    later.resolve(false);
    await settle();
    expect(ws.isSealed("/w/a.md")).toBe(false);
  });

  it("forgets every badge when the folder changes", async () => {
    disk({ "/w": ["a.md"], "/v": [] });
    const { ws, setSealProbe } = await workspace();
    setSealProbe(async () => true);
    await ws.switchRoot("/w");
    await settle();
    expect(ws.isSealed("/w/a.md")).toBe(true);

    await ws.switchRoot("/v");

    expect(ws.isSealed("/w/a.md")).toBe(false);
    expect(ws.sealed.value.size).toBe(0);
  });

  it("re-probes one file on request, without re-reading any folder", async () => {
    // What the Security tab calls after sealing a file.
    disk({ "/w": ["a.md"] });
    const { ws, setSealProbe } = await workspace();
    let sealedNow = false;
    const probe = vi.fn(async () => sealedNow);
    setSealProbe(probe);
    await ws.switchRoot("/w");
    await settle();
    expect(ws.isSealed("/w/a.md")).toBe(false);

    sealedNow = true;
    probe.mockClear();
    fsPlugin.readDir.mockClear();
    await ws.reprobe("/w/a.md");

    expect(probe.mock.calls).toEqual([["/w/a.md"]]);
    expect(fsPlugin.readDir).not.toHaveBeenCalled();
    expect(ws.isSealed("/w/a.md")).toBe(true);
  });

  it("badges nothing, and re-probes to nothing, when the app offers no sealing", async () => {
    disk({ "/w": ["a.md"] });
    const { ws } = await workspace();
    await ws.switchRoot("/w");
    await settle();

    await expect(ws.reprobe("/w/a.md")).resolves.toBeUndefined();
    expect(ws.isSealed("/w/a.md")).toBe(false);
    expect(ws.sealed.value.size).toBe(0);
  });
});

describe("forgetting the folder", () => {
  it("drops the folder, its tree, its badges and any complaint, but keeps the recent list", async () => {
    // Recent folders are how they get back; forgetting the current one is
    // not a request to forget where they have been.
    disk({ "/w": ["sub/", "a.md"], "/w/sub": [] });
    const { ws, setSealProbe } = await workspace();
    setSealProbe(async () => true);
    await ws.switchRoot("/w");
    await ws.toggle("/w/sub");
    await settle();
    ws.error.value = "something earlier";

    ws.clearRoot();

    expect(ws.root.value).toBe("");
    expect(ws.rows.value).toEqual([]);
    expect(ws.isExpanded("/w/sub")).toBe(false);
    expect(ws.isSealed("/w/a.md")).toBe(false);
    expect(ws.error.value).toBe("");
    expect(ws.unreadable.value).toBe(false);
    expect(storage.data.has(ROOT_KEY)).toBe(false);
    expect(ws.recent.value).toEqual(["/w"]);
  });

  it("lifts the unreadable state, so the panel stops offering to re-pick a folder it no longer has", async () => {
    disk({});
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/gone" }));
    const { ws } = await workspace();
    await ws.refresh();
    expect(ws.unreadable.value).toBe(true);

    ws.clearRoot();

    expect(ws.unreadable.value).toBe(false);
  });

  it("forgets the folder even when storage is blocked", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ root: "/w" }),
      setItem: () => {},
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    const { ws } = await workspace();
    expect(ws.root.value).toBe("/w");

    expect(() => ws.clearRoot()).not.toThrow();
    expect(ws.root.value).toBe("");
  });
});

describe("reading a file", () => {
  const entry = (name: string): Entry => ({ name, path: `/w/${name}`, isDirectory: false });

  it("reads text through the fs plugin, by the entry's path", async () => {
    fsPlugin.readTextFile.mockResolvedValue("# notes");
    const { ws } = await workspace();

    expect(await ws.readText(entry("notes.md"))).toBe("# notes");
    expect(fsPlugin.readTextFile).toHaveBeenCalledWith("/w/notes.md");
  });

  it("reads a picture as bytes, never as text, and hands back a data URI", async () => {
    // Text decoding turns a PNG into replacement characters — a lossy copy
    // that could then be saved over the real file.
    fsPlugin.readFile.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    const { ws } = await workspace();

    expect(await ws.readImage(entry("photo.png"))).toBe("data:image/png;base64,iVBORw==");
    expect(fsPlugin.readFile).toHaveBeenCalledWith("/w/photo.png");
    expect(fsPlugin.readTextFile).not.toHaveBeenCalled();
  });
});

describe("a backend of the app's own", () => {
  function backend(tree: Record<string, Entry[]>, canonical: Record<string, string> = {}) {
    return {
      open: vi.fn(async (root: string) => {
        const answer = canonical[root] ?? root;
        if (answer === "REFUSE") throw new Error(`cannot open ${root}`);
        return answer;
      }),
      list: vi.fn(async (dir: string) => {
        const rows = tree[dir];
        if (!rows) throw new Error(`gone: ${dir}`);
        return rows.map((r) => ({ ...r }));
      }),
      readText: vi.fn(async (path: string) => `text of ${path}`),
      readBytes: vi.fn(async () => new Uint8Array([71, 73, 70])),
    } satisfies FileBackend;
  }

  it("is used for every read, and the fs plugin never is", async () => {
    const b = backend({ "/w": [{ name: "a.md", path: "/w/a.md", isDirectory: false }] });
    const { ws, setFileBackend } = await workspace();
    setFileBackend(b);

    await ws.switchRoot("/w");
    const text = await ws.readText(ws.rows.value[0]);
    const image = await ws.readImage({ name: "a.gif", path: "/w/a.gif", isDirectory: false });

    expect(text).toBe("text of /w/a.md");
    expect(image).toBe("data:image/gif;base64,R0lG");
    expect(b.list).toHaveBeenCalledWith("/w");
    expect(b.readBytes).toHaveBeenCalledWith("/w/a.gif");
    expect(fsPlugin.readDir).not.toHaveBeenCalled();
    expect(fsPlugin.readTextFile).not.toHaveBeenCalled();
    expect(fsPlugin.readFile).not.toHaveBeenCalled();
  });

  it("reopens the remembered folder on the first refresh, once, in its canonical spelling", async () => {
    // How a remembered workspace comes back after a restart without a dialog.
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/link/w" }));
    const b = backend({ "/real/w": [{ name: "a.md", path: "/real/w/a.md", isDirectory: false }] }, {
      "/link/w": "/real/w",
    });
    const { ws, setFileBackend } = await workspace();
    setFileBackend(b);

    await ws.refresh();
    await ws.refresh();

    expect(b.open.mock.calls).toEqual([["/link/w"]]);
    expect(ws.root.value).toBe("/real/w");
    expect(JSON.parse(storage.data.get(ROOT_KEY)!)).toEqual({ root: "/real/w" });
    expect(b.list.mock.calls).toEqual([["/real/w"], ["/real/w"]]);
    expect(shape(ws.rows.value)).toEqual(["a.md"]);
  });

  it("does not rewrite the stored folder when its spelling was already canonical", async () => {
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/w", note: "written by an older build" }));
    const b = backend({ "/w": [] });
    const { ws, setFileBackend } = await workspace();
    setFileBackend(b);

    await ws.refresh();

    expect(b.open).toHaveBeenCalledWith("/w");
    expect(JSON.parse(storage.data.get(ROOT_KEY)!)).toEqual({ root: "/w", note: "written by an older build" });
  });

  it("opens a newly chosen folder before reading it, and not again on that first read", async () => {
    const b = backend({ "/real/v": [] }, { "/v": "/real/v" });
    const { ws, setFileBackend } = await workspace();
    setFileBackend(b);

    expect(await ws.switchRoot("/v")).toBe(true);

    expect(b.open.mock.calls).toEqual([["/v"]]);
    expect(ws.root.value).toBe("/real/v");
    expect(ws.recent.value).toEqual(["/real/v"]);
    expect(b.list.mock.calls).toEqual([["/real/v"]]);
  });

  it("leaves the current folder exactly as it was when it refuses the next one", async () => {
    const b = backend({ "/w": [{ name: "a.md", path: "/w/a.md", isDirectory: false }] }, { "/gone": "REFUSE" });
    const { ws, setFileBackend } = await workspace();
    setFileBackend(b);
    await ws.switchRoot("/w");

    expect(await ws.switchRoot("/gone")).toBe(false);

    expect(ws.root.value).toBe("/w");
    expect(ws.error.value).toBe("cannot open /gone");
    expect(ws.recent.value).toEqual(["/w"]);
    expect(shape(ws.rows.value)).toEqual(["a.md"]);
    expect(JSON.parse(storage.data.get(ROOT_KEY)!)).toEqual({ root: "/w" });
  });

  it("shows a remembered folder it refuses to reopen as unreadable", async () => {
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/w" }));
    const b = backend({}, { "/w": "REFUSE" });
    const { ws, setFileBackend } = await workspace();
    setFileBackend(b);

    await ws.refresh();

    expect(ws.unreadable.value).toBe(true);
    expect(ws.error.value).toBe("cannot open /w");
    expect(b.list).not.toHaveBeenCalled();
  });

  it("is told about the root again after it is installed again", async () => {
    // Installing a backend is a new boundary; whatever the old one opened is
    // nothing the new one has agreed to.
    storage.data.set(ROOT_KEY, JSON.stringify({ root: "/w" }));
    const b = backend({ "/w": [] });
    const { ws, setFileBackend } = await workspace();
    setFileBackend(b);
    await ws.refresh();

    setFileBackend(b);
    await ws.refresh();

    expect(b.open.mock.calls).toEqual([["/w"], ["/w"]]);
  });
});
