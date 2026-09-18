import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { defineComponent, h } from "vue";
import EditorHost from "../../src/views/EditorHost.vue";
import ManaConfirm from "../../src/security/ManaConfirm.vue";
import FolderLockModal from "../../src/security/FolderLockModal.vue";
import TagModal from "../../src/files/TagModal.vue";
import { askMana } from "../../src/security/mana";
import { i18n } from "../../src/i18n";
import { useWorkspace } from "petalite/files";

// Security Mana from the page's side: the price is shown BEFORE, the charge
// lands AFTER success, a cancel or a failure costs nothing, and an exhausted
// budget warns without ever blocking. Rust (mocked) prices and keeps the
// ledger; the page only ever names an action and a count.
type Args = Record<string, unknown>;
let left = 100;
let remembered: string | null = null;
const charges: Array<{ action: string; count: number; path: unknown }> = [];
const events: Array<{ event: string; path: unknown }> = [];
const PRICE: Record<string, (n: number) => number> = {
  unlock_temp: () => 5, decrypt_file: () => 15, decrypt_folder: (n) => Math.min(100, 15 + 5 * (n - 1)),
  export_plain: () => 10, tag_sealed: () => 3,
};
const files = new Map<string, { text: string; sealed: boolean; pw?: string }>();
let nextToken = 1;

const invoke = vi.fn(async (cmd: string, a: Args) => {
  const path = a.path as string;
  switch (cmd) {
    case "mana_quote": {
      const cost = PRICE[a.action as string](a.count as number);
      return { action: a.action, count: a.count, cost, dailyMax: 100, weeklyMax: 700, dailyLeft: left, weeklyLeft: 700,
               dailyAfter: Math.max(0, left - cost), weeklyAfter: 700 - cost, exhausted: left === 0 };
    }
    case "mana_charge":
      charges.push({ action: a.action as string, count: a.count as number, path: a.path });
      left = Math.max(0, left - PRICE[a.action as string](a.count as number));
      return { dailyMax: 100, weeklyMax: 700, dailyLeft: left, weeklyLeft: 700, exhausted: left === 0 };
    case "mana_record": events.push({ event: a.event as string, path: a.path }); return null;
    case "secret_status": return { remembered: remembered !== null, storage: remembered ? "memory" : null };
    case "secret_remember": remembered = a.passphrase as string; return "memory";
    case "is_file_locked": return files.get(path)?.sealed ?? false;
    case "sealed_open": {
      const f = files.get(path);
      if (!f?.sealed) throw "not_locked: that file is not encrypted";
      if (((a.password as string | null) ?? remembered) !== f.pw) throw "wrong_password: wrong password or corrupt file";
      return { token: nextToken++, name: path.split("/").pop(), size: f.text.length, text: f.text };
    }
    case "sealed_close": return null;
    case "unlock_file": {
      const f = files.get(path)!;
      if (((a.password as string | null) ?? remembered) !== f.pw) throw "wrong_password: wrong password or corrupt file";
      files.set(path, { text: f.text, sealed: false });
      return { name: "x", size: 1 };
    }
    case "folder_preview": return { files: 4, plain: 0, sealed: 4, links: 0, truncated: false };
    case "folder_lock":
      if (a.password !== "pw") throw "wrong_password: wrong password or corrupt file";
      return { done: a.unlock ? ["a", "b"] : ["a", "b", "c"], skipped: ["d"], untried: [], failed: a.unlock ? [{ path: "c", error: "crypto: damaged" }] : [], links: 0, truncated: false };
    case "tags_get": return ["old"];
    case "tags_set": return (a.tags as string[]).map((t) => t.trim()).filter(Boolean);
    default: throw new Error(`unexpected ${cmd}`);
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...x: [string, Args]) => invoke(...x) }));
const saveDialog = vi.fn();
const writeTextFile = vi.fn(async () => undefined);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: (...a: unknown[]) => saveDialog(...a) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: (...a: unknown[]) => writeTextFile(...(a as [])), writeFile: vi.fn() }));
// jsdom has no canvas: the PNG writer answers what the test says it wrote.
const exportPng = vi.fn(async () => true);
vi.mock("wisteria/sketchExport", () => ({
  exportPng: (...a: unknown[]) => exportPng(...(a as [])),
  backgroundImageFromFile: vi.fn(),
}));

