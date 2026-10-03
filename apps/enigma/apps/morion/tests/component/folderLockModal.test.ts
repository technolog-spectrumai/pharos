import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import FolderLockModal from "../../src/security/FolderLockModal.vue";
import { i18n } from "../../src/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

function mountModal(path = "/w/notes") {
  return mount(FolderLockModal, {
    props: { open: false, name: "notes", path },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}
async function settle() {
  for (let i = 0; i < 6; i++) await flushPromises();
}

beforeEach(() => {
  invoke.mockReset();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the folder shield's modal", () => {
  it("previews what is there, encrypts with a confirmed passphrase, and reports", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: false, storage: null };
      if (cmd === "folder_preview") return { files: 5, plain: 4, sealed: 1, links: 2, truncated: false };
      if (cmd === "folder_lock") return { done: ["a.md", "b.md", "c.pdf", "d.png"], skipped: ["e.md"], untried: [], failed: [], links: 2, truncated: false };
      throw new Error(cmd);
    });
    const w = mountModal();
    await w.setProps({ open: true });
    await settle();
    expect(invoke).toHaveBeenCalledWith("folder_preview", { dir: "/w/notes" });
    expect(w.get('[data-testid="folder-preview"]').text()).toContain("5 files here: 4 plain, 1 encrypted");
    expect(w.get('[data-testid="folder-preview"]').text()).toContain("2 symbolic links are left alone");
    expect((w.get('[data-testid="folder-mode-lock"]').element as HTMLInputElement).checked).toBe(true);
    expect(w.get('[data-testid="folder-note"]').text()).toContain(".morion folder is not touched");
    expect(w.get('[data-testid="folder-note"]').text()).toContain("does not undo the others");

    // Nothing runs until the passphrase is typed twice and matches, and a
    // mismatch is said while typing rather than left as a dead button.
    expect(w.get('[data-testid="folder-run"]').attributes("disabled")).toBeDefined();
    await w.get('[data-testid="folder-password"]').setValue("pw");
    expect(w.find('[data-testid="folder-mismatch"]').exists()).toBe(false);
    await w.get('[data-testid="folder-confirm"]').setValue("pW");
    expect(w.get('[data-testid="folder-run"]').attributes("disabled")).toBeDefined();
    expect(w.get('[data-testid="folder-mismatch"]').text()).toBe("Those two do not match.");
    await w.get('[data-testid="folder-confirm"]').setValue("pw");
    expect(w.find('[data-testid="folder-mismatch"]').exists()).toBe(false);
    expect(w.get('[data-testid="folder-run"]').attributes("disabled")).toBeUndefined();
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("folder_lock", { dir: "/w/notes", password: "pw", unlock: false });
    expect(w.get('[data-testid="folder-report"]').text()).toContain("4 files changed");
    expect(w.get('[data-testid="folder-report"]').text()).toContain("1 files were already as requested");
    const done = w.emitted("done")?.[0] as [unknown, string];
    expect(done[1]).toBe("lock");
    // The passphrase fields are gone with the form.
    expect(w.find('[data-testid="folder-password"]').exists()).toBe(false);
  });

  it("offers decryption first for an all-encrypted folder, uses the remembered passphrase, and lists failures", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: true, storage: "keychain" };
      if (cmd === "folder_preview") return { files: 3, plain: 0, sealed: 3, links: 0, truncated: false };
      if (cmd === "folder_lock") return {
        done: ["a.md"], skipped: [], untried: [],
        failed: [{ path: "b.md", error: "crypto: that encrypted file is damaged" }, { path: "c.md", error: "EACCES: permission denied" }],
        links: 0, truncated: false,
      };
      throw new Error(cmd);
    });
    const w = mountModal();
    await w.setProps({ open: true });
    await settle();
    expect((w.get('[data-testid="folder-mode-unlock"]').element as HTMLInputElement).checked).toBe(true);
    expect(w.find('[data-testid="folder-confirm"]').exists()).toBe(false);
    expect(w.get('[data-testid="folder-password"]').attributes("placeholder")).toContain("Remembered passphrase");
    expect(w.get('[data-testid="folder-note"]').text()).toContain("the run stops there");
    expect(w.get('[data-testid="folder-note"]').text()).toContain("files already decrypted stay decrypted");
    // Remembered, so nothing typed is needed.
    expect(w.get('[data-testid="folder-run"]').attributes("disabled")).toBeUndefined();
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("folder_lock", { dir: "/w/notes", password: null, unlock: true });
    const failures = w.findAll('[data-testid="folder-failure"]').map((f) => f.text());
    expect(failures).toEqual([
      "b.md: That encrypted file is damaged. Nothing was changed.",
      "c.md: EACCES: permission denied",
    ]);
    expect(w.get('[data-testid="folder-report"]').text()).toContain("1 files changed");
    expect(w.get('[data-testid="folder-report"]').text()).toContain("2 files failed and were left as they were");
  });

  it("shows a refusal from Rust as a sentence and keeps the form", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: false, storage: null };
      if (cmd === "folder_preview") return { files: 1, plain: 0, sealed: 1, links: 0, truncated: false };
      if (cmd === "folder_lock") throw "outside_workspace: that path is not inside the workspace";
      throw new Error(cmd);
    });
    const w = mountModal();
    await w.setProps({ open: true });
    await settle();
    await w.get('[data-testid="folder-password"]').setValue("pw");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="folder-error"]').text()).toBe("That path is outside the workspace.");
    expect(w.find('[data-testid="folder-report"]').exists()).toBe(false);
    expect(w.emitted("done")).toBeUndefined();
  });
});

