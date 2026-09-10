// The offline cache: what it keeps, what it refuses, and what it must never
// overwrite.
//
// The one that matters most is `foldFile` preserving a local edit. Everything
// else here protects a rule the online editor already had; that test protects
// the rule this module introduces.
import { describe, expect, it } from "vitest";
import {
  CACHE_VERSION,
  cachedSlugs, foldFile, forgetWorkspace, isConflict, pending,
  pushRefusal, readWorkspace, recordEdit, summarise, writeWorkspace,
  type CacheStore, type CachedFile, type CachedWorkspace,
} from "../../src/api/offline";
import type { FileContent, WorkspaceDetail } from "../../src/api/workspaces";

/** The store, as a Map. This is the whole point of injecting it. */
function memoryStore(): CacheStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    async get(k) { return raw.get(k) ?? null; },
    async set(k, v) { raw.set(k, v); },
    async remove(k) { raw.delete(k); },
    async keys() { return [...raw.keys()]; },
  };
}

const DETAIL = {
  slug: "paper", name: "Paper", writable: true,
} as unknown as WorkspaceDetail;

function file(over: Partial<CachedFile> = {}): CachedFile {
  return {
    pk: 1, name: "main.tex", saved: "hello", text: "hello",
    truncated: false, readonly: false, fetchedAt: 1000, editedAt: 0,
    ...over,
  };
}

function workspace(files: CachedFile[]): CachedWorkspace {
  return {
    slug: "paper", detail: DETAIL, items: [], cachedAt: 1000,
    files: Object.fromEntries(files.map((f) => [String(f.pk), f])),
  };
}

function served(over: Partial<FileContent> = {}): FileContent {
  return {
    pk: 1, name: "main.tex", content: "hello",
    truncated: false, readonly: false,
    ...over,
  } as FileContent;
}

describe("the cache round-trips a workspace", () => {
  it("writes one and reads it back", async () => {
    const store = memoryStore();
    await writeWorkspace(store, workspace([file()]));
    const back = await readWorkspace(store, "paper");
    expect(back?.slug).toBe("paper");
    expect(back?.files["1"].text).toBe("hello");
  });

  it("answers null for a workspace it does not hold", async () => {
    expect(await readWorkspace(memoryStore(), "absent")).toBeNull();
  });

  it("lists what it holds, for the offline picker", async () => {
    const store = memoryStore();
    await writeWorkspace(store, { ...workspace([]), slug: "beta" });
    await writeWorkspace(store, { ...workspace([]), slug: "alpha" });
    expect(await cachedSlugs(store)).toEqual(["alpha", "beta"]);
  });

  it("forgets one", async () => {
    const store = memoryStore();
    await writeWorkspace(store, workspace([file()]));
    await forgetWorkspace(store, "paper");
    expect(await readWorkspace(store, "paper")).toBeNull();
  });
});

describe("a cache it cannot read is 'not cached', never a crash", () => {
  it("survives a corrupt entry", async () => {
    const store = memoryStore();
    store.raw.set("ws:paper", "{not json at all");
    expect(await readWorkspace(store, "paper")).toBeNull();
  });

  it("discards an entry written by another version", async () => {
    const store = memoryStore();
    store.raw.set("ws:paper", JSON.stringify({
      version: CACHE_VERSION + 1, workspace: workspace([file()]),
    }));
    expect(await readWorkspace(store, "paper")).toBeNull();
  });

  it("survives a store that throws", async () => {
    const store: CacheStore = {
      async get() { throw new Error("disk is on fire"); },
      async set() { /* unused */ },
      async remove() { /* unused */ },
      async keys() { return []; },
    };
    expect(await readWorkspace(store, "paper")).toBeNull();
  });
});

describe("re-reading a file never discards what was typed", () => {
  it("keeps the local text and moves the baseline", () => {
    // THE TEST THIS MODULE EXISTS FOR. Coming back online re-reads the file;
    // if that overwrote `text`, reconnecting would silently destroy every
    // unsaved edit made while away.
    const edited = file({ text: "my afternoon", editedAt: 2000 });
    const folded = foldFile(edited, served({ content: "hello" }), 3000);
    expect(folded.text).toBe("my afternoon");
    expect(folded.saved).toBe("hello");
    expect(folded.editedAt).toBe(2000);
  });

  it("takes the server's text when nothing is pending", () => {
    const folded = foldFile(file(), served({ content: "moved on" }), 3000);
    expect(folded.text).toBe("moved on");
    expect(folded.saved).toBe("moved on");
    expect(folded.editedAt).toBe(0);
  });

  it("caches a file it has never seen", () => {
    const folded = foldFile(undefined, served({ content: "fresh" }), 3000);
    expect(folded.text).toBe("fresh");
    expect(folded.fetchedAt).toBe(3000);
  });

  it("carries truncated and readonly through", () => {
    const folded = foldFile(
      undefined, served({ truncated: true, readonly: true }), 3000);
    expect(folded.truncated).toBe(true);
    expect(folded.readonly).toBe(true);
  });
});

describe("edits", () => {
  it("stamps the time when the text moves", () => {
    const after = recordEdit(file(), "changed", 5000);
    expect(after.text).toBe("changed");
    expect(after.editedAt).toBe(5000);
  });

  it("does nothing when the text is the same", () => {
    const before = file();
    expect(recordEdit(before, "hello", 5000)).toBe(before);
  });
});

describe("the push queue", () => {
  it("holds only files whose text has moved", () => {
    const ws = workspace([
      file({ pk: 1, text: "hello" }),
      file({ pk: 2, name: "b.tex", text: "edited", editedAt: 20 }),
    ]);
    expect(pending(ws).map((f) => f.pk)).toEqual([2]);
  });

  it("replays oldest first", () => {
    const ws = workspace([
      file({ pk: 1, text: "x", editedAt: 300 }),
      file({ pk: 2, name: "b.tex", text: "y", editedAt: 100 }),
      file({ pk: 3, name: "c.tex", text: "z", editedAt: 200 }),
    ]);
    expect(pending(ws).map((f) => f.pk)).toEqual([2, 3, 1]);
  });

  it("summarises what is waiting", () => {
    const ws = workspace([
      file({ pk: 1, text: "x", editedAt: 300 }),
      file({ pk: 2, name: "b.tex", text: "y", editedAt: 100 }),
    ]);
    expect(summarise(ws)).toEqual({ files: 2, oldestEditedAt: 100 });
  });

  it("summarises nothing when there is no workspace", () => {
    expect(summarise(null)).toEqual({ files: 0, oldestEditedAt: 0 });
  });
});

describe("what may not be pushed", () => {
  it("refuses a truncated file, because pushing would cut off the tail", () => {
    expect(pushRefusal(file({ truncated: true }))).toContain("cut off");
  });

  it("refuses a generated file", () => {
    expect(pushRefusal(file({ readonly: true }))).toContain("produced by a run");
  });

  it("allows an ordinary one", () => {
    expect(pushRefusal(file())).toBe("");
  });
});

describe("conflict detection", () => {
  it("sees a server-side change against the baseline", () => {
    expect(isConflict(file({ saved: "one" }), "two")).toBe(true);
  });

  it("does not call my own edit a conflict", () => {
    // The baseline still matches the server; only `text` moved, which is the
    // ordinary pending-edit case and must push cleanly.
    expect(isConflict(file({ saved: "one", text: "mine" }), "one")).toBe(false);
  });
});