enableAutoUnmount(afterEach);

async function settle() {
  for (let i = 0; i < 8; i++) await flushPromises();
}

/** The host with the app's one confirmation dialog beside it. */
function mountHostWithConfirm() {
  const Both = defineComponent({ render: () => h("div", [h(EditorHost), h(ManaConfirm)]) });
  return mount(Both, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
}
type HostVm = {
  openSealed(n: string, p: string): Promise<boolean>;
  openLocal(n: string, p: string, t: string): void;
  decryptFile(): Promise<boolean>;
  name: string; isSealed: boolean;
};

beforeEach(() => {
  left = 100;
  remembered = null;
  charges.length = 0;
  events.length = 0;
  files.clear();
  nextToken = 1;
  invoke.mockClear();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useWorkspace().root.value = "/w";
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the confirmation dialog", () => {
  it("shows the consequence and the cost first, and answers the user's choice", async () => {
    const w = mount(ManaConfirm, { global: { plugins: [i18n], stubs: { teleport: true } } });
    const pending = askMana("decrypt_file", 1, "secret.md", "mana.consequence.decrypt_file");
    await settle();
    expect(w.get('[data-testid="mana-consequence"]').text()).toContain("rewritten unencrypted on disk");
    expect(w.get('[data-testid="mana-cost"]').text()).toContain("Costs 15 Mana");
    expect(w.get('[data-testid="mana-after"]').text()).toContain("Leaves 85 of 100 for today and 685 of 700");
    expect(w.get('[data-testid="mana-cost"]').text()).toContain("not a security score");
    expect(w.find('[data-testid="mana-exhausted"]').exists()).toBe(false);
    await w.get('[data-testid="mana-cancel"]').trigger("click");
    expect(await pending).toBe(false);
    // Asking charged nothing.
    expect(charges).toEqual([]);
  });

  it("warns when the budget is gone and still lets the action go ahead", async () => {
    left = 0;
    const w = mount(ManaConfirm, { global: { plugins: [i18n], stubs: { teleport: true } } });
    const pending = askMana("unlock_temp", 1, "a.md", "mana.consequence.unlock_temp");
    await settle();
    expect(w.get('[data-testid="mana-exhausted"]').text()).toContain("warning, not a lock");
    expect(w.get('[data-testid="mana-continue"]').attributes("disabled")).toBeUndefined();
    await w.get('[data-testid="mana-continue"]').trigger("click");
    expect(await pending).toBe(true);
  });
});

describe("opening an encrypted file", () => {
  it("with a remembered passphrase: asks for the Mana, charges after opening, and nothing on cancel", async () => {
    remembered = "pw";
    files.set("/w/s.md", { text: "secret", sealed: true, pw: "pw" });
    const w = mountHostWithConfirm();
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;

    let pending = vm.openSealed("s.md", "/w/s.md");
    await settle();
    expect(w.get('[data-testid="mana-consequence"]').text()).toContain("decrypted into memory");
    await w.get('[data-testid="mana-cancel"]').trigger("click");
    expect(await pending).toBe(false);
    expect(invoke.mock.calls.some(([c]) => c === "sealed_open")).toBe(false);
    expect(charges).toEqual([]);

    pending = vm.openSealed("s.md", "/w/s.md");
    await settle();
    await w.get('[data-testid="mana-continue"]').trigger("click");
    expect(await pending).toBe(true);
    expect(charges).toEqual([{ action: "unlock_temp", count: 1, path: "/w/s.md" }]);
    // Charged after the file opened: the order of the calls says so.
    const order = invoke.mock.calls.map(([c]) => c);
    expect(order.indexOf("mana_charge")).toBeGreaterThan(order.indexOf("sealed_open"));
  });

  it("with a typed passphrase: the price is in the passphrase dialog, a wrong passphrase costs nothing", async () => {
    files.set("/w/s.md", { text: "secret", sealed: true, pw: "pw" });
    const w = mountHostWithConfirm();
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    const pending = vm.openSealed("s.md", "/w/s.md");
    await settle();
    // One dialog, carrying both.
    expect(w.find('[data-testid="mana-consequence"]').exists()).toBe(false);
    expect(w.get('[data-testid="lock-consequence"]').text()).toContain("decrypted into memory");
    expect(w.get('[data-testid="mana-cost"]').text()).toContain("Costs 5 Mana");

    await w.get('[data-testid="lock-password"]').setValue("wrong");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(charges).toEqual([]);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(charges).toEqual([{ action: "unlock_temp", count: 1, path: "/w/s.md" }]);
  });
});

describe("decrypting permanently", () => {
  it("charges after the file is decrypted, and a failed decrypt costs nothing", async () => {
    files.set("/w/s.md", { text: "secret", sealed: true, pw: "pw" });
    remembered = "pw";
    const w = mountHostWithConfirm();
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    let pending = vm.openSealed("s.md", "/w/s.md");
    await settle();
    await w.get('[data-testid="mana-continue"]').trigger("click");
    await pending;
    charges.length = 0;

    // The remembered passphrase turns out wrong: the price was confirmed,
    // the decrypt failed over to the passphrase dialog, the user gave up.
    remembered = "stale";
    pending = vm.decryptFile();
    await settle();
    await w.get('[data-testid="mana-continue"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="lock-unlock-hint"]').exists()).toBe(true);
    await w.get('[data-testid="lock-password"]').setValue("nope");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(charges).toEqual([]);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(charges).toEqual([{ action: "decrypt_file", count: 1, path: "/w/s.md" }]);
    expect(vm.isSealed).toBe(false);
  });
});

