// The CSV table modal.
//
// The parsing itself is petalite's and tested there; what this pins is the
// modal's own judgement — what it previews, when it refuses, and what shape it
// hands the editor. Those are the parts a wrong delimiter or an oversized
// paste reaches the document through.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import CsvTableModal from "../../src/editors/CsvTableModal.vue";
import { i18n } from "../../src/i18n";

afterEach(() => {
  // doMock is per-module-registry; reset so one test's stub cannot leak into
  // the next, which would make the failure case pass for the wrong reason.
  vi.resetModules();
  vi.doUnmock("@tauri-apps/plugin-dialog");
  vi.doUnmock("@tauri-apps/plugin-fs");
});

function open() {
  return mount(CsvTableModal, {
    props: { open: true },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

async function paste(w: ReturnType<typeof open>, text: string) {
  await w.get('[data-testid="csv-input"]').setValue(text);
  await flushPromises();
}

/** The payload the editor would receive, or null if Insert never fired. */
function inserted(w: ReturnType<typeof open>) {
  const events = w.emitted("insert");
  return events ? (events[0][0] as { rows: string[][]; withHeaderRow: boolean }) : null;
}

describe("the CSV table modal", () => {
  it("will not insert until something parses", async () => {
    const w = open();
    expect(w.get('[data-testid="csv-insert"]').attributes("disabled")).toBeDefined();
    await paste(w, "a,b\n1,2");
    expect(w.get('[data-testid="csv-insert"]').attributes("disabled")).toBeUndefined();
  });

  it("hands the editor the parsed grid", async () => {
    const w = open();
    await paste(w, "name,qty\nWidget,3");
    await w.get('[data-testid="csv-insert"]').trigger("click");
    expect(inserted(w)?.rows).toEqual([
      ["name", "qty"],
      ["Widget", "3"],
    ]);
  });

  it("keeps a quoted comma in one cell", async () => {
    // The case the whole parser exists for, asserted here too because this is
    // the path the document actually gets its data through.
    const w = open();
    await paste(w, 'name,note\n"Smith, John",ok');
    await w.get('[data-testid="csv-insert"]').trigger("click");
    expect(inserted(w)?.rows[1]).toEqual(["Smith, John", "ok"]);
  });

  it("passes the header choice through", async () => {
    const w = open();
    await paste(w, "a,b\n1,2");
    await w.get('[data-testid="csv-header"]').setValue(false);
    await w.get('[data-testid="csv-insert"]').trigger("click");
    expect(inserted(w)?.withHeaderRow).toBe(false);
  });

  it("previews the grid, so a wrong separator is visible first", async () => {
    // The reason the preview exists: a semicolon file read as comma-separated
    // is one wide column, and that is obvious in a preview and invisible in a
    // textarea.
    const w = open();
    await paste(w, "a;b;c\n1;2;3");
    const cells = w.findAll('[data-testid="csv-preview"] td');
    expect(cells).toHaveLength(6); // 2 rows x 3 columns, not 2 x 1
    expect(cells[0].text()).toBe("a");
  });

  it("lets the separator be overridden when the guess is wrong", async () => {
    const w = open();
    await paste(w, "a;b");
    await w.get('[data-testid="csv-delimiter"]').setValue(",");
    await w.get('[data-testid="csv-insert"]').trigger("click");
    expect(inserted(w)?.rows).toEqual([["a;b"]]);
  });

  it("refuses an oversized paste instead of truncating it", async () => {
    // Silently inserting the first 200 rows would look like a complete import
    // and be a lie. The message names the limit.
    const w = open();
    await paste(w, Array.from({ length: 250 }, (_u, i) => `${i},x`).join("\n"));
    expect(w.find('[data-testid="csv-too-big"]').exists()).toBe(true);
    expect(w.get('[data-testid="csv-insert"]').attributes("disabled")).toBeDefined();
  });

  it("refuses too many columns as well as too many rows", async () => {
    const w = open();
    await paste(w, Array.from({ length: 60 }, (_u, i) => `c${i}`).join(","));
    expect(w.find('[data-testid="csv-too-big"]').exists()).toBe(true);
  });

  it("starts empty each time it opens", async () => {
    // A previous paste still sitting in the box is confusing when the intent
    // was to load a file.
    const w = open();
    await paste(w, "stale,data");
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    await flushPromises();
    expect((w.get('[data-testid="csv-input"]').element as HTMLTextAreaElement).value).toBe("");
  });

  it("loads a file into the box", async () => {
    // The dialog and fs plugins are MOCKED rather than left to fail in jsdom.
    // An earlier version of this test leaned on the real import rejecting and
    // waited for it with a timer — which passed alone and failed in the full
    // run, because a dynamic import settles on a macrotask and the race is not
    // ours to win. Mocking states the intent instead of timing it.
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ open: async () => "/tmp/x.csv" }));
    vi.doMock("@tauri-apps/plugin-fs", () => ({ readTextFile: async () => "a,b\n1,2" }));
    const w = open();
    await w.get('[data-testid="csv-load"]').trigger("click");
    await vi.waitFor(() =>
      expect((w.get('[data-testid="csv-input"]').element as HTMLTextAreaElement).value)
        .toBe("a,b\n1,2"));
    expect(w.find('[data-testid="csv-preview"]').exists()).toBe(true);
  });

  it("says why loading a file failed rather than doing nothing", async () => {
    // A denied read, a cancelled dialog that throws, a browser build with no
    // plugin at all — all the same shape, and all of them must say something
    // rather than leave a button that appears to do nothing.
    vi.doMock("@tauri-apps/plugin-dialog", () => ({
      open: async () => { throw new Error("permission denied"); },
    }));
    const w = open();
    await w.get('[data-testid="csv-load"]').trigger("click");
    await vi.waitFor(() => expect(w.find('[data-testid="csv-error"]').exists()).toBe(true));
    expect(w.get('[data-testid="csv-error"]').text()).toContain("permission denied");
  });
});
