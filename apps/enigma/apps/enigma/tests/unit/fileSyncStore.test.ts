import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, computed } from "vue";
import { createPinia, setActivePinia } from "pinia";

// The fileSync store owns the Push/Pull batches: hash-based skipping, the
// file_xfer offer/download chain, and the dlink_file_* signaling. The devlink
// channel and Tauri are stubbed; what's pinned here is the decision logic —
// what gets offered, what gets skipped, what lands, and what the peer is told.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const backendListeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    backendListeners.set(name, cb);
    return () => backendListeners.delete(name);
  }),
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openMock(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(async () => {}) }));

const { fakeSync } = vi.hoisted(() => ({
  fakeSync: {
    handler: null as null | ((t: string, p: Record<string, unknown>, s: string) => void),
    sent: [] as Array<[string, Record<string, unknown>]>,
    entries: [] as Record<string, unknown>[],
    copies: [] as Array<[string, Record<string, unknown>]>,
    tombstoned: [] as string[],
  },
}));

vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    deviceSync: {
      linked: ref(true),
      devOnline: ref(true),
      link: ref({ myDeviceId: "primary", myLeafId: "alice", linkKey: "k", roomName: "r" }),
      registry: ref({
        v: 1,
        user: "alice",
        rev: 1,
        devices: [
          { deviceId: "primary", label: "Desktop", kind: "desktop", leafId: "alice", nodeId: "na", addedAt: 1 },
          { deviceId: "phone", label: "Phone", kind: "mobile", leafId: "alice#dev-aaaaaaaa", nodeId: "nb", addedAt: 2 },
        ],
        mac: "m",
      }),
      fileEntries: computed(() => fakeSync.entries),
      onDevlinkFile: (fn: (t: string, p: Record<string, unknown>, s: string) => void) => {
        fakeSync.handler = fn;
        return () => {
          fakeSync.handler = null;
        };
      },
      sendDevlinkFile: vi.fn(async (type: string, payload: Record<string, unknown>) => {
        fakeSync.sent.push([type, payload]);
      }),
      upsertFileEntry: vi.fn(async (entry: Record<string, unknown>) => {
        fakeSync.entries.push(entry);
        return true;
      }),
      tombstoneFileEntry: vi.fn(async (id: string) => {
        fakeSync.tombstoned.push(id);
        fakeSync.entries = fakeSync.entries.filter((e) => e.id !== id);
      }),
      recordFileCopy: vi.fn(async (entryId: string, copy: Record<string, unknown>) => {
        fakeSync.copies.push([entryId, copy]);
      }),
    },
  }),
}));

import { useFileSyncStore } from "../../src/stores/fileSync";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function entry(id: string, over: Record<string, unknown> = {}) {
  return { id, name: `${id}.txt`, addedBy: "primary", addedAt: 1, updatedAt: 1, copies: {}, ...over };
}

function fire(event: string, payload: unknown) {
  backendListeners.get(event)?.({ payload });
}

function sentOf(type: string) {
  return fakeSync.sent.filter(([t]) => t === type).map(([, p]) => p);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  backendListeners.clear();
  localStorage.clear();
  fakeSync.handler = null;
  fakeSync.sent = [];
  fakeSync.entries = [];
  fakeSync.copies = [];
  fakeSync.tombstoned = [];
  // Tauri-only paths: the store checks isTauri() via rakotis. That also routes
  // the kv layer through invoke, so the mock backs kv_* with localStorage.
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "kv_get") return localStorage.getItem(`enigma:db:${args.ns}:${args.scope}:${args.k}`);
    if (cmd === "kv_put") {
      localStorage.setItem(`enigma:db:${args.ns}:${args.scope}:${args.k}`, args.v as string);
      return undefined;
    }
    if (cmd === "filesync_hash") return { hash: HASH_A, size: 10 };
    if (cmd === "file_offer_create") return { offer_id: `offer-${args.path}`, addr: "b32", name: "n", size: 10, mime: "m" };
    if (cmd === "filesync_recv_path") return `/tmp/recv-${args.offerId}.part`;
    if (cmd === "filesync_import") return { path: "/synced/f.txt", name: "f.txt", hash: HASH_A, size: 10 };
    if (cmd === "filesync_dir") return "/synced";
    return undefined;
  });
});

