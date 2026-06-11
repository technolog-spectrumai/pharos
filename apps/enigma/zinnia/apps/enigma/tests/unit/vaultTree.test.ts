import { describe, it, expect } from "vitest";
import { buildForest, findDir, dirChain } from "../../src/lib/vaultTree";
import type { VaultFile, VaultBucket } from "../../src/services/api";

function mkFile(over: Partial<VaultFile> = {}): VaultFile {
  return {
    id: over.id ?? 1,
    title: over.title ?? "file",
    key: over.key ?? "file",
    file_type: over.file_type ?? "text",
    file_size_bytes: over.file_size_bytes ?? 10,
    is_public: over.is_public ?? false,
    is_encrypted: over.is_encrypted ?? false,
    uploaded_at: over.uploaded_at ?? "2026-01-01T00:00:00Z",
    download_url: over.download_url ?? null,
    bucket_slug: over.bucket_slug ?? "personal",
    directory_id: over.directory_id ?? null,
    is_editable: over.is_editable ?? true,
  };
}

function bucket(slug: string, name: string, directories: VaultBucket["directories"] = []): VaultBucket {
  return { id: slug.length, slug, name, directories };
}

describe("buildForest", () => {
  it("returns an empty forest for no data", () => {
    expect(buildForest([], [])).toEqual([]);
  });

  it("places root files (no directory) at the bucket root", () => {
    const files = [mkFile({ key: "a", title: "Alpha", bucket_slug: "docs" })];
    const forest = buildForest(files, [bucket("docs", "Docs")]);
    expect(forest).toHaveLength(1);
    expect(forest[0].slug).toBe("docs");
    expect(forest[0].files.map((f) => f.key)).toEqual(["a"]);
    expect(forest[0].fileCount).toBe(1);
    expect(forest[0].dirs).toEqual([]);
  });

  it("nests directories and assigns files to them", () => {
    const dirs = [
      { id: 1, name: "src", parent_id: null, path: "src" },
      { id: 2, name: "lib", parent_id: 1, path: "src/lib" },
    ];
    const files = [
      mkFile({ key: "root", title: "Root", bucket_slug: "code", directory_id: null }),
      mkFile({ key: "main", title: "main", bucket_slug: "code", directory_id: 1 }),
      mkFile({ key: "util", title: "util", bucket_slug: "code", directory_id: 2 }),
    ];
    const forest = buildForest(files, [bucket("code", "Code", dirs)]);
    const code = forest[0];
    expect(code.files.map((f) => f.key)).toEqual(["root"]);
    expect(code.dirs).toHaveLength(1);
    const src = code.dirs[0];
    expect(src.id).toBe(1);
    expect(src.files.map((f) => f.key)).toEqual(["main"]);
    expect(src.dirs).toHaveLength(1);
    expect(src.dirs[0].files.map((f) => f.key)).toEqual(["util"]);
    expect(code.fileCount).toBe(3);
  });

  it("drops files into the bucket root when their directory id is unknown", () => {
    const files = [mkFile({ key: "orphan", bucket_slug: "b", directory_id: 999 })];
    const forest = buildForest(files, [bucket("b", "B")]);
    expect(forest[0].files.map((f) => f.key)).toEqual(["orphan"]);
  });

  it("creates a bucket node for a file whose bucket is not in the buckets payload", () => {
    const files = [mkFile({ key: "x", bucket_slug: "ghost" })];
    const forest = buildForest(files, []);
    expect(forest.map((b) => b.slug)).toContain("ghost");
    expect(forest[0].name).toBe("ghost");
  });

  it("treats a missing bucket_slug as 'personal'", () => {
    const files = [mkFile({ key: "x", bucket_slug: null })];
    const forest = buildForest(files, []);
    expect(forest[0].slug).toBe("personal");
  });

  it("sorts buckets by name, directories by name, files by title", () => {
    const dirs = [
      { id: 1, name: "zeta", parent_id: null, path: "zeta" },
      { id: 2, name: "alpha", parent_id: null, path: "alpha" },
    ];
    const files = [
      mkFile({ key: "b", title: "Beta", bucket_slug: "one", directory_id: null }),
      mkFile({ key: "a", title: "Aardvark", bucket_slug: "one", directory_id: null }),
    ];
    const forest = buildForest(files, [bucket("two", "ZBucket"), bucket("one", "ABucket", dirs)]);
    expect(forest.map((b) => b.name)).toEqual(["ABucket", "ZBucket"]);
    expect(forest[0].dirs.map((d) => d.name)).toEqual(["alpha", "zeta"]);
    expect(forest[0].files.map((f) => f.title)).toEqual(["Aardvark", "Beta"]);
  });

  it("keeps empty buckets (no files) that are listed in the payload", () => {
    const forest = buildForest([], [bucket("empty", "Empty Bucket")]);
    expect(forest).toHaveLength(1);
    expect(forest[0].fileCount).toBe(0);
  });
});

describe("findDir / dirChain", () => {
  const dirs = [
    { id: 1, name: "a", parent_id: null, path: "a" },
    { id: 2, name: "b", parent_id: 1, path: "a/b" },
    { id: 3, name: "c", parent_id: 2, path: "a/b/c" },
  ];
  const forest = buildForest([], [bucket("x", "X", dirs)]);
  const roots = forest[0].dirs;

  it("findDir locates a deeply nested node", () => {
    expect(findDir(roots, 3)?.name).toBe("c");
    expect(findDir(roots, 1)?.name).toBe("a");
  });

  it("findDir returns null for an unknown id", () => {
    expect(findDir(roots, 42)).toBeNull();
  });

  it("dirChain returns the full ancestor path root → target", () => {
    expect(dirChain(roots, 3).map((d) => d.name)).toEqual(["a", "b", "c"]);
    expect(dirChain(roots, 1).map((d) => d.name)).toEqual(["a"]);
  });

  it("dirChain returns [] when the id is absent", () => {
    expect(dirChain(roots, 99)).toEqual([]);
  });
});
