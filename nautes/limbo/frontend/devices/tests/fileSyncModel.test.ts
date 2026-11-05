import { describe, expect, it } from "vitest";
import {
  FILESYNC_DIR_MAX_SEGMENTS,
  FILESYNC_MAX_ENTRIES,
  FILESYNC_MAX_WIRE_ENTRIES,
  FILESYNC_TRIM_AT,
  entryTreePath,
  liveFileEntries,
  mergeFileLists,
  normalizeDirPath,
  trimFileEntries,
  validateDlinkFilePullReq,
  validateDlinkFilePush,
  validateDlinkFileResult,
  validateDlinkFiles,
  validateFileEntryList,
  validateSyncedFileEntry,
  type SyncedFileEntry,
} from "../../src/fileSyncModel";

// The merge is the heart of the shared list: it must be conflict-free under
// offline concurrent edits and a lost removal must be impossible (the locked
// UX promise is "remove removes on both").

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function entry(id: string, over: Partial<SyncedFileEntry> = {}): SyncedFileEntry {
  return {
    id,
    name: `${id}.txt`,
    addedBy: "primary",
    addedAt: 100,
    updatedAt: 100,
    copies: {},
    ...over,
  };
}

describe("validateSyncedFileEntry", () => {
  it("round-trips a full entry and rebuilds every field", () => {
    const e = entry("e1", {
      removedAt: 500,
      copies: { primary: { hash: HASH_A, size: 42, updatedAt: 200 } },
    });
    expect(validateSyncedFileEntry({ ...e, junk: 1 })).toEqual(e);
  });

  it("rejects bad hashes, negative numbers, oversized names", () => {
    expect(validateSyncedFileEntry(entry("e1", { copies: { d: { hash: "zz", size: 1, updatedAt: 1 } } }))).toBeNull();
    expect(validateSyncedFileEntry(entry("e1", { addedAt: -1 }))).toBeNull();
    expect(validateSyncedFileEntry(entry("e1", { name: "x".repeat(200) }))).toBeNull();
    expect(validateSyncedFileEntry(entry("e1", { removedAt: Number.NaN }))).toBeNull();
  });

  it("list validation hard-rejects on any bad or duplicate entry", () => {
    expect(validateFileEntryList([entry("a"), entry("a")])).toBeNull();
    expect(validateFileEntryList([entry("a"), { junk: true }])).toBeNull();
    expect(validateFileEntryList(new Array(FILESYNC_MAX_WIRE_ENTRIES + 1).fill(entry("a")))).toBeNull();
    expect(validateFileEntryList([entry("a"), entry("b")])?.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("keeps a valid dir and demotes a bad one to root instead of rejecting", () => {
    expect(validateSyncedFileEntry(entry("e1", { dir: "docs/work" }))?.dir).toBe("docs/work");
    // Demotions — the entry survives, the dir does not:
    for (const dir of ["../up", "/abs", "a//b", ".hidden", "a/./b", "x".repeat(600), 42 as unknown as string]) {
      const validated = validateSyncedFileEntry(entry("e1", { dir }));
      expect(validated).not.toBeNull();
      expect(validated?.dir).toBeUndefined();
    }
  });
});

describe("normalizeDirPath / entryTreePath", () => {
  it("normalizes to root for traversal, absolute and over-cap paths", () => {
    expect(normalizeDirPath("docs")).toBe("docs");
    expect(normalizeDirPath("")).toBe("");
    expect(normalizeDirPath(undefined)).toBe("");
    expect(normalizeDirPath("a/".repeat(FILESYNC_DIR_MAX_SEGMENTS) + "b")).toBe("");
    expect(normalizeDirPath("back\\slash")).toBe("");
    expect(normalizeDirPath("colon:name")).toBe("");
  });

  it("entryTreePath joins dir and name", () => {
    expect(entryTreePath(entry("e1"))).toBe("e1.txt");
    expect(entryTreePath(entry("e1", { dir: "docs/work" }))).toBe("docs/work/e1.txt");
  });
});

describe("mergeFileLists", () => {
  it("unions adds from both sides", () => {
    const { merged, changed } = mergeFileLists([entry("a")], [entry("b")]);
    expect(merged.map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(changed).toBe(true);
  });

  it("keeps local immutables on id collision", () => {
    const { merged } = mergeFileLists(
      [entry("a", { name: "mine.txt", addedAt: 50 })],
      [entry("a", { name: "theirs.txt", addedAt: 60 })],
    );
    expect(merged[0].name).toBe("mine.txt");
    expect(merged[0].addedAt).toBe(50);
  });

  it("tombstone is sticky and the earliest wins — a removal can never be lost", () => {
    const removedRemote = mergeFileLists([entry("a")], [entry("a", { removedAt: 900, updatedAt: 900 })]);
    expect(removedRemote.merged[0].removedAt).toBe(900);

    // The tombstoned side never resurrects, whatever the peer's updatedAt says.
    const resurrectAttempt = mergeFileLists(
      [entry("a", { removedAt: 900, updatedAt: 900 })],
      [entry("a", { updatedAt: 5000 })],
    );
    expect(resurrectAttempt.merged[0].removedAt).toBe(900);

    const bothRemoved = mergeFileLists(
      [entry("a", { removedAt: 900 })],
      [entry("a", { removedAt: 700 })],
    );
    expect(bothRemoved.merged[0].removedAt).toBe(700);
  });

  it("copies merge per-device-slot by updatedAt", () => {
    const local = entry("a", {
      copies: {
        primary: { hash: HASH_A, size: 1, updatedAt: 100 },
        phone: { hash: HASH_A, size: 1, updatedAt: 100 },
      },
    });
    const remote = entry("a", {
      copies: {
        phone: { hash: HASH_B, size: 2, updatedAt: 200 }, // phone's own newer claim
        primary: { hash: HASH_B, size: 9, updatedAt: 50 }, // stale echo of our slot
      },
    });
    const { merged } = mergeFileLists([local], [remote]);
    expect(merged[0].copies.primary.hash).toBe(HASH_A); // ours, newer, kept
    expect(merged[0].copies.phone.hash).toBe(HASH_B); // theirs, newer, taken
  });

  it("is idempotent (re-merging the same remote changes nothing)", () => {
    const remote = [entry("a", { copies: { phone: { hash: HASH_B, size: 2, updatedAt: 200 } } })];
    const first = mergeFileLists([entry("a")], remote);
    const second = mergeFileLists(first.merged, remote);
    expect(second.changed).toBe(false);
    expect(second.merged).toEqual(first.merged);
  });
});

describe("trimFileEntries", () => {
  it("drops oldest tombstones past the threshold, never live entries", () => {
    const live = Array.from({ length: FILESYNC_MAX_ENTRIES }, (_, i) => entry(`live-${i}`));
    const dead = Array.from({ length: FILESYNC_TRIM_AT }, (_, i) =>
      entry(`dead-${i}`, { removedAt: 1000 + i }),
    );
    const trimmed = trimFileEntries([...live, ...dead]);
    expect(trimmed.length).toBe(FILESYNC_TRIM_AT);
    expect(trimmed.filter((e) => e.removedAt === undefined).length).toBe(FILESYNC_MAX_ENTRIES);
    // Survivors are the NEWEST tombstones.
    expect(trimmed.some((e) => e.id === "dead-0")).toBe(false);
    expect(trimmed.some((e) => e.id === `dead-${FILESYNC_TRIM_AT - 1}`)).toBe(true);
  });

  it("leaves small lists untouched (same reference)", () => {
    const list = [entry("a"), entry("b", { removedAt: 5 })];
    expect(trimFileEntries(list)).toBe(list);
  });
});

describe("liveFileEntries", () => {
  it("filters tombstones", () => {
    expect(liveFileEntries([entry("a"), entry("b", { removedAt: 1 })]).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("wire validators", () => {
  it("dlink_files: exact type/v + list validation", () => {
    expect(validateDlinkFiles({ type: "dlink_files", v: 1, entries: [entry("a")] })?.entries).toHaveLength(1);
    expect(validateDlinkFiles({ type: "dlink_files", v: 2, entries: [] })).toBeNull();
    expect(validateDlinkFiles({ type: "dlink_files", v: 1, entries: [{ junk: 1 }] })).toBeNull();
  });

  it("dlink_file_push: items validated hard, optional reqId", () => {
    const item = { entryId: "e", offerId: "o", addr: "addr", name: "f.txt", size: 3, hash: HASH_A };
    const ok = validateDlinkFilePush({ type: "dlink_file_push", v: 1, items: [item], reqId: "r1" });
    expect(ok?.items[0]).toEqual(item);
    expect(ok?.reqId).toBe("r1");
    expect(validateDlinkFilePush({ type: "dlink_file_push", v: 1, items: [{ ...item, hash: "nope" }] })).toBeNull();
    expect(validateDlinkFilePush({ type: "dlink_file_push", v: 1, items: [item], reqId: "" })).toBeNull();
  });

  it("dlink_file_pull_req: non-empty deduped ids", () => {
    expect(
      validateDlinkFilePullReq({ type: "dlink_file_pull_req", v: 1, reqId: "r", entryIds: ["a", "b"] })?.entryIds,
    ).toEqual(["a", "b"]);
    expect(validateDlinkFilePullReq({ type: "dlink_file_pull_req", v: 1, reqId: "r", entryIds: [] })).toBeNull();
    expect(validateDlinkFilePullReq({ type: "dlink_file_pull_req", v: 1, reqId: "r", entryIds: ["a", "a"] })).toBeNull();
  });

  it("dlink_file_result: status allow-list", () => {
    expect(validateDlinkFileResult({ type: "dlink_file_result", v: 1, entryId: "e", status: "skipped" })?.status).toBe(
      "skipped",
    );
    expect(validateDlinkFileResult({ type: "dlink_file_result", v: 1, entryId: "e", status: "eaten" })).toBeNull();
  });
});