async function seededStore(records: Record<string, unknown> = {}) {
  localStorage.setItem("enigma:db:filesync:default:local", JSON.stringify(records));
  const store = useFileSyncStore();
  await store.init();
  return store;
}

describe("adding entries", () => {
  it("hashes the picked file, shares the entry, and records the local path", async () => {
    openMock.mockResolvedValue("/home/a/report.pdf");
    const store = await seededStore();
    await store.addFile();

    expect(fakeSync.entries).toHaveLength(1);
    expect(fakeSync.entries[0]).toMatchObject({ name: "report.pdf", addedBy: "primary" });
    expect((fakeSync.entries[0].copies as Record<string, { hash: string }>).primary.hash).toBe(HASH_A);
    const id = fakeSync.entries[0].id as string;
    expect(store.localRecord(id)?.path).toBe("/home/a/report.pdf");
  });

  it("refuses a duplicate path and a cancelled picker", async () => {
    openMock.mockResolvedValue("/home/a/report.pdf");
    const store = await seededStore();
    await store.addFile();
    await store.addFile(); // same path again
    expect(fakeSync.entries).toHaveLength(1);

    openMock.mockResolvedValue(null);
    await store.addFile();
    expect(fakeSync.entries).toHaveLength(1);
  });

  it("remove tombstones the entry and drops the local record", async () => {
    openMock.mockResolvedValue("/home/a/report.pdf");
    const store = await seededStore();
    await store.addFile();
    const id = fakeSync.entries[0].id as string;

    await store.removeEntry(id);
    expect(fakeSync.tombstoned).toEqual([id]);
    expect(store.localRecord(id)).toBeUndefined();
  });
});

describe("push", () => {
  it("skips entries the sibling already has, offers the rest, announces once", async () => {
    fakeSync.entries = [
      entry("same", { copies: { phone: { hash: HASH_A, size: 10, updatedAt: 5 } } }),
      entry("differs", { copies: { phone: { hash: HASH_B, size: 10, updatedAt: 5 } } }),
    ];
    const store = await seededStore({
      same: { path: "/a/same.txt", hash: HASH_A, size: 10, verifiedAt: 1 },
      differs: { path: "/a/differs.txt", hash: HASH_A, size: 10, verifiedAt: 1 },
    });
    store.selectAll(true);
    await store.pushSelected();

    expect(store.items.get("same")?.status).toBe("skipped");
    const pushes = sentOf("dlink_file_push");
    expect(pushes).toHaveLength(1);
    const announced = (pushes[0].items as Array<{ entryId: string }>).map((i) => i.entryId);
    expect(announced).toEqual(["differs"]);
  });

  it("marks a vanished file missing without offering it", async () => {
    fakeSync.entries = [entry("gone")];
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "filesync_hash") throw new Error("open failed");
      return base(cmd, args);
    });
    const store = await seededStore({ gone: { path: "/a/gone.txt", hash: HASH_A, size: 10, verifiedAt: 1 } });
    store.selectAll(true);
    await store.pushSelected();

    expect(store.items.get("gone")?.status).toBe("missing");
    expect(sentOf("dlink_file_push")).toHaveLength(0);
  });

  it("refuses files over the size cap", async () => {
    localStorage.setItem("enigma:db:p2p:settings:default:max_file_size_mb", "1");
    fakeSync.entries = [entry("big")];
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "filesync_hash") return { hash: HASH_A, size: 5 * 1024 * 1024 };
      return base(cmd, args);
    });
    const store = await seededStore({ big: { path: "/a/big.bin", hash: HASH_A, size: 1, verifiedAt: 1 } });
    store.selectAll(true);
    await store.pushSelected();

    expect(store.items.get("big")?.status).toBe("too-large");
  });

  it("file://done on our offer marks the row sent and cancels the offer", async () => {
    fakeSync.entries = [entry("f1")];
    const store = await seededStore({ f1: { path: "/a/f1.txt", hash: HASH_B, size: 10, verifiedAt: 1 } });
    store.selectAll(true);
    await store.pushSelected();

    fire("file://done", { offerId: "offer-/a/f1.txt", dir: "send" });
    expect(store.items.get("f1")?.status).toBe("sent");
    // rakotis' invoke resolves through a dynamic import — let it land.
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledWith("file_offer_cancel", { offerId: "offer-/a/f1.txt" });
  });
});

