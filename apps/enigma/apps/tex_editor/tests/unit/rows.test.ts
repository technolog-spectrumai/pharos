// The tree adapter. Pure, so this is where the tree logic is actually proven —
// the component only has to draw what comes out.
import { describe, expect, it } from "vitest";
import type { TreeItem } from "totoapi";
import { toRows, visible, isOpenable } from "../../src/files/rows";

function dir(id: number, name: string, pid: number | null, depth: number): TreeItem {
  return { t: "dir", id, pid, depth, name };
}
function file(
  id: number, name: string, pid: number | null, depth: number,
  extra: Partial<TreeItem> = {},
): TreeItem {
  return { t: "file", id, pid, depth, name, ...extra };
}

/**  src/
 *    utils/
 *      helpers.py
 *    main.py
 *  README.md
 */
const TREE: TreeItem[] = [
  dir(1, "src", null, 0),
  dir(2, "utils", 1, 1),
  file(10, "helpers.py", 2, 2),
  file(11, "main.py", 1, 1),
  file(12, "README.md", null, 0),
];

describe("toRows", () => {
  it("builds a slash path by walking parents", () => {
    const byName = Object.fromEntries(toRows(TREE).map((r) => [r.name, r.path]));
    expect(byName["src"]).toBe("src");
    expect(byName["utils"]).toBe("src/utils");
    expect(byName["helpers.py"]).toBe("src/utils/helpers.py");
    expect(byName["main.py"]).toBe("src/main.py");
    expect(byName["README.md"]).toBe("README.md");
  });

  it("keeps the server's order rather than re-sorting", () => {
    // The server already orders directories and files the way the room draws
    // them. A second opinion here means the desktop app and the web UI show the
    // same bucket differently.
    expect(toRows(TREE).map((r) => r.name)).toEqual(
      TREE.map((i) => i.name));
  });

  it("does not depend on parents arriving before children", () => {
    // True of the server today. Relying on it would make this quietly wrong the
    // day that ordering changes, and the symptom would be a path missing its
    // first segment — subtle enough to ship.
    const reversed = [...TREE].reverse();
    const deep = toRows(reversed).find((r) => r.name === "helpers.py")!;
    expect(deep.path).toBe("src/utils/helpers.py");
  });

  it("keeps the server id separate from the display path", () => {
    // Every file endpoint is addressed by id; `path` is for the UI. Confusing
    // them is the bug the Row docstring exists to prevent.
    const row = toRows(TREE).find((r) => r.name === "main.py")!;
    expect(row.id).toBe(11);
    expect(row.path).toBe("src/main.py");
  });

  it("carries readonly and encrypted through", () => {
    const rows = toRows([
      file(20, "out.pdf", null, 0, { readonly: true }),
      file(21, "secret.py", null, 0, { encrypted: true }),
    ]);
    expect(rows[0].readonly).toBe(true);
    expect(rows[1].encrypted).toBe(true);
  });

  it("survives a pid pointing at nothing", () => {
    // Bad data must not produce a path with a hole in it, or worse, a hang.
    const rows = toRows([file(30, "orphan.py", 999, 1)]);
    expect(rows[0].path).toBe("orphan.py");
  });

  it("A PID CYCLE DOES NOT HANG THE RENDER", () => {
    // A tree is the one place a cycle is cheap to introduce and expensive to
    // notice: the walk is bounded rather than trusting the data.
    const cyclic: TreeItem[] = [
      dir(1, "a", 2, 0),
      dir(2, "b", 1, 0),
      file(3, "x.py", 1, 1),
    ];
    const rows = toRows(cyclic);
    expect(rows).toHaveLength(3);
    expect(rows[2].path.endsWith("x.py")).toBe(true);
  });

  it("handles an empty tree", () => {
    expect(toRows([])).toEqual([]);
  });
});

describe("visible", () => {
  const rows = toRows(TREE);

  it("shows only the top level when nothing is expanded", () => {
    expect(visible(rows, new Set()).map((r) => r.name))
      .toEqual(["src", "README.md"]);
  });

  it("expanding a folder reveals its direct children", () => {
    expect(visible(rows, new Set(["src"])).map((r) => r.name))
      .toEqual(["src", "utils", "main.py", "README.md"]);
  });

  it("A COLLAPSED GRANDPARENT HIDES THE WHOLE SUBTREE", () => {
    // The parent-only version leaves grandchildren dangling under a closed
    // folder — it looks like a rendering bug and is why this takes paths.
    const openUtilsOnly = new Set(["src/utils"]);
    expect(visible(rows, openUtilsOnly).map((r) => r.name))
      .toEqual(["src", "README.md"]);
  });

  it("shows everything when every folder is open", () => {
    expect(visible(rows, new Set(["src", "src/utils"])).map((r) => r.name))
      .toEqual(TREE.map((i) => i.name));
  });
});

describe("isOpenable", () => {
  it("a file is, a folder is not", () => {
    const rows = toRows(TREE);
    expect(isOpenable(rows.find((r) => r.name === "main.py")!)).toBe(true);
    expect(isOpenable(rows.find((r) => r.name === "src")!)).toBe(false);
  });

  it("an encrypted file is not — the vault holds it sealed", () => {
    const [row] = toRows([file(1, "s.py", null, 0, { encrypted: true })]);
    expect(isOpenable(row)).toBe(false);
  });

  it("a generated file IS openable — a failed compile's log is worth reading", () => {
    const [row] = toRows([file(1, "out.log", null, 0, { readonly: true })]);
    expect(isOpenable(row)).toBe(true);
  });
});
