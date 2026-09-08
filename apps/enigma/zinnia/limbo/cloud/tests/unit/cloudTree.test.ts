import { describe, expect, it } from "vitest";
import {
  buildTree, bucketNodeId, directoryNodeId, filesIn, isEmptyDirectory, trailTo,
} from "../../src/files/cloudTree";
import type { VaultBucketDto, VaultFileDto } from "../../src/api/vault";

const dir = (id: number, name: string, parent_id: number | null = null) =>
  ({ id, name, parent_id, path: name });

const bucket = (slug: string, dirs = [] as ReturnType<typeof dir>[]): VaultBucketDto =>
  ({ id: 1, slug, name: slug.toUpperCase(), directories: dirs });

const file = (key: string, bucket_slug: string, directory_id: number | null): VaultFileDto => ({
  id: 1, title: key, key, file_type: "svg", file_size_bytes: 1, is_public: false,
  is_encrypted: false, uploaded_at: "2026-01-01T00:00:00Z", download_url: null,
  bucket_slug, directory_id, is_editable: true,
});

describe("building the folder tree", () => {
  it("always gives a bucket a root row, even when it is the only one", () => {
    // Collapsing the single-bucket row looks tidier and loses files: anything
    // sitting at the bucket's root belongs to that row and to nothing else, so
    // without it those files are unreachable.
    const rows = buildTree([bucket("main", [dir(1, "reports")])]);
    expect(rows.map((r) => r.kind)).toEqual(["bucket", "directory"]);
    expect(rows[0].depth).toBe(0);
    expect(rows[0].directoryId).toBe(null);
  });

  it("keeps a root row for a bucket with no folders at all", () => {
    const rows = buildTree([bucket("main")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("bucket");
  });

  it("makes buckets the top level when there are several", () => {
    const rows = buildTree([bucket("a", [dir(1, "x")]), bucket("b")]);
    expect(rows.filter((r) => r.kind === "bucket").map((r) => r.id))
      .toEqual([bucketNodeId("a"), bucketNodeId("b")]);
    const x = rows.find((r) => r.name === "x")!;
    expect(x.pid).toBe(bucketNodeId("a"));
    expect(x.depth).toBe(1);
  });

  it("nests by parent_id, depth-first and alphabetically", () => {
    const rows = buildTree([bucket("main", [
      dir(1, "beta"), dir(2, "alpha"), dir(3, "inner", 2), dir(4, "deeper", 3),
    ])]);
    expect(rows.map((r) => r.name)).toEqual(["MAIN", "alpha", "inner", "deeper", "beta"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 1]);
  });

  it("shows an orphan rather than dropping it", () => {
    // A directory whose parent is not in the list still exists on the server. A
    // folder the app silently hides is worse than one shown in the wrong place.
    const rows = buildTree([bucket("main", [dir(7, "lost", 999)])]);
    expect(rows.map((r) => r.name)).toEqual(["MAIN", "lost"]);
  });

  it("terminates on a cycle instead of hanging", () => {
    // A self-parented or mutually-parented directory would otherwise recurse
    // forever. A malformed tree should render short, not lock the window.
    const rows = buildTree([bucket("main", [dir(1, "loop", 1), dir(2, "a", 3), dir(3, "b", 2)])]);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

describe("files in a node", () => {
  const files = [
    file("root-file", "main", null),
    file("in-folder", "main", 1),
    file("other-bucket", "other", null),
  ];

  it("takes only the selected folder's files", () => {
    const rows = buildTree([bucket("main", [dir(1, "reports")]), bucket("other")]);
    const folder = rows.find((r) => r.name === "reports")!;
    expect(filesIn(files, folder).map((f) => f.key)).toEqual(["in-folder"]);
  });

  it("treats a bucket node as its own root, not everything in it", () => {
    const rows = buildTree([bucket("main", [dir(1, "reports")]), bucket("other")]);
    const main = rows.find((r) => r.id === bucketNodeId("main"))!;
    expect(filesIn(files, main).map((f) => f.key)).toEqual(["root-file"]);
  });

  it("shows nothing when nothing is selected", () => {
    expect(filesIn(files, null)).toEqual([]);
  });
});

describe("deleting a folder", () => {
  it("is offered only for one with no children and no files", () => {
    const rows = buildTree([bucket("main", [dir(1, "full"), dir(2, "empty"), dir(3, "kid", 1)])]);
    const full = rows.find((r) => r.name === "full")!;
    const empty = rows.find((r) => r.name === "empty")!;
    expect(isEmptyDirectory(full, rows, [])).toBe(false); // has a subfolder
    expect(isEmptyDirectory(empty, rows, [])).toBe(true);
    expect(isEmptyDirectory(empty, rows, [file("f", "main", 2)])).toBe(false); // holds a file
  });

  it("is never offered for a bucket", () => {
    const rows = buildTree([bucket("a"), bucket("b")]);
    expect(isEmptyDirectory(rows[0], rows, [])).toBe(false);
  });
});

describe("the breadcrumb", () => {
  it("walks up to the root", () => {
    const rows = buildTree([bucket("a", [dir(1, "x"), dir(2, "y", 1)]), bucket("b")]);
    const y = rows.find((r) => r.name === "y")!;
    expect(trailTo(y, rows).map((n) => n.name)).toEqual(["A", "x", "y"]);
  });

  it("starts at the bucket even when there is only one", () => {
    const rows = buildTree([bucket("a", [dir(1, "x"), dir(2, "y", 1)])]);
    const y = rows.find((r) => r.name === "y")!;
    expect(trailTo(y, rows).map((n) => n.name)).toEqual(["A", "x", "y"]);
  });

  it("survives a broken parent chain", () => {
    const rows = buildTree([bucket("a", [dir(1, "x")])]);
    const orphan = { ...rows[rows.length - 1], pid: "d:404" };
    expect(() => trailTo(orphan, rows)).not.toThrow();
  });
});