describe("receiving a push", () => {
  it("downloads, imports with hash verification, records the copy, and reports back", async () => {
    fakeSync.entries = [entry("e1")];
    const store = await seededStore();

    fakeSync.handler!(
      "dlink_file_push",
      {
        type: "dlink_file_push",
        v: 1,
        items: [{ entryId: "e1", offerId: "o1", addr: "b32", name: "f.txt", size: 10, hash: HASH_A }],
      },
      "alice#dev-aaaaaaaa",
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(invokeMock).toHaveBeenCalledWith("filesync_recv_path", { offerId: "o1" });
    expect(invokeMock).toHaveBeenCalledWith("file_download", {
      addr: "b32",
      offerId: "o1",
      dest: "/tmp/recv-o1.part",
    });

    fire("file://done", { offerId: "o1", dir: "recv" });
    await new Promise((r) => setTimeout(r, 0));

    expect(invokeMock).toHaveBeenCalledWith("filesync_import", {
      offerId: "o1",
      name: "f.txt",
      expectedHash: HASH_A,
      priorPath: null,
    });
    expect(store.localRecord("e1")?.path).toBe("/synced/f.txt");
    expect(fakeSync.copies).toEqual([["e1", expect.objectContaining({ hash: HASH_A, size: 10 })]]);
    expect(sentOf("dlink_file_result").at(-1)).toMatchObject({ entryId: "e1", status: "received" });
  });

  it("skips a push whose hash we already hold", async () => {
    fakeSync.entries = [entry("e1")];
    const store = await seededStore({ e1: { path: "/synced/f.txt", hash: HASH_A, size: 10, verifiedAt: 1 } });

    fakeSync.handler!(
      "dlink_file_push",
      { type: "dlink_file_push", v: 1, items: [{ entryId: "e1", offerId: "o1", addr: "b32", name: "f.txt", size: 10, hash: HASH_A }] },
      "alice#dev-aaaaaaaa",
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(invokeMock).not.toHaveBeenCalledWith("file_download", expect.anything());
    expect(store.items.get("e1")?.status).toBe("skipped");
    expect(sentOf("dlink_file_result").at(-1)).toMatchObject({ status: "skipped" });
  });

  it("ignores items for entries it does not know", async () => {
    const store = await seededStore();
    fakeSync.handler!(
      "dlink_file_push",
      { type: "dlink_file_push", v: 1, items: [{ entryId: "ghost", offerId: "o1", addr: "b32", name: "f", size: 1, hash: HASH_A }] },
      "alice#dev-aaaaaaaa",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).not.toHaveBeenCalledWith("filesync_recv_path", expect.anything());
    expect(store.items.size).toBe(0);
  });

  it("a failed import reports failed and leaves the record alone", async () => {
    fakeSync.entries = [entry("e1")];
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "filesync_import") throw new Error("hash mismatch — transfer discarded");
      return base(cmd, args);
    });
    const store = await seededStore();

    fakeSync.handler!(
      "dlink_file_push",
      { type: "dlink_file_push", v: 1, items: [{ entryId: "e1", offerId: "o1", addr: "b32", name: "f.txt", size: 10, hash: HASH_A }] },
      "alice#dev-aaaaaaaa",
    );
    await new Promise((r) => setTimeout(r, 0));
    fire("file://done", { offerId: "o1", dir: "recv" });
    await new Promise((r) => setTimeout(r, 0));

    expect(store.items.get("e1")?.status).toBe("failed");
    expect(store.localRecord("e1")).toBeUndefined();
    expect(sentOf("dlink_file_result").at(-1)).toMatchObject({ status: "failed" });
  });
});