describe("a folder at a time", () => {
  it("quotes a decrypt by what is encrypted and charges by what was actually decrypted", async () => {
    const w = mount(FolderLockModal, {
      props: { open: false, name: "notes", path: "/w/notes" },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    await w.setProps({ open: true });
    await settle();
    expect(w.get('[data-testid="folder-consequence"]').text()).toContain("cost follows how many files");
    expect(w.get('[data-testid="mana-cost"]').text()).toContain("Costs 30 Mana"); // 4 files quoted

    await w.get('[data-testid="folder-password"]').setValue("wrong");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(charges).toEqual([]);

    await w.get('[data-testid="folder-password"]').setValue("pw");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    // Two decrypted, one failed: two are paid for.
    expect(charges).toEqual([{ action: "decrypt_folder", count: 2, path: "/w/notes" }]);
  });

  it("records an encryption at no cost", async () => {
    invoke.mockImplementationOnce(async () => ({ remembered: false, storage: null }))
      .mockImplementationOnce(async () => ({ files: 3, plain: 3, sealed: 0, links: 0, truncated: false }));
    const w = mount(FolderLockModal, {
      props: { open: false, name: "notes", path: "/w/notes" },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    await w.setProps({ open: true });
    await settle();
    expect(w.find('[data-testid="mana-cost"]').exists()).toBe(false);
    await w.get('[data-testid="folder-password"]').setValue("pw");
    await w.get('[data-testid="folder-confirm"]').setValue("pw");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(charges).toEqual([]);
    expect(events).toEqual([{ event: "encrypt_folder", path: "/w/notes" }]);
  });
});

describe("exporting plaintext", () => {
  it("prices an export from an encrypted file and charges only when a file was written", async () => {
    const App = (await import("../../src/App.vue")).default;
    remembered = "pw";
    files.set("/w/plan.svg", { text: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'/>", sealed: true, pw: "pw" });
    const w = mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    const pending = vm.openSealed("plan.svg", "/w/plan.svg");
    await settle();
    await w.get('[data-testid="mana-continue"]').trigger("click");
    await pending;
    charges.length = 0;

    // The save dialog was cancelled: nothing written, nothing paid.
    exportPng.mockResolvedValueOnce(false);
    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-export"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="mana-consequence"]').text()).toContain("unencrypted copy");
    expect(w.get('[data-testid="mana-cost"]').text()).toContain("Costs 10 Mana");
    await w.get('[data-testid="mana-continue"]').trigger("click");
    await settle();
    expect(exportPng).toHaveBeenCalledTimes(1);
    expect(charges).toEqual([]);

    // Written this time: paid.
    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-export"]').trigger("click");
    await settle();
    await w.get('[data-testid="mana-continue"]').trigger("click");
    await settle();
    expect(charges).toEqual([{ action: "export_plain", count: 1, path: "/w/plan.svg" }]);

    // Declined at the price: the export never runs.
    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-export"]').trigger("click");
    await settle();
    await w.get('[data-testid="mana-cancel"]').trigger("click");
    await settle();
    expect(exportPng).toHaveBeenCalledTimes(2);
  });

  it("says a failed export in the header, charges nothing, and clears it when a file is opened again", async () => {
    const App = (await import("../../src/App.vue")).default;
    const { dumps, newWorkbook } = await import("../../src/formats/sheet");
    saveDialog.mockResolvedValue("/elsewhere/b.csv");
    writeTextFile.mockRejectedValueOnce(new Error("disk full"));
    const w = mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    const book = dumps(newWorkbook("b"));
    vm.openLocal("b.json", "/w/b.json", book);
    await settle();
    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-export"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="export-error"]').text()).toBe("Could not export. disk full");
    expect(charges).toEqual([]);

    // The same file opened again is another open: the complaint goes.
    vm.openLocal("b.json", "/w/b.json", book);
    await settle();
    expect(w.find('[data-testid="export-error"]').exists()).toBe(false);
    saveDialog.mockReset();
  });

  it("is free from a plain file, which was never protected", async () => {
    const App = (await import("../../src/App.vue")).default;
    const w = mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    vm.openLocal("plan.svg", "/w/plan.svg", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'/>");
    await settle();
    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-export"]').trigger("click");
    await settle();
    expect(w.find('[data-testid="mana-consequence"]').exists()).toBe(false);
    expect(exportPng).toHaveBeenCalled();
    expect(charges).toEqual([]);
  });
});

describe("tags on an encrypted file", () => {
  function mountTags(sealed: boolean) {
    return mount(TagModal, {
      props: { open: false, name: "s.md", path: "/w/s.md", sealed },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
  }

  it("prices a new word, charges after saving, and charges nothing for keeping or removing words", async () => {
    const w = mountTags(true);
    await w.setProps({ open: true });
    await settle();
    expect(w.get('[data-testid="tags-consequence"]').text()).toContain("a word about it in plain text");
    expect(w.get('[data-testid="mana-cost"]').text()).toContain("Costs 3 Mana");
    // Keeping what was there: free.
    await w.get('[data-testid="tags-save"]').trigger("click");
    await settle();
    expect(charges).toEqual([]);

    await w.setProps({ open: false });
    await w.setProps({ open: true });
    await settle();
    await w.get('[data-testid="tag-field-1"]').setValue("new");
    await w.get('[data-testid="tags-save"]').trigger("click");
    await settle();
    expect(charges).toEqual([{ action: "tag_sealed", count: 1, path: "/w/s.md" }]);
  });

  it("costs nothing on a plain file", async () => {
    const w = mountTags(false);
    await w.setProps({ open: true });
    await settle();
    expect(w.find('[data-testid="mana-cost"]').exists()).toBe(false);
    await w.get('[data-testid="tag-field-1"]').setValue("new");
    await w.get('[data-testid="tags-save"]').trigger("click");
    await settle();
    expect(charges).toEqual([]);
  });
});
