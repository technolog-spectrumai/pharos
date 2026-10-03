import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import App from "../../src/App.vue";
import WorkspaceSecurity from "../../src/views/WorkspaceSecurity.vue";
import { i18n } from "../../src/i18n";
import { useWorkspace } from "petalite/files";

// The workspace security view: counts from Rust, the remembered passphrase,
// the Security Mana bar with what drains and refills it, the costliest plain
// files, the recent actions — and what encryption does not hide. Reached from
// the shield beside the tree.
type Args = Record<string, unknown>;
let remembered = true;
const invoke = vi.fn(async (cmd: string, _a: Args) => {
  switch (cmd) {
    case "folder_preview": return { files: 7, plain: 4, sealed: 3, links: 1, truncated: false };
    case "secret_status": return remembered ? { remembered: true, storage: "keychain" } : { remembered: false, storage: null };
    case "secret_forget": remembered = false; return null;
    case "mana_ledger": return [
      { ts: 1_758_000_000_000, action: "rekey_file", path: "notes/tax.md", cost: 0, gain: 10, note: "mana.notes.rekey_file" },
      { ts: 1_757_995_000_000, action: "decrypt_file", path: "notes/tax.md", cost: 0, note: "mana.notes.decrypt_file" },
      // A row from the earlier price-per-action budget still reads.
      { ts: 1_757_990_000_000, action: "unlock_temp", path: "old.md", cost: 5, note: "mana.notes.unlock_temp" },
    ];
    case "mana_prices": return { max: 100, perKbHour: 0.01, regenPerHour: 1, rekeyReward: 10, rekeyCooldownHours: 24, rekeyDailyCap: 30 };
    case "mana_status": return {
      max: 100, level: 85.4, drainPerHour: 3, regenPerHour: 1, netPerHour: -2, plainFiles: 4, plainBytes: 300 * 1024,
      exhausted: false, truncated: false, deep: false, kept: true,
      top: [
        { relPath: "photos/cat.png", path: "/home/u/work/photos/cat.png", bytes: 250 * 1024, perHour: 2.5 },
        { relPath: "notes/a.md", path: "/home/u/work/notes/a.md", bytes: 50 * 1024, perHour: 0.5 },
      ],
    };
    case "workspace_open": return { root: "/w", name: "w" };
    case "workspace_list": return [];
    case "tags_get": return [];
    default: return null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...x: [string, Args]) => invoke(...x) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readDir: vi.fn(), stat: vi.fn(), readTextFile: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), writeTextFile: vi.fn() }));

enableAutoUnmount(afterEach);

async function settle() {
  for (let i = 0; i < 8; i++) await flushPromises();
}

beforeEach(async () => {
  remembered = true;
  invoke.mockClear();
  localStorage.clear();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  // What main.ts installs: every workspace read through Rust (mocked above).
  const { setFileBackend } = await import("petalite/files");
  const { rustBackend } = await import("../../src/files/fs");
  setFileBackend(rustBackend);
  useWorkspace().root.value = "/home/u/work";
});
afterEach(async () => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  const { setFileBackend } = await import("petalite/files");
  setFileBackend(null);
});

