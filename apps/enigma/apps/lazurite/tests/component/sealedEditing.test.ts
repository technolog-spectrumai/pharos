import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";

// Editing an encrypted file. Rust (mocked here at the Tauri boundary) decrypts
// into memory under a session and re-seals on save; what the host owes is
// that the token is what travels, the passphrase is asked for once, the disk
// is never asked to hold plaintext, and the session is dropped when the file
// goes away.
type Args = Record<string, unknown>;
const disk = new Map<string, { text: string; sealed: boolean; pw?: string }>();
let remembered: string | null = null;
let nextToken = 1;
const sessions = new Map<number, string>();
const invoke = vi.fn(async (cmd: string, args: Args) => {
  const path = args.path as string;
  switch (cmd) {
    case "secret_status": return { remembered: remembered !== null, storage: remembered ? "memory" : null };
    case "secret_remember": remembered = args.passphrase as string; return "memory";
    case "is_file_locked": return disk.get(path)?.sealed ?? false;
    case "workspace_open": return { root: args.root, name: "w" };
    case "workspace_read_text": {
      const f = disk.get(path);
      if (!f) throw `not_found: no such file in the workspace: ${path}`;
      if (f.sealed) throw "locked: that file is encrypted";
      return f.text;
    }
    case "workspace_write_text": {
      const f = disk.get(path);
      if (f?.sealed) throw "locked: that file is encrypted on disk";
      disk.set(path, { text: args.text as string, sealed: false });
      return null;
    }
    case "sealed_open": {
      const f = disk.get(path);
      if (!f?.sealed) throw "not_locked: that file is not encrypted";
      const pw = (args.password as string | null) ?? remembered;
      if (!pw) throw "no_passphrase: no password was given and none is remembered";
      if (pw !== f.pw) throw "wrong_password: wrong password or corrupt file";
      const token = nextToken++;
      sessions.set(token, path);
      return { token, name: path.split("/").pop(), size: f.text.length, text: f.text };
    }
    case "sealed_open_bytes": {
      const f = disk.get(path);
      if (!f?.sealed) throw "not_locked: that file is not encrypted";
      if (((args.password as string | null) ?? remembered) !== f.pw) throw "wrong_password: wrong password";
      return new Uint8Array([137, 80, 78, 71]);
    }
    case "sealed_write": {
      if (!sessions.has(args.token as number)) throw "no_session: that file is no longer open for editing";
      const pw = disk.get(sessions.get(args.token as number)!)?.pw;
      disk.set(path, { text: args.text as string, sealed: true, pw });
      return null;
    }
    case "sealed_close": sessions.delete(args.token as number); return null;
    case "lock_file": {
      const f = disk.get(path)!;
      if (f.sealed) throw "already_locked: that file is already encrypted";
      disk.set(path, { ...f, sealed: true, pw: (args.password as string | null) ?? remembered ?? undefined });
      return { name: "x", size: f.text.length };
    }
    case "unlock_file": {
      const f = disk.get(path)!;
      if (!f.sealed) throw "not_locked: that file is not encrypted";
      if (((args.password as string | null) ?? remembered) !== f.pw) throw "wrong_password: wrong password";
      disk.set(path, { text: f.text, sealed: false });
      return { name: "x", size: f.text.length };
    }
    default: throw new Error(`unexpected command ${cmd}`);
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, Args]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

type HostVm = {
  openLocal(name: string, path: string, text: string): void;
  openSealed(name: string, path: string): Promise<boolean>;
  encryptFile(): Promise<boolean>;
  decryptFile(): Promise<boolean>;
  saveFile(): Promise<void>;
  name: string; dirty: boolean; canSave: boolean; isSealed: boolean; fileError: string;
};

function mountHost() {
  return mount(EditorHost, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
}
async function aceOf(w: ReturnType<typeof mountHost>) {
  const ace = (await import("../../src/editors/aceSetup")).default;
  return ace.edit(w.get('[data-testid="ace-host"]').element as HTMLElement);
}
async function settle() {
  for (let i = 0; i < 6; i++) await flushPromises();
}
const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(async () => {
  disk.clear();
  sessions.clear();
  remembered = null;
  nextToken = 1;
  invoke.mockClear();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { useWorkspace } = await import("petalite/files");
  useWorkspace().root.value = "/w";
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("opening an encrypted file", () => {
  it("asks for the passphrase once, decrypts into memory, and saves back through the session", async () => {
    disk.set("/w/secret.md", { text: "# top secret", sealed: true, pw: "pw" });
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;

    const pending = vm.openSealed("secret.md", "/w/secret.md");
    await settle();
    expect(w.get('[data-testid="lock-open-hint"]').text()).toContain("decrypted in memory only");
    expect(w.find('[data-testid="lock-confirm"]').exists()).toBe(false);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);

    expect(vm.name).toBe("secret.md");
    expect(vm.isSealed).toBe(true);
    expect(vm.dirty).toBe(false);
    expect(invoke).toHaveBeenCalledWith("sealed_open", { path: "/w/secret.md", password: "pw" });
    // The plaintext went to the editor and nowhere else.
    expect((await aceOf(w)).getValue()).toBe("# top secret");
    expect(calls("workspace_read_text")).toHaveLength(0);
    // The passphrase field is cleared the moment the action settles.
    expect(w.find('[data-testid="lock-password"]').exists()).toBe(false);

    (await aceOf(w)).session.insert({ row: 0, column: 12 }, "\nmore");
    await flushPromises();
    expect(vm.dirty).toBe(true);
    await vm.saveFile();
    await settle();
    expect(invoke).toHaveBeenCalledWith("sealed_write", { token: 1, path: "/w/secret.md", text: "# top secret\nmore" });
    expect(calls("workspace_write_text")).toHaveLength(0);
    expect(disk.get("/w/secret.md")).toEqual({ text: "# top secret\nmore", sealed: true, pw: "pw" });
    expect(vm.dirty).toBe(false);

    // Opening another file drops the session.
    disk.set("/w/plain.md", { text: "plain", sealed: false });
    vm.openLocal("plain.md", "/w/plain.md", "plain");
    await settle();
    expect(invoke).toHaveBeenCalledWith("sealed_close", { token: 1 });
    expect(vm.isSealed).toBe(false);
  });

  it("uses a remembered passphrase without asking, and asks when it is not the file's", async () => {
    remembered = "pw";
    disk.set("/w/a.md", { text: "a", sealed: true, pw: "pw" });
    disk.set("/w/b.md", { text: "b", sealed: true, pw: "other" });
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;

    expect(await vm.openSealed("a.md", "/w/a.md")).toBe(true);
    expect(w.find('[data-testid="lock-password"]').exists()).toBe(false);
    expect(invoke).toHaveBeenCalledWith("sealed_open", { path: "/w/a.md", password: null });
    expect(vm.isSealed).toBe(true);

    const pending = vm.openSealed("b.md", "/w/b.md");
    await settle();
    expect(w.find('[data-testid="lock-password"]').exists()).toBe(true);
    await w.get('[data-testid="lock-password"]').setValue("wrong");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    // A wrong passphrase is a sentence, not raw Rust, and the file stays where it was.
    expect(w.get('[data-testid="lock-error"]').text()).toContain("Wrong password");
    expect(vm.name).toBe("a.md");
    await w.get('[data-testid="lock-password"]').setValue("other");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(vm.name).toBe("b.md");
    expect((await aceOf(w)).getValue()).toBe("b");
  });

  it("shows an encrypted picture from memory, read-only, with no session", async () => {
    disk.set("/w/p.png", { text: "", sealed: true, pw: "pw" });
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    const pending = vm.openSealed("p.png", "/w/p.png");
    await settle();
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(w.get('[data-testid="image-preview"]').attributes("src")).toBe("data:image/png;base64,iVBORw==");
    expect(vm.isSealed).toBe(true);
    expect(vm.canSave).toBe(false);
    expect(calls("sealed_open")).toHaveLength(0);
  });

  it("reaches the same flow when Open picks an encrypted file", async () => {
    disk.set("/w/s.md", { text: "s", sealed: true, pw: "pw" });
    const { open } = await import("@tauri-apps/plugin-dialog");
    (open as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("/w/s.md");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm & { openFile(): Promise<void> };
    const pending = vm.openFile();
    await settle();
    expect(w.find('[data-testid="lock-password"]').exists()).toBe(true);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    await pending;
    expect(vm.name).toBe("s.md");
    expect(vm.isSealed).toBe(true);
  });
});

describe("encrypting and decrypting the open file", () => {
  it("encrypts a saved plain file, keeps editing it through a session, and decrypts it permanently", async () => {
    disk.set("/w/n.md", { text: "note", sealed: false });
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    vm.openLocal("n.md", "/w/n.md", "note");
    await settle();
    expect(vm.isSealed).toBe(false);

    const pending = vm.encryptFile();
    await settle();
    expect(w.find('[data-testid="lock-confirm"]').exists()).toBe(true);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-confirm"]').setValue("pw");
    await w.get('[data-testid="lock-remember"]').setValue(true);
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(invoke).toHaveBeenCalledWith("lock_file", { path: "/w/n.md", password: "pw" });
    expect(disk.get("/w/n.md")?.sealed).toBe(true);
    expect(vm.isSealed).toBe(true);
    // Remembered only after the passphrase proved to work.
    expect(remembered).toBe("pw");
    // The buffer is the same; the next save re-seals through the session.
    (await aceOf(w)).session.insert({ row: 0, column: 4 }, "!");
    await flushPromises();
    await vm.saveFile();
    await settle();
    expect(calls("sealed_write")).toHaveLength(1);
    expect(disk.get("/w/n.md")).toEqual({ text: "note!", sealed: true, pw: "pw" });

    // Decrypting permanently: the remembered passphrase means no dialog.
    expect(await vm.decryptFile()).toBe(true);
    await settle();
    expect(invoke).toHaveBeenCalledWith("unlock_file", { path: "/w/n.md", password: null });
    expect(disk.get("/w/n.md")?.sealed).toBe(false);
    expect(vm.isSealed).toBe(false);
    expect(calls("sealed_close")).toHaveLength(1);
    // …and saves go plain again.
    (await aceOf(w)).session.insert({ row: 0, column: 5 }, "?");
    await flushPromises();
    await vm.saveFile();
    await settle();
    expect(invoke).toHaveBeenCalledWith("workspace_write_text", { path: "/w/n.md", text: "note!?" });
  });

  it("will not encrypt a never-saved or unsaved file", async () => {
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm & { newFile(k: string): Promise<void> };
    await vm.newFile("markdown");
    await settle();
    expect(await vm.encryptFile()).toBe(false);
    expect(calls("lock_file")).toHaveLength(0);

    disk.set("/w/n.md", { text: "note", sealed: false });
    vm.openLocal("n.md", "/w/n.md", "note");
    await settle();
    (await aceOf(w)).session.insert({ row: 0, column: 0 }, "x");
    await flushPromises();
    expect(vm.dirty).toBe(true);
    expect(await vm.encryptFile()).toBe(false);
    expect(calls("lock_file")).toHaveLength(0);
  });
});

describe("the pane changed the open file's encryption", () => {
  it("decrypted underneath: the session goes and the next save is plain", async () => {
    disk.set("/w/s.md", { text: "secret", sealed: true, pw: "pw" });
    remembered = "pw";
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm & { resync(): Promise<void> };
    await vm.openSealed("s.md", "/w/s.md");
    await settle();
    expect(vm.isSealed).toBe(true);

    // A row shield decrypts it on disk; the pane says so.
    disk.set("/w/s.md", { text: "secret", sealed: false });
    const { useWorkspace } = await import("petalite/files");
    const { setSealProbe } = await import("petalite/files");
    setSealProbe(async (p) => disk.get(p)?.sealed ?? false);
    await vm.resync();
    await settle();
    expect(vm.isSealed).toBe(false);
    expect(calls("sealed_close")).toHaveLength(1);
    (await aceOf(w)).session.insert({ row: 0, column: 6 }, "!");
    await flushPromises();
    await vm.saveFile();
    await settle();
    expect(invoke).toHaveBeenCalledWith("workspace_write_text", { path: "/w/s.md", text: "secret!" });
    setSealProbe(null);
    void useWorkspace;
  });

  it("encrypted underneath: the header says so, and the next save asks for the passphrase and keeps the edit", async () => {
    disk.set("/w/n.md", { text: "note", sealed: false });
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm & { resync(): Promise<void> };
    vm.openLocal("n.md", "/w/n.md", "note");
    await settle();
    (await aceOf(w)).session.insert({ row: 0, column: 4 }, " (unsaved)");
    await flushPromises();

    // A folder run encrypts it on disk — the on-disk version, without the edit.
    disk.set("/w/n.md", { text: "note", sealed: true, pw: "pw" });
    const { setSealProbe } = await import("petalite/files");
    setSealProbe(async (p) => disk.get(p)?.sealed ?? false);
    await vm.resync();
    await settle();
    expect(vm.isSealed).toBe(true);
    expect(vm.dirty).toBe(true);

    const pending = vm.saveFile();
    await settle();
    expect(w.get('[data-testid="lock-consequence"]').text()).toContain("encrypted while it was open");
    // No price: the plaintext is already on screen.
    expect(w.find('[data-testid="mana-cost"]').exists()).toBe(false);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    await pending;
    expect(calls("workspace_write_text")).toHaveLength(0);
    expect(disk.get("/w/n.md")).toEqual({ text: "note (unsaved)", sealed: true, pw: "pw" });
    expect(vm.dirty).toBe(false);
    setSealProbe(null);
  });
});

describe("the review's fixes", () => {
  it("asks the discard question once when Open picks an encrypted file", async () => {
    disk.set("/w/a.md", { text: "a", sealed: false });
    disk.set("/w/s.md", { text: "s", sealed: true, pw: "pw" });
    const { open } = await import("@tauri-apps/plugin-dialog");
    (open as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("/w/s.md");
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm & { openFile(): Promise<void> };
    vm.openLocal("a.md", "/w/a.md", "a");
    await settle();
    (await aceOf(w)).session.insert({ row: 0, column: 1 }, "!");
    await flushPromises();

    const pending = vm.openFile();
    await settle();
    await w.get('[data-testid="discard-confirm"]').trigger("click");
    await settle();
    // Straight to the passphrase; the discard question is not asked again.
    expect(w.find('[data-testid="discard-confirm"]').exists()).toBe(false);
    expect(w.find('[data-testid="lock-password"]').exists()).toBe(true);
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    await pending;
    expect(vm.name).toBe("s.md");
  });

  it("remembers the passphrase from the decrypt dialog when asked, once it worked", async () => {
    disk.set("/w/s.md", { text: "s", sealed: true, pw: "pw" });
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    let pending: Promise<boolean> = vm.openSealed("s.md", "/w/s.md");
    await settle();
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    await pending;

    pending = vm.decryptFile();
    await settle();
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-remember"]').setValue(true);
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(await pending).toBe(true);
    expect(remembered).toBe("pw");
  });

  it("says a workspace refusal as a sentence inside the passphrase dialog", async () => {
    disk.set("/w/doc.pdf", { text: "", sealed: true, pw: "pw" });
    const orig = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Args) => {
      if (cmd === "sealed_open") throw "not_text: that file is not a text file";
      return orig(cmd, args);
    });
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm;
    void vm.openSealed("doc.pdf", "/w/doc.pdf");
    await settle();
    await w.get('[data-testid="lock-password"]').setValue("pw");
    await w.get('[data-testid="lock-submit"]').trigger("click");
    await settle();
    expect(w.get('[data-testid="lock-error"]').text()).toBe("That file is not a text file.");
    invoke.mockImplementation(orig);
  });
});

describe("the pane changed it twice", () => {
  it("encrypted and then decrypted underneath: the file is plain again, and so is the save", async () => {
    disk.set("/w/n.md", { text: "note", sealed: false });
    const { setSealProbe } = await import("petalite/files");
    setSealProbe(async (p) => disk.get(p)?.sealed ?? false);
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm & { resync(): Promise<void> };
    vm.openLocal("n.md", "/w/n.md", "note");
    await settle();

    disk.set("/w/n.md", { text: "note", sealed: true, pw: "pw" });
    await vm.resync();
    expect(vm.isSealed).toBe(true);
    disk.set("/w/n.md", { text: "note", sealed: false });
    await vm.resync();
    expect(vm.isSealed).toBe(false);

    (await aceOf(w)).session.insert({ row: 0, column: 4 }, "!");
    await flushPromises();
    await vm.saveFile();
    await settle();
    expect(invoke).toHaveBeenCalledWith("workspace_write_text", { path: "/w/n.md", text: "note!" });
    setSealProbe(null);
  });

  it("says so when a save is cancelled at the passphrase", async () => {
    disk.set("/w/n.md", { text: "note", sealed: false });
    const { setSealProbe } = await import("petalite/files");
    setSealProbe(async (p) => disk.get(p)?.sealed ?? false);
    const w = mountHost();
    await flushPromises();
    const vm = w.vm as unknown as HostVm & { resync(): Promise<void> };
    vm.openLocal("n.md", "/w/n.md", "note");
    await settle();
    (await aceOf(w)).session.insert({ row: 0, column: 4 }, "!");
    await flushPromises();
    disk.set("/w/n.md", { text: "note", sealed: true, pw: "pw" });
    await vm.resync();

    const pending = vm.saveFile();
    await settle();
    // Close the passphrase dialog without typing anything.
    const cancel = w.findAll("button").find((b) => b.text() === "Cancel")!;
    await cancel.trigger("click");
    await settle();
    await pending;
    expect(vm.fileError).toBe("Not saved: the file is encrypted and its passphrase was not given.");
    expect(vm.dirty).toBe(true);
    expect(calls("sealed_write")).toHaveLength(0);
    expect(calls("workspace_write_text")).toHaveLength(0);
    setSealProbe(null);
  });
});
