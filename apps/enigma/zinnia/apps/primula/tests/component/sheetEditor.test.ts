import { beforeAll, describe, expect, it, vi } from "vitest";
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

/** Univer mounts after a size check and three dynamic imports; drain until it
 *  settles.
 *
 *  `flushPromises` alone is not enough: it drains microtasks, and loading a
 *  module the suite has not touched yet takes a real tick. The first grid in a
 *  run therefore finished AFTER its test had ended while later ones — warm —
 *  succeeded, which reads as a flake that follows test order. The timeout yield
 *  is what makes cold and warm behave the same. */
async function settle() {
  for (let i = 0; i < 12; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Drain until `ok()` holds, rather than for a fixed number of ticks.
 *
 *  A count is a guess about how long three module loads and a mount take, and
 *  that guess is wrong under a loaded parallel run — which is how a grid test
 *  passes alone and fails in the full suite. Waiting on the condition removes
 *  the guess; the cap only stops a genuine hang from running forever. */
async function waitFor(ok: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (ok()) return;
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Load what `mountUniver` will reach for, once, before any test mounts a grid.
 *
 *  Without this the FIRST grid in a run waits on three cold module loads and is
 *  still pending when its test ends, while every later one — warm — succeeds.
 *  That is a race whose symptom is a failure that moves with test order and
 *  with how loaded the machine is: green alone, red in the full suite. */
beforeAll(async () => {
  await Promise.all([
    import("@univerjs/presets"),
    import("@univerjs/preset-sheets-core"),
    import("@univerjs/preset-sheets-core/locales/en-US"),
  ]);
});

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

/** Give every element a real box for the duration of one test.
 *
 *  `mountUniver` waits for a non-zero box before creating the grid — a flex
 *  child measured in the tick it was inserted has not been laid out, and Univer
 *  computes a negative column width from a zero-width container. jsdom lays
 *  nothing out, so without this the wait times out and the grid is NEVER
 *  created: every assertion about Univer's lifecycle would pass vacuously. */
function withLayout<T>(run: () => Promise<T>): Promise<T> {
  const el = HTMLElement.prototype;
  const w = Object.getOwnPropertyDescriptor(el, "clientWidth");
  const h = Object.getOwnPropertyDescriptor(el, "clientHeight");
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => 1280 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 720 });
  const restore = () => {
    if (w) Object.defineProperty(el, "clientWidth", w); else delete (el as never)["clientWidth" as never];
    if (h) Object.defineProperty(el, "clientHeight", h); else delete (el as never)["clientHeight" as never];
  };
  return run().finally(restore);
}

/** Whether this editor really has a live grid, read off its own state rather
 *  than inferred from the absence of an error. */
function gridsAlive(w: ReturnType<typeof mountSheet>): boolean {
  return Boolean((w.vm as unknown as { $: { setupState: { api: unknown } } }).$.setupState.api);
}

describe("the grid's lifecycle", () => {
  // These are the only tests in this file that exercise Univer at all. The
  // others assert the snapshot contract, which the `pending` fallback answers
  // whether or not a grid exists — so before `withLayout` they were passing
  // with no grid ever created, and nothing here would have caught a leak.

  it("creates a grid when the box is real", async () => withLayout(async () => {
    // The guard for the guard: if this fails, `hasSize` timed out and every
    // other assertion in this block is measuring nothing.
    const w = mountSheet(read("rich.json"));
    await waitFor(() => gridsAlive(w));
    expect(w.find('[data-testid="sheet-mount-error"]').exists()).toBe(false);
    expect(gridsAlive(w)).toBe(true);
    w.unmount();
  }));

  it("disposes it on unmount, so a closed file keeps nothing alive", async () => withLayout(async () => {
    // The host remounts this editor per file (`:key="'s' + generation"`), so
    // unmount IS the file-switch path: a grid that survived it would hold the
    // old workbook and its listeners for the life of the tab.
    const { stats } = await import("@univerjs/presets") as unknown as { stats: { disposed: number } };
    const before = stats.disposed;
    const w = mountSheet(read("rich.json"));
    await waitFor(() => gridsAlive(w));
    expect(stats.disposed).toBe(before);
    w.unmount();
    await waitFor(() => stats.disposed > before);
    expect(stats.disposed).toBe(before + 1);
  }));
});
