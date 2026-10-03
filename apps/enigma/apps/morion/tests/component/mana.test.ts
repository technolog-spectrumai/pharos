import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { defineComponent, h } from "vue";
import EditorHost from "../../src/views/EditorHost.vue";
import ManaConfirm from "../../src/security/ManaConfirm.vue";
import ManaPrompt from "../../src/security/ManaPrompt.vue";
import FolderLockModal from "../../src/security/FolderLockModal.vue";
import TagModal from "../../src/files/TagModal.vue";
import {
  askMana, formatMana, manaPrices, manaPrompt, manaStatus, perHour, type ManaStatus,
} from "../../src/security/mana";
import { i18n } from "../../src/i18n";
import { useWorkspace } from "petalite/files";

// Security Mana from the page's side. Plain files drain it by the
// kilobyte-hour and it regenerates — all of that is Rust's (mocked here). What
// is pinned: nothing the page does charges Mana any more; dialogs that leave
// plaintext behind say what it will cost an hour, and ones that remove it say
// what it saves; a passphrase change is credited by Rust and said; and an
// empty bar asks for some encryption without ever blocking.
type Args = Record<string, unknown>;
let remembered: string | null = null;
let status: ManaStatus;
const events: Array<{ event: string; path: unknown }> = [];
const files = new Map<string, { text: string; sealed: boolean; pw?: string }>();
let nextToken = 1;

function makeStatus(over: Partial<ManaStatus> = {}): ManaStatus {
  return {
    max: 100, level: 72, drainPerHour: 1.5, regenPerHour: 1, netPerHour: -0.5,
    plainFiles: 3, plainBytes: 150 * 1024, exhausted: false, top: [], truncated: false, deep: false, kept: true, ...over,
  };
}

