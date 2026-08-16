import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import SheetEditor from "../../src/editors/SheetEditor.vue";
import { i18n } from "../../src/i18n";
import { dumps, loads, newWorkbook } from "../../src/formats/sheet";

const GOLDEN = join(__dirname, "..", "golden", "sheet");
const read = (f: string) => readFileSync(join(GOLDEN, f), "utf8");

function mountSheet(content: string, name = "book.json") {
  return mount(SheetEditor, {
    props: { path: "/tmp/book.json", name, content },
    global: { plugins: [i18n, createPinia()] },
  });
}
const vmOf = (w: ReturnType<typeof mountSheet>) =>
  w.vm as unknown as { getContent(): string; isDirty(): boolean; markSaved(): void };

describe("the sheet editor", () => {
  it("mounts the grid for a workbook", async () => {
    const w = mountSheet(read("rich.json"));
    await flushPromises();
    expect(w.find('[data-testid="univer-host"]').exists()).toBe(true);
    expect(w.find('[data-testid="sheet-open-text"]').exists()).toBe(false);
  });

  it("opens without dirtying, and hands back what it was given", async () => {
    // Snapshot in, snapshot out: the round trip must not disturb styling,
    // merges, freeze panes or keys a newer Univer wrote.
    const xml = read("rich.json");
    const w = mountSheet(xml);
    await flushPromises();
    expect(vmOf(w).isDirty()).toBe(false);
    expect(vmOf(w).getContent()).toBe(xml);
  });

  it("seeds a blank workbook when the buffer is empty", async () => {
    const w = mountSheet("", "budget.json");
    await flushPromises();
    const wb = loads(vmOf(w).getContent());
    expect(wb.sheetOrder).toHaveLength(1);
    expect(wb.name).toBe("budget"); // the extension is stripped for the title
  });

  it("offers plain text for JSON that is not a workbook", async () => {
    const w = mountSheet('{"name": "package", "version": "1.0.0"}');
    await flushPromises();
    expect(w.find('[data-testid="sheet-open-text"]').exists()).toBe(true);
    expect(w.emitted("open-as-text")).toBeUndefined();
    await w.get('[data-testid="sheet-open-text"]').trigger("click");
    expect(w.emitted("open-as-text")).toBeTruthy();
  });

  it("implements the contract the host holds it by", async () => {
    const w = mountSheet(dumps(newWorkbook("x")));
    await flushPromises();
    const vm = vmOf(w);
    expect(typeof vm.markSaved).toBe("function");
    expect(typeof vm.getContent).toBe("function");
    expect(typeof vm.isDirty).toBe("function");
    vm.markSaved();
    expect(vm.isDirty()).toBe(false);
  });

  it("shows the host's save error through the error prop", async () => {
    const w = mount(SheetEditor, {
      props: { path: null, name: "x.json", content: "", error: "disk full" },
      global: { plugins: [i18n, createPinia()] },
    });
    await flushPromises();
    expect(w.text()).toContain("disk full");
  });
});

describe("the host routes .json by content", () => {
  it("tells a workbook from an ordinary json file", async () => {
    const { isSheet } = await import("../../src/formats/sheet");
    expect(isSheet(read("blank.json"))).toBe(true);
    expect(isSheet('{"compilerOptions": {}}')).toBe(false);
  });
});
