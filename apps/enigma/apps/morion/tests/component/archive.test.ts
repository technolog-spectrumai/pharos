import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import ArchiveModal from "../../src/files/ArchiveModal.vue";
import SettingsView from "../../src/views/SettingsView.vue";
import { i18n } from "../../src/i18n";
import { useWorkspace } from "petalite/files";

// The workspace archive from the page's side: a password in, and nothing
// else — Rust (mocked) opens the native dialog and does the work. Pinned: the
// password is typed twice for an export and never kept, what a zip does not
// hide is said first, a cancelled dialog is not an error, an import reports
// what it kept rather than overwrote, and the workspace is read again after.
type Args = Record<string, unknown>;
let cancel = false;
const invoke = vi.fn(async (cmd: string, a: Args) => {
  switch (cmd) {
    case "archive_export":
      if (cancel) return null;
      if (a.password !== "zip-pw") throw "archive_inside: save the archive outside the workspace";
      return { path: "/backups/work-2026-09-18.zip", files: 12, sealed: 3, bytes: 20480, links: 1 };
    case "archive_import":
      if (cancel) return null;
      if (a.password !== "zip-pw") throw "archive_wrong_password: wrong password for this archive";
      return {
        written: ["a.md", "notes/b.md"], kept: ["mine.md"], tagged: 1,
        skipped: [{ path: "../escape.md", reason: "outside_workspace: the archive names a path outside the workspace" }],
      };
    case "mana_status": return null;
    default: return null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...x: [string, Args]) => invoke(...x) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(async () => []), stat: vi.fn(async () => ({ size: 0, mtime: null })),
  readTextFile: vi.fn(), writeTextFile: vi.fn(),
}));

enableAutoUnmount(afterEach);

