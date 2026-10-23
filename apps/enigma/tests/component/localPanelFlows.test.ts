// Files → Local, mounted whole, in Tauri mode against a small fake disk.
//
// A file's passphrase is typed into the modal and handed straight to Rust; it is
// never stored. So what is pinned here is what reaches the backend — which
// command, with exactly which passphrase — and what the panel remembers
// afterwards in the kv index. The list is a
// reminder of what is locked, never the source of truth: every row is
// reconciled against the disk on refresh.
//
// This file covers the list and the lock/unlock/rotate round trips;
// localPanel.test.ts covers the modal's lock-method chooser.
//
// The Tauri API is faked one level down, at its IPC hook (see
// contactsView.test.ts for why not vi.mock): the dialog plugin goes through the
// same hook, so the native pickers are just two more commands in the table.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { formatBytes, formatDate, initBuildConfig, type LockedFileRecord } from "rakotis";

import "@tauri-apps/api/core";
// The panel imports the dialog plugin lazily; loading it here keeps its first
// transform out of whichever test happens to open a picker first.
import "@tauri-apps/plugin-dialog";
import { i18n } from "../../src/i18n";
import LocalPanel from "../../src/components/local/LocalPanel.vue";
import LocalPassphraseModal from "../../src/components/local/LocalPassphraseModal.vue";

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
/** What the native file picker answers next (null = the user cancelled). */
let dialog: { open: string | null };

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
    local_is_locked: (a) => file(a)?.locked ?? false,
    local_note_stat: (a) => {
      const f = file(a);
      return f ? { exists: true, locked: f.locked, size: f.content.length } : { exists: false, locked: false, size: 0 };
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
const seedLocked = (records: LockedFileRecord[]) => kv.set("files:local/default/index", JSON.stringify(records));
const seedRotationDays = (days: number) => kv.set("p2p:settings/default/file_key_rotation_days", String(days));

beforeEach(() => {
  invokeMock.mockClear();
  kv.clear();
  disk = {};
  rings = [];
  dialog = { open: null };
  handlers = defaultHandlers();
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

/** A locked-file row by the name it shows. */
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

function plain(content: string): DiskFile {
  return { content, locked: false };
}
function sealed(content: string, pass: string): DiskFile {
  return { content, locked: true, pass };
}
function lockedRec(path: string, over: Partial<LockedFileRecord> = {}): LockedFileRecord {
  return { path, name: baseName(path), size: 4, lockedAt: Date.now() - DAY, ...over };
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
    for (const label of ["Unlock", "Rotate key"]) {
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
    // The ring rotates as a whole, not file by file.
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
});