describe("the workspace security view", () => {
  it("counts encrypted and plain files, in Rust, for the whole workspace", async () => {
    const w = mount(WorkspaceSecurity, { global: { plugins: [i18n] } });
    await settle();
    expect(invoke).toHaveBeenCalledWith("folder_preview", { dir: "" });
    expect(w.get('[data-testid="security-workspace-name"]').text()).toBe("work");
    expect(w.get('[data-testid="security-count-sealed"]').text()).toBe("3");
    expect(w.get('[data-testid="security-count-plain"]').text()).toBe("4");
    expect(w.get('[data-testid="security-count-files"]').text()).toBe("7");
  });

  it("shows the remembered passphrase and forgets it", async () => {
    const w = mount(WorkspaceSecurity, { global: { plugins: [i18n] } });
    await settle();
    expect(w.get('[data-testid="security-secret-status"]').text()).toContain("system keyring");
    await w.get('[data-testid="security-forget"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("secret_forget", {});
    expect(w.get('[data-testid="security-secret-status"]').text()).toContain("No passphrase is remembered");
    expect(w.find('[data-testid="security-forget"]').exists()).toBe(false);
  });

  it("shows the bar, what drains and refills it, the prices from Rust, and the recent actions", async () => {
    const w = mount(WorkspaceSecurity, { global: { plugins: [i18n] } });
    await settle();
    expect(w.get('[data-testid="mana-level-value"]').text()).toBe("85.4 / 100");
    expect((w.get('[data-testid="mana-level"] progress').element as HTMLProgressElement).value).toBe(85.4);
    expect(w.get('[data-testid="mana-flow"]').text()).toBe("4 plain files use 3 an hour; 1 comes back an hour. Net: −2 an hour.");
    expect(w.get('[data-testid="mana-eta"]').text()).toBe("Empty in about 43 h at this rate.");
    expect(w.get('[data-testid="security-mana"]').text()).toContain("not a security score");
    expect(w.get('[data-testid="security-mana"]').text()).toContain("encrypted files use none, open or not");
    expect(w.get('[data-testid="mana-price-per-kb-hour"]').text()).toBe("0.01");
    expect(w.get('[data-testid="mana-price-regen"]').text()).toBe("+1");
    expect(w.get('[data-testid="mana-price-rekey"]').text()).toBe("+10");
    expect(w.get('[data-testid="mana-prices"]').text()).toContain("once per file every 24 h, at most 30 a day");
    expect(w.get('[data-testid="security-history-0"]').text()).toContain("Changed a file’s passphrase");
    expect(w.get('[data-testid="security-history-0"]').text()).toContain("+10");
    expect(w.get('[data-testid="security-history-1"]').text()).toContain("Decrypted a file permanently");
    expect(w.get('[data-testid="security-history-1"]').text()).toMatch(/0$/);
    expect(w.get('[data-testid="security-history-2"]').text()).toContain("−5");
  });

  it("names the costliest plain files and opens the prompt to encrypt some", async () => {
    const { manaPrompt } = await import("../../src/security/mana");
    const w = mount(WorkspaceSecurity, { global: { plugins: [i18n] } });
    await settle();
    expect(w.get('[data-testid="mana-top-0"]').text()).toContain("photos/cat.png");
    expect(w.get('[data-testid="mana-top-0"]').text()).toContain("2.5/h");
    await w.get('[data-testid="security-encrypt-some"]').trigger("click");
    expect(manaPrompt.value).toBe("asked");
    manaPrompt.value = null;
  });

  it("reads again each time it is shown, so an action taken meanwhile is in the history", async () => {
    const w = mount(WorkspaceSecurity, { props: { active: true }, global: { plugins: [i18n] } });
    await settle();
    const before = invoke.mock.calls.filter(([c]) => c === "mana_ledger").length;
    await w.setProps({ active: false });
    await w.setProps({ active: true });
    await settle();
    expect(invoke.mock.calls.filter(([c]) => c === "mana_ledger").length).toBe(before + 1);
    expect(invoke.mock.calls.filter(([c]) => c === "folder_preview").length).toBeGreaterThan(1);
  });

  it("says when the count stopped early", async () => {
    const orig = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, a: Args) =>
      cmd === "folder_preview" ? { files: 20000, plain: 20000, sealed: 0, links: 0, truncated: true } : orig(cmd, a));
    const w = mount(WorkspaceSecurity, { global: { plugins: [i18n] } });
    await settle();
    expect(w.get('[data-testid="security-truncated"]').text()).toContain("first 20,000 files");
    invoke.mockImplementation(orig);
  });

  it("says apart that deep folders were not counted and that Mana is not kept in a read-only folder", async () => {
    const orig = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, a: Args) => {
      if (cmd === "folder_preview") return { files: 3, plain: 3, sealed: 0, links: 0, truncated: false, deep: true };
      if (cmd === "mana_status") return { ...(await orig(cmd, a) as object), deep: true, kept: false };
      return orig(cmd, a);
    });
    const w = mount(WorkspaceSecurity, { global: { plugins: [i18n] } });
    await settle();
    expect(w.get('[data-testid="security-deep"]').text()).toContain("more than 32 levels down");
    expect(w.find('[data-testid="security-truncated"]').exists()).toBe(false);
    expect(w.get('[data-testid="mana-not-kept"]').text()).toContain("kept only while Morion is open");
    invoke.mockImplementation(orig);
  });

  it("says what encryption does not hide", async () => {
    const w = mount(WorkspaceSecurity, { global: { plugins: [i18n] } });
    await settle();
    const limits = w.get('[data-testid="security-limits"]').text();
    expect(limits).toContain("name, its folder, its size and dates, and any tags stay visible");
    expect(limits).toContain("never keeps a passphrase, decrypted contents or search results");
  });
});

describe("reaching it", () => {
  it("is the shield beside the tree, and no longer a menu item", async () => {
    const w = mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
    await settle();
    await w.get('[data-testid="app-menu"]').trigger("click");
    expect(w.find('[data-testid="menu-security"]').exists()).toBe(false);
    expect(w.find('[data-testid="menu-settings"]').exists()).toBe(true);
    await w.get('[data-testid="app-menu"]').trigger("click");

    await w.get('[data-testid="files-security"]').trigger("click");
    await settle();
    expect(w.find('[data-testid="workspace-security"]').exists()).toBe(true);
    expect(w.get('[data-testid="view-title"]').text()).toContain("Workspace security");
    await w.get('[data-testid="view-close"]').trigger("click");
    await settle();
    expect((w.get('[data-testid="workspace-security"]').element as HTMLElement).style.display).toBe("none");
  });
});

describe("the pane and the header agree", () => {
  it("a security change in the pane makes the host ask the disk again about its file", async () => {
    const FilesPanel = (await import("../../src/files/FilesPanel.vue")).default;
    const EditorHost = (await import("../../src/views/EditorHost.vue")).default;
    const { setSealProbe } = await import("petalite/files");
    let sealedOnDisk = false;
    setSealProbe(async () => sealedOnDisk);
    const w = mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
    await settle();
    (w.findComponent(EditorHost).vm as unknown as { openLocal(n: string, p: string, t: string): void })
      .openLocal("n.md", "/home/u/work/n.md", "note");
    await settle();
    expect(w.get('[data-testid="file-shield"]').attributes("data-sealed")).toBe("0");

    sealedOnDisk = true; // a row shield encrypted it
    w.findComponent(FilesPanel).vm.$emit("security-changed");
    await settle();
    expect(w.get('[data-testid="file-shield"]').attributes("data-sealed")).toBe("1");
    setSealProbe(null);
  });
});