describe("pull", () => {
  it("asks only for entries a sibling has and we don't already match", async () => {
    fakeSync.entries = [
      entry("nobody-has"),
      entry("already", { copies: { phone: { hash: HASH_A, size: 10, updatedAt: 3 } } }),
      entry("want", { copies: { phone: { hash: HASH_B, size: 10, updatedAt: 3 } } }),
    ];
    const store = await seededStore({
      already: { path: "/synced/already.txt", hash: HASH_A, size: 10, verifiedAt: 1 },
    });
    store.selectAll(true);
    await store.pullSelected();

    expect(store.items.get("nobody-has")?.status).toBe("unavailable");
    expect(store.items.get("already")?.status).toBe("skipped");
    const reqs = sentOf("dlink_file_pull_req");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].entryIds).toEqual(["want"]);
  });

  it("answers a peer's pull request with offers for what we hold", async () => {
    fakeSync.entries = [entry("have"), entry("havent")];
    const store = await seededStore({ have: { path: "/a/have.txt", hash: HASH_A, size: 10, verifiedAt: 1 } });
    void store;

    fakeSync.handler!(
      "dlink_file_pull_req",
      { type: "dlink_file_pull_req", v: 1, reqId: "r1", entryIds: ["have", "havent"] },
      "alice#dev-aaaaaaaa",
    );
    await new Promise((r) => setTimeout(r, 0));

    const pushes = sentOf("dlink_file_push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].reqId).toBe("r1");
    expect((pushes[0].items as Array<{ entryId: string }>).map((i) => i.entryId)).toEqual(["have"]);
    expect(sentOf("dlink_file_result").at(-1)).toMatchObject({ entryId: "havent", status: "missing" });
  });
});

describe("selection + row state", () => {
  it("select all toggles every live entry", async () => {
    fakeSync.entries = [entry("a"), entry("b")];
    const store = await seededStore();
    expect(store.allSelected).toBe(false);
    store.selectAll(true);
    expect(store.selection.size).toBe(2);
    expect(store.allSelected).toBe(true);
    store.selectAll(false);
    expect(store.selection.size).toBe(0);
    store.toggle("a");
    expect([...store.selection]).toEqual(["a"]);
  });

  it("entryState reflects local vs sibling hashes", async () => {
    const same = entry("same", { copies: { phone: { hash: HASH_A, size: 10, updatedAt: 1 } } });
    const diff = entry("diff", { copies: { phone: { hash: HASH_B, size: 10, updatedAt: 1 } } });
    const localOnly = entry("local");
    const remoteOnly = entry("remote", { copies: { phone: { hash: HASH_B, size: 10, updatedAt: 1 } } });
    fakeSync.entries = [same, diff, localOnly, remoteOnly];
    const store = await seededStore({
      same: { path: "/a", hash: HASH_A, size: 10, verifiedAt: 1 },
      diff: { path: "/b", hash: HASH_A, size: 10, verifiedAt: 1 },
      local: { path: "/c", hash: HASH_A, size: 10, verifiedAt: 1 },
    });

    expect(store.entryState(same)).toBe("synced");
    expect(store.entryState(diff)).toBe("differs");
    expect(store.entryState(localOnly)).toBe("local-only");
    expect(store.entryState(remoteOnly)).toBe("remote-only");
  });
});
