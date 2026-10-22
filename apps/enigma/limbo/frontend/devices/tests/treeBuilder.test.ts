// The DFS flattening that both file buckets render from.
import { describe, expect, it } from "vitest";
import { buildTree } from "../../src/components/devices/treeBuilder";

const file = (id: string, dir: string, name: string) => ({ id, dir, name });

describe("buildTree", () => {
  it("returns files at root with pid null and depth 0", () => {
    const rows = buildTree([file("a", "", "a.txt"), file("b", "", "b.txt")]);
    expect(rows.map((r) => [r.id, r.pid, r.depth, r.kind])).toEqual([
      ["a", null, 0, "file"],
      ["b", null, 0, "file"],
    ]);
  });

  it("derives intermediate directories from deep paths", () => {
    const rows = buildTree([file("x", "docs/work", "cv.pdf")]);
    expect(rows.map((r) => [r.id, r.pid, r.depth, r.kind, r.name])).toEqual([
      ["d:docs", null, 0, "dir", "docs"],
      ["d:docs/work", "d:docs", 1, "dir", "work"],
      ["x", "d:docs/work", 2, "file", "cv.pdf"],
    ]);
  });

  it("orders dirs before files, both case-insensitively by name", () => {
    const rows = buildTree([
      file("f1", "", "Zebra.txt"),
      file("f2", "", "apple.txt"),
      file("f3", "beta", "inner.txt"),
      file("f4", "Alpha", "inner.txt"),
    ]);
    expect(rows.map((r) => r.name)).toEqual([
      "Alpha", "inner.txt", "beta", "inner.txt", "apple.txt", "Zebra.txt",
    ]);
  });

  it("counts only direct children on dir rows", () => {
    const rows = buildTree([
      file("a", "top", "one.txt"),
      file("b", "top/sub", "two.txt"),
      file("c", "top/sub", "three.txt"),
    ]);
    const top = rows.find((r) => r.id === "d:top")!;
    expect([top.nDirs, top.nFiles]).toEqual([1, 1]);
    const sub = rows.find((r) => r.id === "d:top/sub")!;
    expect([sub.nDirs, sub.nFiles]).toEqual([0, 2]);
  });

  it("materializes empty directories passed from the scan", () => {
    const rows = buildTree([], ["photos/2026"]);
    expect(rows.map((r) => [r.kind, r.name])).toEqual([
      ["dir", "photos"],
      ["dir", "2026"],
    ]);
  });

  it("keeps marker, locked and selectable on file rows", () => {
    const rows = buildTree([
      { id: "m", dir: "", name: "m.txt", marker: "changed" as const, locked: true, selectable: true },
    ]);
    expect(rows[0]).toMatchObject({ marker: "changed", locked: true, selectable: true });
  });

  it("shared dir prefixes merge rather than duplicate", () => {
    const rows = buildTree([file("a", "docs", "a.txt"), file("b", "docs", "b.txt")]);
    expect(rows.filter((r) => r.kind === "dir")).toHaveLength(1);
  });
});