describe("what a run could not reach", () => {
  it("says deep folders apart from the file cap, before the run and in its report", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: false, storage: null };
      if (cmd === "folder_preview") return { files: 2, plain: 2, sealed: 0, links: 0, truncated: false, deep: true };
      if (cmd === "folder_lock") return { done: ["a.md", "b.md"], skipped: [], untried: [], failed: [], links: 0, truncated: true, deep: true };
      throw new Error(cmd);
    });
    const w = mountModal();
    await w.setProps({ open: true });
    await settle();
    expect(w.get('[data-testid="folder-deep"]').text()).toContain("more than 32 levels down are not entered");
    expect(w.get('[data-testid="folder-preview"]').text()).not.toContain("run again");
    await w.get('[data-testid="folder-password"]').setValue("pw");
    await w.get('[data-testid="folder-confirm"]').setValue("pw");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="folder-report-truncated"]').text()).toContain("run again afterwards");
    expect(w.get('[data-testid="folder-report-deep"]').exists()).toBe(true);
  });
});

describe("a decrypt run that stopped at a wrong passphrase", () => {
  it("says which files were never tried and are still encrypted", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: false, storage: null };
      if (cmd === "folder_preview") return { files: 3, plain: 0, sealed: 3, links: 0, truncated: false };
      if (cmd === "folder_lock") return {
        done: [], skipped: [], untried: ["b.md", "c.md"],
        failed: [{ path: "a.md", error: "wrong_password: wrong password or corrupt file" }], links: 0, truncated: false,
      };
      return null;
    });
    const w = mountModal();
    await w.setProps({ open: true });
    await settle();
    await w.get('[data-testid="folder-password"]').setValue("nope");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="folder-untried"]').text()).toBe("2 files were not tried after the wrong passphrase and are still encrypted.");
    expect(w.get('[data-testid="folder-report"]').text()).not.toContain("already as requested");
    expect(w.findAll('[data-testid="folder-failure"]').map((f) => f.text()))
      .toEqual(["a.md: Wrong password, or the file is damaged. Nothing was changed."]);
  });

  it("says a preview refusal as a sentence", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: false, storage: null };
      if (cmd === "folder_preview") throw "metadata: that is Morion's own metadata folder";
      return null;
    });
    const w = mountModal("/w/.morion");
    await w.setProps({ open: true });
    await settle();
    expect(w.get('[data-testid="folder-preview-error"]').text()).toBe("That is Morion’s own metadata folder.");
  });
});

describe("the folder run's words follow its direction", () => {
  it("says an encrypt run's size refusal as the encrypt dialog does", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: false, storage: null };
      if (cmd === "folder_preview") return { files: 1, plain: 1, sealed: 0, links: 0, truncated: false };
      if (cmd === "folder_lock") return { done: [], skipped: [], untried: [],
        failed: [{ path: "huge.bin", error: "too_large: that file is too big to lock" }], links: 0, truncated: false };
      return null;
    });
    const w = mountModal();
    await w.setProps({ open: true });
    await settle();
    await w.get('[data-testid="folder-password"]').setValue("pw");
    await w.get('[data-testid="folder-confirm"]').setValue("pw");
    await w.get('[data-testid="folder-run"]').trigger("click");
    await settle();
    expect(w.findAll('[data-testid="folder-failure"]').map((f) => f.text())).toEqual(["huge.bin: That file is too big to encrypt."]);
  });
});
