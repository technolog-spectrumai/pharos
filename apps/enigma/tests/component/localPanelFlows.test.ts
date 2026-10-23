// Files → Local, mounted whole, in Tauri mode against a small fake disk.
//
// The panel is the only place a file's passphrase exists: it is typed into the
// modal, kept on the open note while the editor is up, and handed to Rust on
// every save. So what is pinned here is what reaches the backend — which
// command, with exactly which passphrase (or an explicit null for plaintext) —
// and what the panel remembers afterwards in the kv index. The list is a
// reminder of what is locked, never the source of truth: every row is
// reconciled against the disk on refresh.
//
// localPanel.test.ts covers the recents row's lock button; this file covers
// the list, the lock/unlock/rotate round trips and the editor's save path.
//
// The Tauri API is faked one level down, at its IPC hook (see
// contactsView.test.ts for why not vi.mock): the dialog plugin goes through the
// same hook, so the native pickers are just two more commands in the table.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { formatBytes, formatDate, initBuildConfig, type LockedFileRecord, type NoteRecentRecord } from "rakotis";

vi.mock("../../src/components/local/aceSetup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/components/local/aceSetup")>()),
  default: (await import("../stubs/fakeAce")).fakeAce,
}));

import "@tauri-apps/api/core";
// The panel imports the dialog plugin lazily; loading it here keeps its first
// transform out of whichever test happens to open a picker first.
import "@tauri-apps/plugin-dialog";
import { i18n } from "../../src/i18n";
import LocalPanel from "../../src/components/local/LocalPanel.vue";
import LocalPassphraseModal from "../../src/components/local/LocalPassphraseModal.vue";
// Loaded up front so the panel's lazy editor chunks resolve from the module cache.
import NoteEditor from "../../src/components/local/NoteEditor.vue";
import SvgEditor from "../../src/components/local/SvgEditor.vue";
import { fakeAce } from "../stubs/fakeAce";

(i18n.global.locale as unknown as { value: string }).value = "en";

const DAY = 86_400_000;

// ── fake backend ────────────────────────────────────────────────────────────
// Rust's commands reject with a plain string, which is what the panel shows.
const rustErr = (msg: string) => Promise.reject(msg);

interface DiskFile {
  content: string;
  /** Sealed under `pass` (ENIGLOCK). */
  locked: boolean;
  pass?: string;
}
let disk: Record<string, DiskFile>;
const kv = new Map<string, string>();
let rings: Array<{ id: string; name: string; entryCount: number }>;
/** What the native pickers answer next (null = the user cancelled). */
let dialog: { open: string | null; save: string | null };

const baseName = (p: string) => p.split("/").pop()!;

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args);
});
const callsTo = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

function defaultHandlers(): Record<string, Handler> {
  const file = (a: Record<string, unknown>) => disk[a.path as string];
  return {
    kv_get: (a) => kv.get(`${a.ns}/${a.scope}/${a.k}`) ?? null,
    kv_put: (a) => {
      kv.set(`${a.ns}/${a.scope}/${a.k}`, String(a.v));
    },
    panic_targets_resync: () => null,
    keyring_list: () => rings,
    "plugin:dialog|open": () => dialog.open,
    "plugin:dialog|save": () => dialog.save,
    local_is_locked: (a) => file(a)?.locked ?? false,
    local_note_stat: (a) => {
      const f = file(a);
      return f ? { exists: true, locked: f.locked, size: f.content.length } : { exists: false, locked: false, size: 0 };
    },
    local_note_read: (a) => {
      const f = file(a);
      if (!f) return rustErr("No such file or directory (os error 2)");
      if (f.locked && a.passphrase !== f.pass) return rustErr("wrong passphrase");
      return { name: baseName(a.path as string), content: f.content, locked: f.locked, size: f.content.length };
    },
    local_note_write: (a) => {
      const f = file(a);
      const pass = a.passphrase as string | null;
      // A save re-derives the key from the file's current header: a file
      // re-keyed elsewhere fails closed instead of being clobbered.
      if (f?.locked && pass === null) return rustErr("refusing to write plaintext over a locked file");
      if (f?.locked && pass !== f.pass) return rustErr("wrong passphrase");
      const content = a.content as string;
      disk[a.path as string] = { content, locked: pass !== null, pass: pass ?? undefined };
      return { name: baseName(a.path as string), size: content.length };
    },
    local_lock_file: (a) => {
      const f = file(a)!;
      disk[a.path as string] = { ...f, locked: true, pass: a.passphrase as string };
      return { name: baseName(a.path as string), size: f.content.length };
    },
    local_unlock_file: (a) => {
      const f = file(a)!;
      if (a.passphrase !== f.pass) return rustErr("wrong passphrase");
      disk[a.path as string] = { content: f.content, locked: false };
      return { name: baseName(a.path as string), size: f.content.length };
    },
    local_rotate_file: (a) => {
      const f = file(a)!;
      if (a.current !== f.pass) return rustErr("wrong passphrase");
      f.pass = a.new as string;
      return { name: baseName(a.path as string), size: f.content.length };
    },
  };
}