async function settle() {
  for (let i = 0; i < 6; i++) await flushPromises();
}
function mountModal(mode: "export" | "import") {
  return mount(ArchiveModal, {
    props: { open: false, mode, root: "/home/u/work" },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

beforeEach(() => {
  cancel = false;
  invoke.mockClear();
  localStorage.clear();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("exporting the workspace", () => {
  it("says what goes in and what a zip does not hide, before asking for the password twice", async () => {
    const w = mountModal("export");
    await w.setProps({ open: true });
    expect(w.get('[data-testid="archive-what"]').text()).toContain("encrypted files stay encrypted inside it");
    expect(w.get('[data-testid="archive-limits"]').text()).toContain("names, sizes and dates of the files inside it are readable without the password");
    expect(w.text()).toContain("not stored anywhere");
    const run = w.get('[data-testid="archive-run"]');
    expect(run.attributes("disabled")).toBeDefined();
    await w.get('[data-testid="archive-password"]').setValue("zip-pw");
    await w.get('[data-testid="archive-confirm"]').setValue("zip-px");
    expect(w.get('[data-testid="archive-mismatch"]').exists()).toBe(true);
    expect(run.attributes("disabled")).toBeDefined();
    await w.get('[data-testid="archive-confirm"]').setValue("zip-pw");
    expect(run.attributes("disabled")).toBeUndefined();
  });

  it("sends the password and nothing else, and reports where the archive went", async () => {
    const w = mountModal("export");
    await w.setProps({ open: true });
    await w.get('[data-testid="archive-password"]').setValue("zip-pw");
    await w.get('[data-testid="archive-confirm"]').setValue("zip-pw");
    await w.get('[data-testid="archive-run"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("archive_export", { password: "zip-pw" });
    const done = w.get('[data-testid="archive-exported"]').text();
    expect(done).toContain("Exported 12 files (3 of them encrypted)");
    expect(done).toContain("/backups/work-2026-09-18.zip");
    expect(w.find('[data-testid="archive-password"]').exists()).toBe(false);
  });

  it("says a refusal in words, and forgets the password either way", async () => {
    const w = mountModal("export");
    await w.setProps({ open: true });
    await w.get('[data-testid="archive-password"]').setValue("other");
    await w.get('[data-testid="archive-confirm"]').setValue("other");
    await w.get('[data-testid="archive-run"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="archive-error"]').text()).toContain("Save the archive outside the workspace");
    expect((w.get('[data-testid="archive-password"]').element as HTMLInputElement).value).toBe("");
  });

  it("treats a cancelled save dialog as nothing happening", async () => {
    cancel = true;
    const w = mountModal("export");
    await w.setProps({ open: true });
    await w.get('[data-testid="archive-password"]').setValue("zip-pw");
    await w.get('[data-testid="archive-confirm"]').setValue("zip-pw");
    await w.get('[data-testid="archive-run"]').trigger("click");
    await settle();
    expect(w.find('[data-testid="archive-exported"]').exists()).toBe(false);
    expect(w.find('[data-testid="archive-error"]').exists()).toBe(false);
    expect(w.find('[data-testid="archive-run"]').exists()).toBe(true);
  });
});

describe("importing an archive", () => {
  it("allows an empty password, for a zip that has none, and says Mana applies to what comes in", async () => {
    const w = mountModal("import");
    await w.setProps({ open: true });
    expect(w.find('[data-testid="archive-confirm"]').exists()).toBe(false);
    expect(w.get('[data-testid="archive-run"]').attributes("disabled")).toBeUndefined();
    expect(w.get('[data-testid="archive-what"]').text()).toContain("never overwritten");
    expect(w.get('[data-testid="archive-mana"]').text()).toContain("Security Mana");
  });

  it("reports what came in, what was kept and what was refused, and tells the caller", async () => {
    const w = mountModal("import");
    await w.setProps({ open: true });
    await w.get('[data-testid="archive-password"]').setValue("zip-pw");
    await w.get('[data-testid="archive-run"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("archive_import", { password: "zip-pw" });
    const done = w.get('[data-testid="archive-imported"]').text();
    expect(done).toContain("2 files unpacked.");
    expect(w.get('[data-testid="archive-kept"]').text()).toContain("1 files were already here and were kept");
    expect(done).toContain("Tags came along for 1 files.");
    expect(w.get('[data-testid="archive-skipped-0"]').text())
      .toBe("../escape.md: That path is outside the workspace.");
    expect(w.emitted("imported")?.[0][0]).toMatchObject({ written: ["a.md", "notes/b.md"] });
  });

  it("says a wrong password in words", async () => {
    const w = mountModal("import");
    await w.setProps({ open: true });
    await w.get('[data-testid="archive-password"]').setValue("nope");
    await w.get('[data-testid="archive-run"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="archive-error"]').text()).toBe("Wrong password for this archive. Nothing was unpacked.");
    expect(w.emitted("imported")).toBeUndefined();
  });
});

describe("in Settings → System", () => {
  it("offers export and import once there is a workspace, and reads it again after an import", async () => {
    const workspace = useWorkspace();
    workspace.root.value = "";
    const w = mount(SettingsView, { global: { plugins: [i18n], stubs: { teleport: true } } });
    await w.get('[data-testid="settings-tab-system"]').trigger("click");
    const panel = w.get('[data-testid="settings-panel-system"]');
    expect(panel.get('[data-testid="archive-export"]').attributes("disabled")).toBeDefined();
    expect(panel.get('[data-testid="archive-no-workspace"]').exists()).toBe(true);

    workspace.root.value = "/home/u/work";
    await settle();
    const { readDir } = await import("@tauri-apps/plugin-fs");
    vi.mocked(readDir).mockClear();
    await panel.get('[data-testid="archive-import"]').trigger("click");
    await settle();
    await w.get('[data-testid="archive-password"]').setValue("zip-pw");
    await w.get('[data-testid="archive-run"]').trigger("click");
    await settle();
    // The tree was read again, and the Mana bar asked where it stands.
    expect(readDir).toHaveBeenCalledWith("/home/u/work");
    expect(invoke.mock.calls.some(([c]) => c === "mana_status")).toBe(true);
    workspace.root.value = "";
  });
});