const invoke = vi.fn(async (cmd: string, a: Args) => {
  const path = a.path as string;
  switch (cmd) {
    case "mana_status": return status;
    case "mana_prices": return { max: 100, perKbHour: 0.01, regenPerHour: 1, rekeyReward: 10, rekeyCooldownHours: 24, rekeyDailyCap: 30 };
    case "mana_rate":
      return { plainFiles: 1, plainBytes: 20 * 1024, plainPerHour: 0.2, sealedFiles: 2, sealedBytes: 30 * 1024, sealedPerHour: 0.3 };
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
    case "lock_file": {
      const f = files.get(path)!;
      files.set(path, { text: f.text, sealed: true, pw: a.password as string });
      return { name: "x", size: 1 };
    }
    case "unlock_file": {
      const f = files.get(path)!;
      if (((a.password as string | null) ?? remembered) !== f.pw) throw "wrong_password: wrong password or corrupt file";
      files.set(path, { text: f.text, sealed: false });
      return { name: "x", size: 1 };
    }
    case "rekey_file": {
      const f = files.get(path)!;
      if (((a.password as string | null) ?? remembered) !== f.pw) throw "wrong_password: wrong password or corrupt file";
      f.pw = a.newPassword as string;
      return { gained: 10 };
    }
    case "files_lock":
      if (!a.password) throw "no_passphrase: no password";
      return { done: (a.paths as string[]).map((p) => p.replace("/w/", "")), skipped: [], untried: [], failed: [], links: 0, truncated: false };
    case "folder_preview": return { files: 4, plain: 0, sealed: 4, links: 0, truncated: false };
    case "folder_lock":
      if (a.password !== "pw") throw "wrong_password: wrong password or corrupt file";
      return { done: a.unlock ? ["a", "b"] : ["a", "b", "c"], skipped: ["d"], untried: [], failed: [], links: 0, truncated: false };
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
const called = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);
/** Anything that would still be spending Mana the old way. */
const charges = () => invoke.mock.calls.filter(([c]) => c === "mana_charge" || c === "mana_quote");

/** The host with the app's one confirmation dialog beside it. */
function mountHostWithConfirm() {
  const Both = defineComponent({ render: () => h("div", [h(EditorHost), h(ManaConfirm)]) });
  return mount(Both, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
}
type HostVm = {
  openSealed(n: string, p: string): Promise<boolean>;
  openLocal(n: string, p: string, t: string): void;
  encryptFile(): Promise<boolean>;
  decryptFile(): Promise<boolean>;
  changePassphrase(): Promise<boolean>;
  name: string; isSealed: boolean; notice: string;
};

beforeEach(() => {
  remembered = null;
  status = makeStatus();
  manaStatus.value = status;
  manaPrompt.value = null;
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

describe("the numbers", () => {
  it("prices a row by the kilobyte-hour, with the price Rust gave", () => {
    const prices = { max: 100, perKbHour: 0.01, regenPerHour: 1, rekeyReward: 10, rekeyCooldownHours: 24, rekeyDailyCap: 30 };
    expect(perHour(4096, prices)).toBeCloseTo(0.04);
    expect(perHour(512, prices)).toBeCloseTo(0.005);
    expect(perHour(4096, null)).toBe(null);
  });

  it("writes a rate short, and never rounds a real cost down to nothing", () => {
    expect(formatMana(0)).toBe("0");
    expect(formatMana(0.004)).toBe("<0.01");
    expect(formatMana(0.04)).toBe("0.04");
    expect(formatMana(1.5)).toBe("1.5");
    expect(formatMana(12.34)).toBe("12.3");
    expect(formatMana(250.4)).toBe("250");
    expect(formatMana(-0.5)).toBe("−0.5");
  });
});

describe("the confirmation dialog", () => {
  it("says what the plaintext will cost an hour and answers the user's choice", async () => {
    const w = mount(ManaConfirm, { global: { plugins: [i18n], stubs: { teleport: true } } });
    const pending = askMana("secret.md", "mana.consequence.decrypt_file", 0.3);
    await settle();
    expect(w.get('[data-testid="mana-consequence"]').text()).toContain("rewritten unencrypted on disk");
    expect(w.get('[data-testid="mana-rate"]').text()).toContain("Adds about 0.3 Mana an hour");
    expect(w.get('[data-testid="mana-now"]').text()).toContain("Now 72 of 100. Plain files use 1.5 an hour; Mana comes back at 1 an hour.");
    expect(w.get('[data-testid="mana-cost"]').text()).toContain("not a security score");
    await w.get('[data-testid="mana-cancel"]').trigger("click");
    expect(await pending).toBe(false);
  });

  it("warns at zero and still lets the action go ahead", async () => {
    manaStatus.value = makeStatus({ level: 0, exhausted: true });
    const w = mount(ManaConfirm, { global: { plugins: [i18n], stubs: { teleport: true } } });
    const pending = askMana("a.md", "mana.consequence.decrypt_file", 0.3);
    await settle();
    expect(w.get('[data-testid="mana-exhausted"]').text()).toContain("advice, not a lock");
    expect(w.get('[data-testid="mana-continue"]').attributes("disabled")).toBeUndefined();
    await w.get('[data-testid="mana-continue"]').trigger("click");
    expect(await pending).toBe(true);
  });
});

describe("opening an encrypted file", () => {
  it("costs nothing and asks nothing about Mana: the disk stays encrypted", async () => {
    files.set("/w/s.md", { text: "secret", sealed: true, pw: "pw" });
    const w = mountHostWithConfirm();
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    const pending = vm.openSealed("s.md", "/w/s.md");
    await settle();
    expect(w.find('[data-testid="mana-cost"]').exists()).toBe(false);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);

    // Remembered: straight in, no dialog of any kind.
    remembered = "pw";
    expect(await vm.openSealed("s.md", "/w/s.md")).toBe(true);
    expect(w.find('[data-testid="mana-consequence"]').exists()).toBe(false);
    expect(charges()).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("encrypting and decrypting the open file", () => {
  it("says what encrypting saves, and records it", async () => {
    files.set("/w/n.md", { text: "plain", sealed: false });
    const w = mountHostWithConfirm();
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    vm.openLocal("n.md", "/w/n.md", "plain");
    await settle();
    const pending = vm.encryptFile();
    await settle();
    expect(w.get('[data-testid="mana-rate"]').text()).toContain("Saves 0.2 Mana an hour");
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-confirm"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(events).toEqual([{ event: "encrypt_file", path: "/w/n.md" }]);
    expect(called("mana_status").length).toBeGreaterThan(0);
  });

  it("says what decrypting adds before the file is written, and records only what happened", async () => {
    files.set("/w/s.md", { text: "secret", sealed: true, pw: "pw" });
    remembered = "pw";
    const w = mountHostWithConfirm();
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    await vm.openSealed("s.md", "/w/s.md");

    // The remembered passphrase turns out wrong: confirmed, failed over to
    // the passphrase dialog, which says the same rate.
    remembered = "stale";
    const pending = vm.decryptFile();
    await settle();
    expect(w.get('[data-testid="mana-rate"]').text()).toContain("Adds about 0.3 Mana an hour");
    await w.get('[data-testid="mana-continue"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="lock-unlock-hint"]').exists()).toBe(true);
    expect(w.get('[data-testid="mana-rate"]').text()).toContain("Adds about 0.3");
    await w.get('[data-testid="lock-password"]').setValue("nope");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(events).toEqual([]);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(events).toEqual([{ event: "decrypt_file", path: "/w/s.md" }]);
    expect(vm.isSealed).toBe(false);
    expect(charges()).toEqual([]);
  });
});

describe("changing a passphrase", () => {
  async function openSealedHost() {
    files.set("/w/s.md", { text: "secret", sealed: true, pw: "old" });
    const w = mountHostWithConfirm();
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    const opening = vm.openSealed("s.md", "/w/s.md");
    await settle();
    await w.get('[data-testid="lock-password"]').setValue("old");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    await opening;
    return { w, vm };
  }

  it("asks for the current passphrase and a new one twice, and says what it earned", async () => {
    const { w, vm } = await openSealedHost();
    const pending = vm.changePassphrase();
    await settle();
    expect(w.get('[data-testid="lock-rekey-hint"]').text()).toContain("new key");
    expect(w.find('[data-testid="mana-cost"]').exists()).toBe(false);

    // Checked before anything is sent: a mismatch, then the same passphrase.
    await w.get('[data-testid="lock-password"]').setValue("old");
    await w.get('[data-testid="lock-new"]').setValue("new");
    await w.get('[data-testid="lock-confirm"]').setValue("neu");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="lock-error"]').text()).toBe("Those two do not match.");
    await w.get('[data-testid="lock-password"]').setValue("old");
    await w.get('[data-testid="lock-new"]').setValue("old");
    await w.get('[data-testid="lock-confirm"]').setValue("old");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="lock-error"]').text()).toContain("same as the current one");
    // A wrong current passphrase is Rust's to refuse, and earns nothing.
    await w.get('[data-testid="lock-password"]').setValue("guess");
    await w.get('[data-testid="lock-new"]').setValue("new");
    await w.get('[data-testid="lock-confirm"]').setValue("new");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="lock-error"]').text()).toContain("Wrong password");
    expect(vm.notice).toBe("");

    await w.get('[data-testid="lock-password"]').setValue("old");
    await w.get('[data-testid="lock-new"]').setValue("new");
    await w.get('[data-testid="lock-confirm"]').setValue("new");
    await w.get('[data-testid="lock-remember"]').setValue(true);
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(called("rekey_file").at(-1)?.[1]).toEqual({ path: "/w/s.md", password: "old", newPassword: "new" });
    expect(vm.notice).toBe("Passphrase changed: +10 Security Mana.");
    expect(remembered).toBe("new");
    expect(files.get("/w/s.md")?.pw).toBe("new");
    // The session was moved along by Rust: the host still holds the file.
    expect(vm.isSealed).toBe(true);
    expect(called("sealed_close")).toEqual([]);
  });

  it("says so when the change earned nothing", async () => {
    const { w, vm } = await openSealedHost();
    invoke.mockImplementationOnce(async () => ({ gained: 0 }));
    const pending = vm.changePassphrase();
    await settle();
    await w.get('[data-testid="lock-password"]').setValue("old");
    await w.get('[data-testid="lock-new"]').setValue("new");
    await w.get('[data-testid="lock-confirm"]').setValue("new");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(vm.notice).toContain("No Mana this time");
  });
});

describe("the shield beside the open file", () => {
  it("says what a plain file costs an hour, and offers a passphrase change for an encrypted one", async () => {
    const App = (await import("../../src/App.vue")).default;
    files.set("/w/s.md", { text: "secret", sealed: true, pw: "old" });
    remembered = "old";
    const w = mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    vm.openLocal("n.md", "/w/n.md", "plain");
    await settle();
    await w.get('[data-testid="file-shield"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="file-shield-rate"]').text()).toBe("Uses 0.2 Security Mana an hour while it is not encrypted");
    expect(w.find('[data-testid="file-shield-rekey"]').exists()).toBe(false);
    await w.get('[data-testid="file-shield"]').trigger("click");

    await vm.openSealed("s.md", "/w/s.md");
    await settle();
    await w.get('[data-testid="file-shield"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="file-shield-rate"]').text()).toBe("Encrypted: uses no Security Mana.");
    await w.get('[data-testid="file-shield-rekey"]').trigger("click");
    await settle();
    expect(w.find('[data-testid="file-shield-panel"]').exists()).toBe(false);
    await w.get('[data-testid="lock-password"]').setValue("old");
    await w.get('[data-testid="lock-new"]').setValue("new");
    await w.get('[data-testid="lock-confirm"]').setValue("new");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(called("rekey_file")).toHaveLength(1);
    expect(w.text()).toContain("Passphrase changed: +10 Security Mana.");
  });
});

describe("a folder at a time", () => {
  it("says what decrypting adds, and records only a run that did something", async () => {
    const w = mount(FolderLockModal, {
      props: { open: false, name: "notes", path: "/w/notes" },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    await w.setProps({ open: true });
    await settle();
    expect(w.get('[data-testid="folder-consequence"]').text()).toContain("uses Security Mana until it is encrypted again");
    expect(w.get('[data-testid="mana-rate"]').text()).toContain("Adds about 0.3");

    await w.get('[data-testid="folder-password"]').setValue("wrong");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(events).toEqual([]);

    await w.get('[data-testid="folder-password"]').setValue("pw");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(events).toEqual([{ event: "decrypt_folder", path: "/w/notes" }]);
    expect(charges()).toEqual([]);
  });

  it("says what encrypting saves", async () => {
    invoke.mockImplementationOnce(async () => ({ remembered: false, storage: null }))
      .mockImplementationOnce(async () => ({ files: 3, plain: 3, sealed: 0, links: 0, truncated: false }));
    const w = mount(FolderLockModal, {
      props: { open: false, name: "notes", path: "/w/notes" },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    await w.setProps({ open: true });
    await settle();
    expect(w.get('[data-testid="mana-rate"]').text()).toContain("Saves 0.2 Mana an hour");
    await w.get('[data-testid="folder-password"]').setValue("pw");
    await w.get('[data-testid="folder-confirm"]').setValue("pw");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(events).toEqual([{ event: "encrypt_folder", path: "/w/notes" }]);
  });
});

describe("exporting plaintext", () => {
  it("says what an export from an encrypted file does, and runs it only on Continue", async () => {
    const App = (await import("../../src/App.vue")).default;
    remembered = "pw";
    files.set("/w/plan.svg", { text: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'/>", sealed: true, pw: "pw" });
    const w = mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
    await flushPromises();
    const vm = w.findComponent(EditorHost).vm as unknown as HostVm;
    await vm.openSealed("plan.svg", "/w/plan.svg");
    await settle();

    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-export"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="mana-consequence"]').text()).toContain("unencrypted copy");
    expect(w.find('[data-testid="mana-cost"]').exists()).toBe(false);
    await w.get('[data-testid="mana-cancel"]').trigger("click");
    await settle();
    expect(exportPng).not.toHaveBeenCalled();

    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-export"]').trigger("click");
    await settle();
    await w.get('[data-testid="mana-continue"]').trigger("click");
    await settle();
    expect(exportPng).toHaveBeenCalledTimes(1);
    expect(charges()).toEqual([]);
  });

  it("says a failed export in the header, and clears it when a file is opened again", async () => {
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

    // The same file opened again is another open: the complaint goes.
    vm.openLocal("b.json", "/w/b.json", book);
    await settle();
    expect(w.find('[data-testid="export-error"]').exists()).toBe(false);
    saveDialog.mockReset();
  });

  it("asks nothing for a plain file, which was never protected", async () => {
    const App = (await import("../../src/App.vue")).default;
    exportPng.mockClear();
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
  });
});

describe("tags", () => {
  it("cost nothing, encrypted file or not; the plain-text warning stays", async () => {
    const w = mount(TagModal, {
      props: { open: false, name: "s.md", path: "/w/s.md", sealed: true },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    await w.setProps({ open: true });
    await settle();
    expect(w.find('[data-testid="mana-cost"]').exists()).toBe(false);
    expect(w.get('[data-testid="tags-sealed-note"]').exists()).toBe(true);
    await w.get('[data-testid="tag-field-1"]').setValue("new");
    await w.get('[data-testid="tags-save"]').trigger("click");
    await settle();
    expect(called("tags_set").length).toBe(1);
    expect(charges()).toEqual([]);
  });
});

describe("the empty-bar prompt", () => {
  const TOP = [
    { relPath: "photos/big.png", path: "/w/photos/big.png", bytes: 400 * 1024, perHour: 4 },
    { relPath: "notes/long.md", path: "/w/notes/long.md", bytes: 200 * 1024, perHour: 2 },
    { relPath: "c.md", path: "/w/c.md", bytes: 30 * 1024, perHour: 0.3 },
  ];
  const empty = () => makeStatus({ level: 0, exhausted: true, drainPerHour: 6.5, netPerHour: -5.5, plainFiles: 7, top: TOP });

  function mountPrompt() {
    return mount(ManaPrompt, { global: { plugins: [i18n], stubs: { teleport: true } } });
  }

  it("opens by itself at zero, with the fewest files ticked that turn the bar around", async () => {
    const w = mountPrompt();
    manaStatus.value = empty();
    await settle();
    expect(w.get('[data-testid="mana-prompt-why"]').text()).toContain("use 6.5 Mana an hour, and it comes back at 1 an hour");
    // 6.5 − 4 − 2 = 0.5 < 1: the first two are enough.
    expect((w.get('[data-testid="mana-prompt-file-0"]').element as HTMLInputElement).checked).toBe(true);
    expect((w.get('[data-testid="mana-prompt-file-1"]').element as HTMLInputElement).checked).toBe(true);
    expect((w.get('[data-testid="mana-prompt-file-2"]').element as HTMLInputElement).checked).toBe(false);
    expect(w.get('[data-testid="mana-prompt-rate-0"]').text()).toBe("4/h");
    expect(w.get('[data-testid="mana-prompt-saving"]').text()).toBe("2 files chosen: saves 6 an hour.");
    expect(w.text()).toContain("…and 4 more plain files");

    // Ticks are the user's.
    await w.get('[data-testid="mana-prompt-file-2"]').setValue(true);
    expect(w.get('[data-testid="mana-prompt-saving"]').text()).toBe("3 files chosen: saves 6.3 an hour.");
  });

  it("encrypts the ticked files with one passphrase typed twice, and records each", async () => {
    const done = vi.fn();
    const w = mount(ManaPrompt, { props: { onDone: done }, global: { plugins: [i18n], stubs: { teleport: true } } });
    manaStatus.value = empty();
    await settle();
    expect(w.get('[data-testid="mana-prompt-run"]').attributes("disabled")).toBeDefined();
    await w.get('[data-testid="mana-prompt-password"]').setValue("pw");
    await w.get('[data-testid="mana-prompt-confirm"]').setValue("px");
    expect(w.get('[data-testid="mana-prompt-mismatch"]').exists()).toBe(true);
    await w.get('[data-testid="mana-prompt-confirm"]').setValue("pw");
    status = makeStatus({ level: 0, exhausted: true, drainPerHour: 0.5, netPerHour: 0.5 });
    await w.get('[data-testid="mana-prompt-run"]').trigger("click");
    await settle();
    expect(called("files_lock")[0][1]).toEqual({ paths: ["/w/photos/big.png", "/w/notes/long.md"], password: "pw" });
    expect(events).toEqual([
      { event: "encrypt_file", path: "photos/big.png" },
      { event: "encrypt_file", path: "notes/long.md" },
    ]);
    expect(w.get('[data-testid="mana-prompt-report"]').text()).toContain("2");
    expect(done).toHaveBeenCalledTimes(1);
    expect(called("mana_status").length).toBe(1);
    // The passphrase is not left in a field.
    expect(w.find('[data-testid="mana-prompt-password"]').exists()).toBe(false);
  });

  it("takes no for an answer, and asks again only after Mana came back and ran out again", async () => {
    const w = mountPrompt();
    manaStatus.value = empty();
    await settle();
    await w.get('[data-testid="mana-prompt-later"]').trigger("click");
    await settle();
    expect(manaPrompt.value).toBe(null);
    expect(w.find('[data-testid="mana-prompt"]').exists()).toBe(false);
    expect(called("files_lock")).toEqual([]);

    manaStatus.value = empty(); // the next minute's look: still empty
    await settle();
    expect(manaPrompt.value).toBe(null);

    manaStatus.value = makeStatus({ level: 3 });
    await settle();
    manaStatus.value = empty();
    await settle();
    expect(manaPrompt.value).toBe("empty");
  });

  it("does not ask when there is nothing plain to encrypt", async () => {
    mountPrompt();
    manaStatus.value = makeStatus({ level: 0, exhausted: true, plainFiles: 0, top: [] });
    await settle();
    expect(manaPrompt.value).toBe(null);
  });

  it("opens on purpose too, with a title that is not an alarm", async () => {
    manaStatus.value = makeStatus({ top: TOP });
    const w = mountPrompt();
    manaPrompt.value = "asked";
    await settle();
    expect(w.text()).toContain("Encrypt the costliest plain files");
    expect(w.text()).not.toContain("Out of Security Mana");
  });
});

describe("the prices the page shows", () => {
  it("are read from Rust, never written here", async () => {
    const { loadManaPrices } = await import("../../src/security/mana");
    await loadManaPrices();
    expect(manaPrices.value?.perKbHour).toBe(0.01);
    // Compiled into Rust, so read once: the panel mounted above already did.
    const asked = called("mana_prices").length;
    await loadManaPrices();
    expect(called("mana_prices").length).toBe(asked);
    expect(asked).toBeLessThanOrEqual(1);
  });
});
