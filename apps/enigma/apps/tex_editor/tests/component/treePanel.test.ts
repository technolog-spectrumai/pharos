// The tree panel. Thin over `rows.ts`, so what is tested here is the wiring the
// pure module cannot see: expansion, and which row reads as current.
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { TreeItem } from "totoapi";
import TreePanel from "../../src/files/TreePanel.vue";

function dir(id: number, name: string, pid: number | null, depth: number): TreeItem {
  return { t: "dir", id, pid, depth, name };
}
function file(id: number, name: string, pid: number | null, depth: number): TreeItem {
  return { t: "file", id, pid, depth, name };
}

/** A REAL SERVER SHAPE, ids and all: `dir 2` and `file 2` both exist, because
 *  VaultDirectory and VaultFile are separate tables with separate sequences. */
const ITEMS: TreeItem[] = [
  dir(1, "outer", null, 0),
  dir(2, "inner", 1, 1),
  file(2, "deep.py", 2, 2),
  file(1, "top.py", null, 0),
];

function render(activeId: number | null = null) {
  return mount(TreePanel, {
    props: { items: ITEMS, activeId },
    global: { stubs: { "font-awesome-icon": true } },
  });
}

describe("what it draws", () => {
  it("shows the top level collapsed", () => {
    const text = render().text();
    expect(text).toContain("outer");
    expect(text).toContain("top.py");
    expect(text).not.toContain("deep.py");
  });

  it("emits open for a file, not for a folder", async () => {
    const panel = render();
    const rows = panel.findAll("[data-testid^='tree-']");
    const folder = rows.find((r) => r.text().includes("outer"))!;
    await folder.trigger("click");
    expect(panel.emitted("open")).toBeUndefined();
    // …and the folder expanded instead.
    expect(panel.text()).toContain("inner");
  });

  it("emits open with the row, carrying the server id", async () => {
    const panel = render();
    const top = panel.findAll("[data-testid^='tree-']")
      .find((r) => r.text().includes("top.py"))!;
    await top.trigger("click");
    const emitted = panel.emitted("open") as Array<[{ id: number; name: string }]>;
    expect(emitted[0][0].id).toBe(1);
    expect(emitted[0][0].name).toBe("top.py");
  });
});

describe("the active row", () => {
  it("A FOLDER SHARING THE FILE'S ID IS NOT HIGHLIGHTED", async () => {
    // The bug this fixture exists for. `activeId: 2` means FILE 2 — but
    // `dir 2` also exists, and a lookup by id alone matched whichever came
    // first in the list, which is the folder. It showed the wrong row as open.
    //
    // FileTree marks the active row with `font-bold`, so that is what this
    // reads: which ROW carries it, not which path was computed.
    const panel = render(2);
    const folder = panel.findAll("[data-testid^='tree-']")
      .find((r) => r.text().includes("outer"))!;
    await folder.trigger("click");
    const inner = panel.findAll("[data-testid^='tree-']")
      .find((r) => r.text().includes("inner"))!;
    await inner.trigger("click");

    const bold = panel.findAll("[data-testid^='tree-']")
      .filter((r) => r.attributes("class")?.includes("font-bold"))
      .map((r) => r.text().trim());
    expect(bold, "the wrong row is marked as open").toEqual(["deep.py"]);
  });
});

describe("expansion", () => {
  beforeEach(() => { /* fresh component per test */ });

  it("a collapsed grandparent hides the whole subtree", async () => {
    const panel = render();
    const folder = panel.findAll("[data-testid^='tree-']")
      .find((r) => r.text().includes("outer"))!;
    await folder.trigger("click");
    expect(panel.text()).toContain("inner");
    expect(panel.text()).not.toContain("deep.py");
  });

  it("clicking a folder twice collapses it again", async () => {
    const panel = render();
    const folder = () => panel.findAll("[data-testid^='tree-']")
      .find((r) => r.text().includes("outer"))!;
    await folder().trigger("click");
    expect(panel.text()).toContain("inner");
    await folder().trigger("click");
    expect(panel.text()).not.toContain("inner");
  });

  it("changing workspace resets the expansion", async () => {
    // Otherwise folders from the last workspace stay "open" and the first
    // render of the new tree is arbitrary.
    const panel = render();
    const folder = panel.findAll("[data-testid^='tree-']")
      .find((r) => r.text().includes("outer"))!;
    await folder.trigger("click");
    expect(panel.text()).toContain("inner");
    await panel.setProps({ items: [dir(9, "fresh", null, 0)] });
    await panel.setProps({ items: ITEMS });
    expect(panel.text()).not.toContain("inner");
  });
});
