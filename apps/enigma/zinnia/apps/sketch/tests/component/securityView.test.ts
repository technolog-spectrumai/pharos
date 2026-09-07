import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SecurityView from "padova/SecurityView.vue";
import { filterRows, useWorkspace } from "petalite/files";
import { i18n } from "../../src/i18n";

const invoke = vi.fn();
const readDir = vi.fn();
const stat = vi.fn();
const openDialog = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: (...a: unknown[]) => readDir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

const ROOT = "/home/u/work";

function mountSecurity() {
  // The tab takes its store as a prop now: it lives in a package, the store
  // lives in the app, and this is the seam that lets three apps share it.
  // The store is a module singleton, so this is the same one every helper here
  // reaches — which is what the "one tree, two views" behaviour rests on.
  return mount(SecurityView, {
    props: { workspace: useWorkspace(), filterRows },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

/** The chain is deeper than one microtask: a dynamic import of the fs plugin,
 *  then readDir, then a stat and a probe per row. Drain until it settles. */
async function settle() {
  for (let i = 0; i < 10; i++) await flushPromises();
}

function tree(byDir: Record<string, Array<[string, boolean]>>) {
  readDir.mockImplementation(async (dir: string) =>
    (byDir[dir] ?? []).map(([name, isDirectory]) => ({ name, isDirectory })));
}

async function withRoot(root = ROOT) {
  const { useWorkspace } = await import("petalite/files");
  const workspace = useWorkspace();
  workspace.root.value = root;
  return workspace;
}

beforeEach(async () => {
  localStorage.clear();
  for (const fn of [invoke, readDir, stat, openDialog]) fn.mockReset();
  stat.mockResolvedValue({ size: 12, mtime: null });
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { useWorkspace, setSealProbe } = await import("petalite/files");
  // See filesPanel.test.ts: the store takes its probe by injection now, the
  // way main.ts gives it one. Without this the padlocks never appear.
  const { probeSealed } = await import("padova");
  setSealProbe((path) => probeSealed(path));
  useWorkspace().clearRoot();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  i18n.global.locale.value = "en";
});

describe("SecurityView — encrypting a file", () => {
  it("asks for a folder before it can offer anything", async () => {
    const w = mountSecurity();
    await settle();
    expect(w.get('[data-testid="security-files-none"]').exists()).toBe(true);
    expect(w.find('[data-testid="security-files"]').exists()).toBe(false);
  });

  it("lists the workspace and marks what is already encrypted", async () => {
    tree({ [ROOT]: [["plain.txt", false], ["secret.svg", false]] });
    invoke.mockImplementation(async (_cmd: string, args: Record<string, string>) =>
      args.path.endsWith("secret.svg"));
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();

    expect(w.get('[data-testid="security-row-plain.txt"]').exists()).toBe(true);
    expect(w.find('[data-testid="security-sealed-secret.svg"]').exists()).toBe(true);
    expect(w.find('[data-testid="security-sealed-plain.txt"]').exists()).toBe(false);
  });

  it("offers to encrypt a file no editor could open", async () => {
    // A .png is perfectly encryptable; the sidepanel greys it because it is
    // trying to OPEN things, which this list is not.
    tree({ [ROOT]: [["photo.png", false]] });
    invoke.mockResolvedValue(false);
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="security-row-photo.png"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-testid="lock-password"]').exists()).toBe(true);
    // Encrypting, so it asks twice.
    expect(w.find('[data-testid="lock-confirm"]').exists()).toBe(true);
  });

  it("encrypts with nothing but a path and a password", async () => {
    // The whole point of the self-contained frame: no salt crosses this call.
    tree({ [ROOT]: [["notes.txt", false]] });
    invoke.mockResolvedValue(false);
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="security-row-notes.txt"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="lock-password"]').setValue("hunter2");
    await w.get('[data-testid="lock-confirm"]').setValue("hunter2");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();

    expect(invoke).toHaveBeenCalledWith("lock_file", {
      path: `${ROOT}/notes.txt`,
      password: "hunter2",
    });
  });

  it("offers to decrypt a file that is already encrypted", async () => {
    tree({ [ROOT]: [["secret.txt", false]] });
    invoke.mockImplementation(async (cmd: string) => cmd === "is_file_locked");
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="security-row-secret.txt"]').trigger("click");
    await flushPromises();
    // Decrypting asks once, not twice.
    expect(w.find('[data-testid="lock-confirm"]').exists()).toBe(false);

    await w.get('[data-testid="lock-password"]').setValue("hunter2");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("unlock_file", {
      path: `${ROOT}/secret.txt`,
      password: "hunter2",
    });
  });

  it("shows a wrong password as a sentence, never as raw Rust", async () => {
    tree({ [ROOT]: [["secret.txt", false]] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "is_file_locked") return true;
      // Tauri rejects a Result<_, String> with the bare string.
      throw "wrong_password: wrong password or corrupt file";
    });
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="security-row-secret.txt"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="lock-password"]').setValue("nope");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();

    expect(w.get('[data-testid="lock-error"]').text())
      .toBe("Wrong password, or the file is damaged. Nothing was changed.");
    expect(w.html()).not.toContain("wrong_password:");
  });

  it("explains a file the platform encrypted rather than blaming the password", async () => {
    tree({ [ROOT]: [["old.bin", false]] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "is_file_locked") return true;
      throw "legacy_format: that file was encrypted by the platform";
    });
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="security-row-old.bin"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="lock-password"]').setValue("x");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="lock-error"]').text()).toContain("encrypted by the platform");
  });

  it("re-checks only the file it just encrypted", async () => {
    tree({ [ROOT]: [["a.txt", false], ["b.txt", false]] });
    invoke.mockResolvedValue(false);
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();

    const before = invoke.mock.calls.filter(([c]) => c === "is_file_locked").length;
    await w.get('[data-testid="security-row-a.txt"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-confirm"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();

    const probes = invoke.mock.calls
      .filter(([c]) => c === "is_file_locked")
      .slice(before)
      .map(([, args]) => (args as { path: string }).path);
    // One targeted probe, not a whole re-listing.
    expect(probes).toEqual([`${ROOT}/a.txt`]);
  });

  it("says nothing is remembered until something is", async () => {
    invoke.mockResolvedValue({ remembered: false, storage: null });
    const w = mountSecurity();
    await settle();
    expect(w.get('[data-testid="secret-row"]').text()).toContain("No passphrase is remembered");
    expect(w.find('[data-testid="secret-forget"]').exists()).toBe(false);
  });

  it("remembers a passphrase only after it has worked on a real file", async () => {
    // Storing it first would remember a typo. The order is: seal, then keep.
    tree({ [ROOT]: [["notes.txt", false]] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: false, storage: null };
      return false;
    });
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();

    await w.get('[data-testid="security-row-notes.txt"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="lock-password"]').setValue("hunter2");
    await w.get('[data-testid="lock-confirm"]').setValue("hunter2");
    await w.get('[data-testid="lock-remember"]').setValue(true);
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();

    const order = invoke.mock.calls.map(([c]) => c);
    expect(order.indexOf("lock_file")).toBeLessThan(order.indexOf("secret_remember"));
    expect(invoke).toHaveBeenCalledWith("secret_remember", { passphrase: "hunter2" });
  });

  it("stops asking once a passphrase is remembered", async () => {
    // The whole point of remembering. Rust reads it from the secret store, so
    // `password` goes down as null and the passphrase never reaches this side.
    tree({ [ROOT]: [["notes.txt", false]] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_status") return { remembered: true, storage: "keychain" };
      return false;
    });
    const workspace = await withRoot();
    const w = mountSecurity();
    await settle();
    await workspace.refresh();
    await settle();
    expect(w.get('[data-testid="secret-row"]').text()).toContain("system keyring");

    await w.get('[data-testid="security-row-notes.txt"]').trigger("click");
    await settle();
    // No dialog, and the command was told to use what is remembered.
    expect(w.find('[data-testid="lock-password"]').exists()).toBe(false);
    expect(invoke).toHaveBeenCalledWith("lock_file", {
      path: `${ROOT}/notes.txt`,
      password: null,
    });
  });

  it("says when the passphrase will not survive a restart", async () => {
    invoke.mockResolvedValue({ remembered: true, storage: "memory" });
    const w = mountSecurity();
    await settle();
    expect(w.get('[data-testid="secret-row"]').text()).toContain("until this app closes");
  });

  it("forgets on request", async () => {
    invoke.mockResolvedValue({ remembered: true, storage: "keychain" });
    const w = mountSecurity();
    await settle();
    await w.get('[data-testid="secret-forget"]').trigger("click");
    await settle();
    expect(invoke).toHaveBeenCalledWith("secret_forget", {});
  });

  it("never asks Rust for the passphrase itself", async () => {
    // The rule the whole design rests on: no command returns it.
    const { LOCK_ERRORS } = await import("padova");
    const mod = await import("padova");
    expect(Object.keys(mod)).not.toContain("recallPassphrase");
    expect(LOCK_ERRORS).toContain("no_passphrase");
    invoke.mockResolvedValue({ remembered: true, storage: "keychain" });
    const w = mountSecurity();
    await settle();
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain("secret_recall");
  });

  it("still reports in a browser build, and invokes nothing", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const w = mountSecurity();
    await settle();
    expect(w.get('[data-testid="security-files-none"]').exists()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