const lockedIndex = (): LockedFileRecord[] => JSON.parse(kv.get("files:local/default/index") ?? "[]");
const recents = (): NoteRecentRecord[] => JSON.parse(kv.get("files:local/default/notes") ?? "[]");
const seedLocked = (records: LockedFileRecord[]) => kv.set("files:local/default/index", JSON.stringify(records));
const seedRecents = (records: NoteRecentRecord[]) => kv.set("files:local/default/notes", JSON.stringify(records));
const seedRotationDays = (days: number) => kv.set("p2p:settings/default/file_key_rotation_days", String(days));

beforeEach(() => {
  invokeMock.mockClear();
  kv.clear();
  disk = {};
  rings = [];
  dialog = { open: null, save: null };
  handlers = defaultHandlers();
  fakeAce.reset();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
});

// ── mounting + finding things ───────────────────────────────────────────────
async function settle() {
  for (let i = 0; i < 5; i++) await flushPromises();
}

async function mountPanel() {
  const w = mount(LocalPanel, {
    props: { darkMode: false },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
  await settle();
  return w;
}

/** A list row (locked file or recent) by the name it shows. */
function row(w: VueWrapper, name: string) {
  const found = w
    .findAll("div.rounded-lg.border.px-3.py-2")
    .find((d) => d.find(".truncate.text-sm.font-semibold").text() === name);
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}
const rowButton = (w: VueWrapper, name: string, label: string) => row(w, name).find(`button[aria-label='${label}']`);

const passModal = (w: VueWrapper) => w.findComponent(LocalPassphraseModal);

/** Type into the passphrase modal's fields in order, then press its primary button. */
async function answerPassphrase(w: VueWrapper, ...values: string[]) {
  const modal = passModal(w);
  const inputs = modal.findAll("input[type='password']");
  for (const [i, v] of values.entries()) await inputs[i].setValue(v);
  const buttons = modal.findAll("button");
  await buttons[buttons.length - 1].trigger("click");
  await settle();
}

/** The lazy editor chunk resolves on its own schedule; wait for it to mount. */
async function editorUp(w: VueWrapper) {
  await vi.waitFor(() => expect(w.findComponent(NoteEditor).exists()).toBe(true), { timeout: 5000 });
  return fakeAce.last();
}

const editorSave = (w: VueWrapper) =>
  w
    .findComponent(NoteEditor)
    .findAll("button")
    .find((b) => b.text().includes("Save"))!
    .trigger("click");

async function newFile(w: VueWrapper, typedName: string, choice: "text" | "svg" | "open") {
  await w.find("[data-testid='new-file']").trigger("click");
  await w.find("[data-testid='new-file-name']").setValue(typedName);
  await w.find(`[data-testid='new-file-${choice}']`).trigger("click");
  await settle();
}

function plain(content: string): DiskFile {
  return { content, locked: false };
}
function sealed(content: string, pass: string): DiskFile {
  return { content, locked: true, pass };
}
function lockedRec(path: string, over: Partial<LockedFileRecord> = {}): LockedFileRecord {
  return { path, name: baseName(path), size: 4, lockedAt: Date.now() - DAY, ...over };
}
function recentRec(path: string, over: Partial<NoteRecentRecord> = {}): NoteRecentRecord {
  return { path, name: baseName(path), size: 4, locked: false, openedAt: 1_700_000_000_000, ...over };
}

// ── outside Tauri ───────────────────────────────────────────────────────────
describe("LocalPanel — outside the desktop app", () => {
  it("shows the desktop-only notice and never reaches for the backend", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const w = await mountPanel();
    expect(w.text()).toContain("Local file locking is available in the desktop app only.");
    expect(w.find("[data-testid='new-file']").exists()).toBe(false);
    expect(w.find("button[aria-label='Refresh']").exists()).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// ── the locked-file list ────────────────────────────────────────────────────
describe("LocalPanel — the locked-file list", () => {
  it("says so when nothing is locked yet", async () => {
    const w = await mountPanel();
    expect(w.text()).toContain("No locked files yet.");
  });

  it("lists each remembered file with its size and the date of its key", async () => {
    const lockedAt = new Date(2026, 2, 3).getTime();
    const rotatedAt = new Date(2026, 5, 7).getTime();
    disk["/home/a/tax.pdf"] = sealed("....", "pw");
    disk["/home/a/plan.txt"] = sealed("....", "pw");
    seedLocked([
      lockedRec("/home/a/tax.pdf", { size: 2048, lockedAt }),
      lockedRec("/home/a/plan.txt", { size: 10, lockedAt, rotatedAt }),
    ]);
    const w = await mountPanel();

    expect(row(w, "tax.pdf").text()).toContain(`${formatBytes(2048)} · ${formatDate(new Date(lockedAt), "date")}`);
    // A rotated key is dated by its rotation, not the original lock.
    expect(row(w, "plan.txt").text()).toContain(formatDate(new Date(rotatedAt), "date"));
    expect(w.text()).not.toContain("No locked files yet.");
  });

  it("flags a record whose file is no longer locked on disk, and only lets you forget it", async () => {
    // Unlocked by something else (or replaced): the record is stale.
    disk["/home/a/old.txt"] = plain("hello");
    seedLocked([lockedRec("/home/a/old.txt")]);
    const w = await mountPanel();

    expect(row(w, "old.txt").text()).toContain("not locked on disk");
    for (const label of ["Edit", "Unlock", "Rotate key"]) {
      expect(rowButton(w, "old.txt", label).attributes("disabled"), label).toBeDefined();
    }
    expect(rowButton(w, "old.txt", "Remove from list").attributes("disabled")).toBeUndefined();
  });

  it("checks a ring file by existence — its .enigr carries no ENIGLOCK magic", async () => {
    disk["/home/a/f.txt.enigr"] = plain("ring-sealed bytes");
    seedLocked([lockedRec("/home/a/f.txt.enigr", { ring: true, ringId: "default" })]);
    const w = await mountPanel();

    expect(row(w, "f.txt.enigr").text()).not.toContain("not locked on disk");
    expect(callsTo("local_is_locked")).toEqual([]);
    expect(callsTo("local_note_stat")).toEqual([{ path: "/home/a/f.txt.enigr" }]);
    // The editor cannot open ENIGRLK, and the ring rotates as a whole.
    expect(rowButton(w, "f.txt.enigr", "Edit").exists()).toBe(false);
    expect(rowButton(w, "f.txt.enigr", "Rotate key").exists()).toBe(false);
    expect(rowButton(w, "f.txt.enigr", "Unlock").exists()).toBe(true);
  });

  it("a ring file gone from disk is flagged too", async () => {
    seedLocked([lockedRec("/home/a/gone.txt.enigr", { ring: true, ringId: "default" })]);
    const w = await mountPanel();
    expect(row(w, "gone.txt.enigr").text()).toContain("not locked on disk");
  });

  it("marks a key older than the reminder interval as rotation due", async () => {
    seedRotationDays(30);
    for (const p of ["/home/a/stale.txt", "/home/a/fresh.txt", "/home/a/rerolled.txt"]) disk[p] = sealed("x", "pw");
    seedLocked([
      lockedRec("/home/a/stale.txt", { lockedAt: Date.now() - 31 * DAY }),
      lockedRec("/home/a/fresh.txt", { lockedAt: Date.now() - 29 * DAY }),
      // Old lock, recent rotation: the rotation resets the clock.
      lockedRec("/home/a/rerolled.txt", { lockedAt: Date.now() - 300 * DAY, rotatedAt: Date.now() - DAY }),
    ]);
    const w = await mountPanel();

    expect(row(w, "stale.txt").text()).toContain("rotation due");
    expect(row(w, "fresh.txt").text()).not.toContain("rotation due");
    expect(row(w, "rerolled.txt").text()).not.toContain("rotation due");
  });

  it("never nags when the reminder is off, or about a file that is no longer locked", async () => {
    disk["/home/a/stale.txt"] = sealed("x", "pw");
    disk["/home/a/unsealed.txt"] = plain("x");
    seedLocked([
      lockedRec("/home/a/stale.txt", { lockedAt: Date.now() - 400 * DAY }),
      lockedRec("/home/a/unsealed.txt", { lockedAt: Date.now() - 400 * DAY }),
    ]);
    const off = await mountPanel();
    expect(off.text()).not.toContain("rotation due");

    seedRotationDays(30);
    const on = await mountPanel();
    expect(row(on, "stale.txt").text()).toContain("rotation due");
    expect(row(on, "unsealed.txt").text()).not.toContain("rotation due");
  });

  it("asks before forgetting, and forgetting drops only the record", async () => {
    disk["/home/a/a.txt"] = sealed("secret", "pw");
    seedLocked([lockedRec("/home/a/a.txt")]);
    const w = await mountPanel();

    await rowButton(w, "a.txt", "Remove from list").trigger("click");
    expect(w.text()).toContain("Remove “a.txt” from this list?");
    await w.findAll("button").find((b) => b.text() === "Cancel")!.trigger("click");
    expect(w.text()).not.toContain("Remove “a.txt” from this list?");
    expect(lockedIndex()).toHaveLength(1);

    await rowButton(w, "a.txt", "Remove from list").trigger("click");
    await w.findAll("button").find((b) => b.text() === "Remove from list" && !b.attributes("aria-label"))!.trigger("click");
    await settle();

    expect(lockedIndex()).toEqual([]);
    expect(w.text()).toContain("No locked files yet.");
    // The file itself stays sealed: forgetting is not unlocking.
    expect(disk["/home/a/a.txt"]).toEqual(sealed("secret", "pw"));
    expect(callsTo("local_unlock_file")).toEqual([]);
  });

  it("Refresh re-reads the index and the disk", async () => {
    const w = await mountPanel();
    disk["/home/a/late.txt"] = sealed("x", "pw");
    seedLocked([lockedRec("/home/a/late.txt")]);

    await w.find("button[aria-label='Refresh']").trigger("click");
    await settle();
    expect(row(w, "late.txt").exists()).toBe(true);
  });
});

// ── lock / unlock / rotate ──────────────────────────────────────────────────
describe("LocalPanel — lock, unlock, rotate", () => {
  it("locks a file picked in the dialog under a new passphrase and remembers it", async () => {
    disk["/home/a/diary.txt"] = plain("dear diary");
    dialog.open = "/home/a/diary.txt";
    const w = await mountPanel();

    await w.findAll("button").find((b) => b.text().includes("Lock a file…"))!.trigger("click");
    await settle();
    expect(callsTo("plugin:dialog|open")).toEqual([{ options: { multiple: false, directory: false } }]);
    expect(passModal(w).props()).toMatchObject({ open: true, mode: "lock", name: "diary.txt", fileSize: 10 });

    await answerPassphrase(w, "correct horse", "correct horse");
    expect(callsTo("local_lock_file")).toEqual([{ path: "/home/a/diary.txt", passphrase: "correct horse" }]);
    const [rec] = lockedIndex();
    expect(rec).toMatchObject({ path: "/home/a/diary.txt", name: "diary.txt", size: 10 });
    expect(rec.ring).toBeUndefined();
    expect(row(w, "diary.txt").exists()).toBe(true);
  });

  it("a cancelled picker opens nothing", async () => {
    const w = await mountPanel();
    await w.findAll("button").find((b) => b.text().includes("Lock a file…"))!.trigger("click");
    await settle();
    expect(passModal(w).props("open")).toBe(false);
    expect(callsTo("local_note_stat")).toEqual([]);
  });

  it("locks into the key ring when one exists, recording the .enigr path and the ring", async () => {
    rings = [{ id: "default", name: "Personal", entryCount: 0 }];
    disk["/home/a/diary.txt"] = plain("dear diary");
    dialog.open = "/home/a/diary.txt";
    handlers.keyring_lock = (a) => [{ path: (a.paths as string[])[0], status: "locked", newPath: "/home/a/diary.txt.enigr" }];
    const w = await mountPanel();

    await w.findAll("button").find((b) => b.text().includes("Lock a file…"))!.trigger("click");
    await settle();
    await passModal(w).find("[data-testid='lock-method-ring']").trigger("click");
    await answerPassphrase(w, "ring pass");

    expect(callsTo("keyring_lock")).toEqual([
      { ringId: "default", passphrase: "ring pass", paths: ["/home/a/diary.txt"] },
    ]);
    expect(lockedIndex()).toEqual([
      expect.objectContaining({
        path: "/home/a/diary.txt.enigr",
        name: "diary.txt.enigr",
        size: 10,
        ring: true,
        ringId: "default",
      }),
    ]);
  });

  it("unlocking decrypts in place and drops the record", async () => {
    disk["/home/a/a.txt"] = sealed("secret", "pw");
    seedLocked([lockedRec("/home/a/a.txt")]);
    const w = await mountPanel();

    await rowButton(w, "a.txt", "Unlock").trigger("click");
    expect(passModal(w).props()).toMatchObject({ open: true, mode: "unlock", path: "/home/a/a.txt", ringForced: false });
    await answerPassphrase(w, "pw");

    expect(callsTo("local_unlock_file")).toEqual([{ path: "/home/a/a.txt", passphrase: "pw" }]);
    expect(lockedIndex()).toEqual([]);
    expect(disk["/home/a/a.txt"].locked).toBe(false);
    expect(passModal(w).props("open")).toBe(false);
  });

  it("a wrong passphrase keeps both the record and the modal", async () => {
    disk["/home/a/a.txt"] = sealed("secret", "pw");
    seedLocked([lockedRec("/home/a/a.txt")]);
    const w = await mountPanel();

    await rowButton(w, "a.txt", "Unlock").trigger("click");
    await answerPassphrase(w, "nope");

    expect(passModal(w).props("open")).toBe(true);
    expect(passModal(w).text()).toContain("wrong passphrase");
    expect(lockedIndex()).toHaveLength(1);
  });

  it("a ring-locked record unlocks through the ring that holds its key", async () => {
    disk["/home/a/f.txt.enigr"] = plain("ring-sealed");
    seedLocked([lockedRec("/home/a/f.txt.enigr", { ring: true, ringId: "ab12" })]);
    handlers.keyring_unlock = () => [{ path: "/home/a/f.txt.enigr", status: "unlocked", newPath: "/home/a/f.txt" }];
    const w = await mountPanel();

    await rowButton(w, "f.txt.enigr", "Unlock").trigger("click");
    expect(passModal(w).props()).toMatchObject({ ringForced: true, ringId: "ab12" });
    await answerPassphrase(w, "ring pass");

    expect(callsTo("keyring_unlock")).toEqual([
      { ringId: "ab12", passphrase: "ring pass", paths: ["/home/a/f.txt.enigr"] },
    ]);
    expect(callsTo("local_unlock_file")).toEqual([]);
    expect(lockedIndex()).toEqual([]);
  });

  it("rotation keeps the original lock date and stamps the rotation", async () => {
    const lockedAt = Date.now() - 90 * DAY;
    disk["/home/a/a.txt"] = sealed("secret", "pw");
    seedLocked([lockedRec("/home/a/a.txt", { lockedAt })]);
    const w = await mountPanel();
    const before = Date.now();

    await rowButton(w, "a.txt", "Rotate key").trigger("click");
    expect(passModal(w).props("mode")).toBe("rotate");
    // Blank new passphrase: same passphrase, fresh key.
    await answerPassphrase(w, "pw");

    expect(callsTo("local_rotate_file")).toEqual([{ path: "/home/a/a.txt", current: "pw", new: "pw" }]);
    const [rec] = lockedIndex();
    expect(rec.lockedAt).toBe(lockedAt);
    expect(rec.rotatedAt).toBeGreaterThanOrEqual(before);
  });
});

// ── the notes editor ────────────────────────────────────────────────────────
describe("LocalPanel — opening files in the editor", () => {
  it("opens a plain file straight into the editor and moves it to the top of recents", async () => {
    disk["/home/a/todo.txt"] = plain("milk");
    disk["/home/a/older.txt"] = plain("x");
    seedRecents([recentRec("/home/a/older.txt"), recentRec("/home/a/todo.txt")]);
    const w = await mountPanel();

    await rowButton(w, "todo.txt", "Edit").trigger("click");
    const ed = await editorUp(w);

    // An explicit null: serde must see Option::None, not a missing field.
    expect(callsTo("local_note_read")).toEqual([{ path: "/home/a/todo.txt", passphrase: null }]);
    expect(ed.getValue()).toBe("milk");
    expect(w.findComponent(NoteEditor).props()).toMatchObject({ name: "todo.txt", locked: false });
    await settle();
    expect(recents().map((r) => r.path)).toEqual(["/home/a/todo.txt", "/home/a/older.txt"]);
    expect(recents()[0].openedAt).toBeGreaterThan(1_700_000_000_000);
  });

  it("asks for the passphrase before opening a locked file, and keeps asking on a wrong one", async () => {
    disk["/home/a/a.txt"] = sealed("secret", "pw");
    seedLocked([lockedRec("/home/a/a.txt")]);
    const w = await mountPanel();

    await rowButton(w, "a.txt", "Edit").trigger("click");
    await settle();
    expect(passModal(w).props()).toMatchObject({ open: true, mode: "open", name: "a.txt" });
    expect(passModal(w).text()).toContain("Open encrypted file");

    await answerPassphrase(w, "nope");
    expect(passModal(w).text()).toContain("wrong passphrase");
    expect(w.findComponent(NoteEditor).exists()).toBe(false);

    await answerPassphrase(w, "pw");
    const ed = await editorUp(w);
    expect(ed.getValue()).toBe("secret");
    expect(w.findComponent(NoteEditor).text()).toContain("Encrypted on disk");
    expect(callsTo("local_note_read").at(-1)).toEqual({ path: "/home/a/a.txt", passphrase: "pw" });
  });

  it("shows a read failure on the list instead of opening", async () => {
    seedRecents([recentRec("/home/a/moved.txt")]);
    // The stat said it exists (a race with a move); the read is what fails.
    handlers.local_note_stat = () => ({ exists: true, locked: false, size: 4 });
    const w = await mountPanel();

    await rowButton(w, "moved.txt", "Edit").trigger("click");
    await settle();
    expect(w.find("p.text-warn-dark").text()).toBe("No such file or directory (os error 2)");
    expect(w.find("[data-testid='new-file']").exists()).toBe(true);
  });

  it("opens an existing file through New file → Open file…", async () => {
    disk["/home/a/conf.json"] = plain("{}");
    dialog.open = "/home/a/conf.json";
    const w = await mountPanel();

    await newFile(w, "", "open");
    const ed = await editorUp(w);
    expect(ed.getValue()).toBe("{}");
    expect(ed.options.mode).toBe("ace/mode/json");
  });

  it("a cancelled Open file… stays on the list", async () => {
    const w = await mountPanel();
    await newFile(w, "", "open");
    expect(callsTo("plugin:dialog|open")).toHaveLength(1);
    expect(callsTo("local_note_read")).toEqual([]);
    expect(w.find("[data-testid='new-file']").exists()).toBe(true);
  });

  it("flags a recent file that is gone from disk and will not open it", async () => {
    seedRecents([recentRec("/home/a/gone.txt")]);
    const w = await mountPanel();
    expect(row(w, "gone.txt").text()).toContain("file not found");
    expect(rowButton(w, "gone.txt", "Edit").attributes("disabled")).toBeDefined();
    expect(row(w, "gone.txt").find("[data-testid='recent-lock']").exists()).toBe(false);
  });

  it("removing a recent forgets the record and leaves the file alone", async () => {
    disk["/home/a/todo.txt"] = plain("milk");
    seedRecents([recentRec("/home/a/todo.txt")]);
    const w = await mountPanel();

    await rowButton(w, "todo.txt", "Remove from list").trigger("click");
    await settle();
    expect(recents()).toEqual([]);
    expect(w.text()).not.toContain("Recently edited");
    expect(disk["/home/a/todo.txt"]).toEqual(plain("milk"));
  });
});

describe("LocalPanel — saving from the editor", () => {
  async function openPlain(path = "/home/a/todo.txt", content = "milk") {
    disk[path] = plain(content);
    seedRecents([recentRec(path)]);
    const w = await mountPanel();
    await rowButton(w, baseName(path), "Edit").trigger("click");
    const ed = await editorUp(w);
    return { w, ed };
  }

  async function openSealed(pass = "pw") {
    disk["/home/a/a.txt"] = sealed("secret", pass);
    const lockedAt = Date.now() - 10 * DAY;
    seedLocked([lockedRec("/home/a/a.txt", { lockedAt })]);
    const w = await mountPanel();
    await rowButton(w, "a.txt", "Edit").trigger("click");
    await settle();
    await answerPassphrase(w, pass);
    const ed = await editorUp(w);
    return { w, ed, lockedAt };
  }

  it("writes a plain file as plaintext and clears the unsaved mark", async () => {
    const { w, ed } = await openPlain();
    ed.type("milk, eggs");
    await settle();
    expect(w.findComponent(NoteEditor).find("[title='Unsaved changes']").exists()).toBe(true);

    await editorSave(w);
    await settle();
    expect(callsTo("local_note_write")).toEqual([
      { path: "/home/a/todo.txt", content: "milk, eggs", passphrase: null },
    ]);
    expect(disk["/home/a/todo.txt"]).toEqual(plain("milk, eggs"));
    expect(w.findComponent(NoteEditor).find("[title='Unsaved changes']").exists()).toBe(false);
    expect(recents()[0]).toMatchObject({ path: "/home/a/todo.txt", size: 10, locked: false });
  });

  it("re-seals a locked file with the passphrase it was opened with, keeping its lock date", async () => {
    const { w, ed, lockedAt } = await openSealed();
    ed.type("more secret");
    await editorSave(w);
    await settle();

    expect(callsTo("local_note_write")).toEqual([
      { path: "/home/a/a.txt", content: "more secret", passphrase: "pw" },
    ]);
    expect(disk["/home/a/a.txt"]).toEqual(sealed("more secret", "pw"));
    expect(lockedIndex()).toEqual([expect.objectContaining({ path: "/home/a/a.txt", size: 11, lockedAt })]);
  });

  it("asks again when the file was re-keyed elsewhere, then saves with the new passphrase", async () => {
    const { w, ed } = await openSealed("pw");
    disk["/home/a/a.txt"].pass = "pw2"; // rotated from another window
    ed.type("edited");
    await editorSave(w);
    await settle();

    // Fails closed, then re-prompts rather than clobbering or giving up.
    expect(passModal(w).props()).toMatchObject({ open: true, mode: "open" });
    expect(disk["/home/a/a.txt"].content).toBe("secret");
    await answerPassphrase(w, "pw2");
    expect(disk["/home/a/a.txt"]).toEqual(sealed("edited", "pw2"));

    // ...and the note keeps the passphrase that worked.
    ed.type("edited again");
    await editorSave(w);
    await settle();
    expect(callsTo("local_note_write").at(-1)).toEqual({ path: "/home/a/a.txt", content: "edited again", passphrase: "pw2" });
  });

  it("keeps any other save error in the editor, with the buffer intact", async () => {
    const { w, ed } = await openPlain();
    handlers.local_note_write = () => rustErr("No space left on device (os error 28)");
    ed.type("milk, eggs");
    await editorSave(w);
    await settle();

    expect(w.findComponent(NoteEditor).props("error")).toBe("No space left on device (os error 28)");
    expect(w.findComponent(NoteEditor).text()).toContain("No space left on device");
    expect(passModal(w).props("open")).toBe(false);
    expect(ed.getValue()).toBe("milk, eggs");
  });

  it("a new note asks where to go, suggesting the name that was typed", async () => {
    dialog.save = "/home/a/lists/shopping.txt";
    const w = await mountPanel();
    await newFile(w, "shopping", "text");
    const ed = await editorUp(w);
    ed.type("bread");
    await editorSave(w);
    await settle();

    expect(callsTo("plugin:dialog|save")).toEqual([{ options: { defaultPath: "shopping.txt" } }]);
    expect(callsTo("local_note_write")).toEqual([
      { path: "/home/a/lists/shopping.txt", content: "bread", passphrase: null },
    ]);
    expect(w.findComponent(NoteEditor).props()).toMatchObject({ path: "/home/a/lists/shopping.txt", name: "shopping.txt" });
    expect(recents()[0]).toMatchObject({ path: "/home/a/lists/shopping.txt", name: "shopping.txt" });
  });

  it("cancelling Save As writes nothing", async () => {
    const w = await mountPanel();
    await newFile(w, "", "text");
    const ed = await editorUp(w);
    ed.type("draft");
    await editorSave(w);
    await settle();
    expect(callsTo("plugin:dialog|save")).toHaveLength(1);
    expect(callsTo("local_note_write")).toEqual([]);
    expect(w.findComponent(NoteEditor).props("path")).toBeNull();
  });

  it("names a new file from what was typed: extension kept, separators dropped, blank is untitled", async () => {
    const w = await mountPanel();
    const suggested: string[] = [];
    for (const typed of ["notes.md", " a/b:c ", "", "plan"]) {
      await newFile(w, typed, "text");
      await editorUp(w);
      await editorSave(w);
      await settle();
      suggested.push((callsTo("plugin:dialog|save").at(-1) as { options: { defaultPath: string } }).options.defaultPath);
      // Nothing typed, nothing saved: Back goes straight to the list.
      await w.findComponent(NoteEditor).find("button[aria-label='Back']").trigger("click");
      await settle();
    }
    expect(suggested).toEqual(["notes.md", "abc.txt", "untitled.txt", "plan.txt"]);
  });

  it("encrypting an open file seals it on disk right away", async () => {
    const { w, ed } = await openPlain();
    ed.type("now private");
    await w.findComponent(NoteEditor).find("button[aria-label='Encrypt…']").trigger("click");
    expect(passModal(w).props()).toMatchObject({ open: true, mode: "encrypt", name: "todo.txt" });
    await answerPassphrase(w, "long enough", "long enough");

    // The live buffer is what gets sealed, not the text the file was opened with.
    expect(callsTo("local_note_write")).toEqual([
      { path: "/home/a/todo.txt", content: "now private", passphrase: "long enough" },
    ]);
    expect(disk["/home/a/todo.txt"]).toEqual(sealed("now private", "long enough"));
    expect(w.findComponent(NoteEditor).props("locked")).toBe(true);
    expect(lockedIndex()).toEqual([expect.objectContaining({ path: "/home/a/todo.txt", name: "todo.txt" })]);
    expect(recents()[0]).toMatchObject({ path: "/home/a/todo.txt", locked: true });
  });

  it("encrypting a never-saved note writes nothing until its first save — and that save is sealed", async () => {
    dialog.save = "/home/a/secret.txt";
    const w = await mountPanel();
    await newFile(w, "secret", "text");
    const ed = await editorUp(w);
    await w.findComponent(NoteEditor).find("button[aria-label='Encrypt…']").trigger("click");
    await answerPassphrase(w, "long enough", "long enough");
    expect(callsTo("local_note_write")).toEqual([]);

    ed.type("never in plaintext");
    await editorSave(w);
    await settle();
    expect(callsTo("local_note_write")).toEqual([
      { path: "/home/a/secret.txt", content: "never in plaintext", passphrase: "long enough" },
    ]);
    expect(w.findComponent(NoteEditor).props("locked")).toBe(true);
    expect(lockedIndex()).toEqual([expect.objectContaining({ path: "/home/a/secret.txt" })]);
  });
});

describe("LocalPanel — leaving the editor", () => {
  async function openAndType() {
    disk["/home/a/todo.txt"] = plain("milk");
    seedRecents([recentRec("/home/a/todo.txt")]);
    const w = await mountPanel();
    await rowButton(w, "todo.txt", "Edit").trigger("click");
    const ed = await editorUp(w);
    return { w, ed };
  }
  const back = (w: VueWrapper) => w.findComponent(NoteEditor).find("button[aria-label='Back']").trigger("click");

  it("goes straight back when nothing changed", async () => {
    const { w } = await openAndType();
    await back(w);
    await settle();
    expect(w.findComponent(NoteEditor).exists()).toBe(false);
    expect(w.text()).not.toContain("Unsaved changes");
  });

  it("asks before throwing away unsaved changes", async () => {
    const { w, ed } = await openAndType();
    ed.type("milk, eggs");
    await settle();
    await back(w);
    expect(w.text()).toContain("“todo.txt” has changes you haven't saved.");

    await w.findAll("button").find((b) => b.text() === "Keep editing")!.trigger("click");
    expect(w.findComponent(NoteEditor).exists()).toBe(true);
    expect(w.text()).not.toContain("has changes you haven't saved");

    await back(w);
    await w.findAll("button").find((b) => b.text() === "Discard")!.trigger("click");
    await settle();
    expect(w.findComponent(NoteEditor).exists()).toBe(false);
    expect(w.find("[data-testid='new-file']").exists()).toBe(true);
    // Discarding is not saving.
    expect(callsTo("local_note_write")).toEqual([]);
    expect(disk["/home/a/todo.txt"]).toEqual(plain("milk"));
  });
});

describe("LocalPanel — drawings", () => {
  it("a new drawing opens the visual editor, named as an .svg", async () => {
    const w = await mountPanel();
    await newFile(w, "floorplan", "svg");
    await vi.waitFor(() => expect(w.findComponent(SvgEditor).exists()).toBe(true), { timeout: 5000 });
    expect(w.findComponent(SvgEditor).props()).toMatchObject({ path: null, name: "floorplan.svg", content: "" });
    expect(w.findComponent(NoteEditor).exists()).toBe(false);
  });

  it("an .svg the visual editor refuses can still be opened as XML", async () => {
    const xml = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
    disk["/home/a/logo.svg"] = plain(xml);
    seedRecents([recentRec("/home/a/logo.svg")]);
    const w = await mountPanel();

    await rowButton(w, "logo.svg", "Edit").trigger("click");
    await vi.waitFor(() => expect(w.find("[data-testid='svg-open-xml']").exists()).toBe(true), { timeout: 5000 });
    expect(fakeAce.count()).toBe(0);

    await w.find("[data-testid='svg-open-xml']").trigger("click");
    const ed = await editorUp(w);
    // Same file, same name — only the editor changed.
    expect(ed.getValue()).toBe(xml);
    expect(ed.options.mode).toBe("ace/mode/xml");
    expect(w.findComponent(NoteEditor).props("name")).toBe("logo.svg");
  });
});

describe("LocalPanel — when the disk cannot be asked", () => {
  // A probe that fails says nothing about the file. The list must not cry
  // "not locked on disk" (and grey out Unlock) just because a check errored.
  it("a failed lock probe keeps the record actionable", async () => {
    seedLocked([lockedRec("/home/a/a.txt"), lockedRec("/home/a/f.txt.enigr", { ring: true, ringId: "default" })]);
    handlers.local_is_locked = () => rustErr("permission denied");
    handlers.local_note_stat = () => rustErr("permission denied");
    const w = await mountPanel();

    expect(w.text()).not.toContain("not locked on disk");
    expect(rowButton(w, "a.txt", "Unlock").attributes("disabled")).toBeUndefined();
    expect(rowButton(w, "f.txt.enigr", "Unlock").attributes("disabled")).toBeUndefined();
  });

  it("a failed stat falls back to what the recents record itself says", async () => {
    seedRecents([recentRec("/home/a/sealed.txt", { locked: true }), recentRec("/home/a/plain.txt")]);
    handlers.local_note_stat = () => rustErr("permission denied");
    const w = await mountPanel();

    // Present (not "file not found"), and the lock offer follows the record.
    expect(w.text()).not.toContain("file not found");
    expect(row(w, "sealed.txt").find("[data-testid='recent-lock']").exists()).toBe(false);
    expect(row(w, "plain.txt").find("[data-testid='recent-lock']").exists()).toBe(true);
  });

  it("a picked file whose size cannot be read still opens the lock prompt", async () => {
    dialog.open = "/home/a/x.txt";
    handlers.local_note_stat = () => rustErr("permission denied");
    const w = await mountPanel();
    await w.findAll("button").find((b) => b.text().includes("Lock a file…"))!.trigger("click");
    await settle();
    expect(passModal(w).props()).toMatchObject({ open: true, mode: "lock", name: "x.txt", fileSize: 0 });
  });
});

describe("LocalPanel — builds without the key ring", () => {
  it("never asks for rings, so the lock prompt offers only a passphrase", async () => {
    await initBuildConfig({ keyring_enabled: false });
    try {
      rings = [{ id: "default", name: "Personal", entryCount: 0 }];
      disk["/home/a/x.txt"] = plain("x");
      dialog.open = "/home/a/x.txt";
      const w = await mountPanel();
      expect(callsTo("keyring_list")).toEqual([]);

      await w.findAll("button").find((b) => b.text().includes("Lock a file…"))!.trigger("click");
      await settle();
      expect(passModal(w).find("[data-testid='lock-method-ring']").exists()).toBe(false);
    } finally {
      await initBuildConfig({ keyring_enabled: true });
    }
  });

  it("a ring list that fails to load just means no ring option", async () => {
    handlers.keyring_list = () => rustErr("keyring disabled in this build");
    disk["/home/a/x.txt"] = plain("x");
    dialog.open = "/home/a/x.txt";
    const w = await mountPanel();
    await w.findAll("button").find((b) => b.text().includes("Lock a file…"))!.trigger("click");
    await settle();
    expect(passModal(w).props("rings")).toEqual([]);
    expect(w.find("p.text-warn-dark").exists()).toBe(false);
  });
});

describe("LocalPanel — dismissing its dialogs", () => {
  const backdrop = (w: VueWrapper) => w.findAll("[data-testid='oya-modal-overlay']");

  it("clicking outside the New file dialog closes it without creating anything", async () => {
    const w = await mountPanel();
    await w.find("[data-testid='new-file']").trigger("click");
    expect(backdrop(w)).toHaveLength(1);
    await backdrop(w)[0].trigger("click");
    expect(w.find("[data-testid='new-file-text']").exists()).toBe(false);
    expect(w.findComponent(NoteEditor).exists()).toBe(false);
  });

  it("clicking outside the forget prompt keeps the record", async () => {
    disk["/home/a/a.txt"] = sealed("secret", "pw");
    seedLocked([lockedRec("/home/a/a.txt")]);
    const w = await mountPanel();
    await rowButton(w, "a.txt", "Remove from list").trigger("click");
    await backdrop(w)[0].trigger("click");
    await settle();
    expect(w.text()).not.toContain("Remove “a.txt” from this list?");
    expect(lockedIndex()).toHaveLength(1);
  });

  it("clicking outside the unsaved-changes prompt keeps editing — it never discards", async () => {
    disk["/home/a/todo.txt"] = plain("milk");
    seedRecents([recentRec("/home/a/todo.txt")]);
    const w = await mountPanel();
    await rowButton(w, "todo.txt", "Edit").trigger("click");
    const ed = await editorUp(w);
    ed.type("milk, eggs");
    await settle();
    await w.findComponent(NoteEditor).find("button[aria-label='Back']").trigger("click");
    await backdrop(w)[0].trigger("click");
    await settle();

    expect(w.findComponent(NoteEditor).exists()).toBe(true);
    expect(w.text()).not.toContain("has changes you haven't saved");
    expect(ed.getValue()).toBe("milk, eggs");
  });
});
