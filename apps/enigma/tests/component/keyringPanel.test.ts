// Files → Keys in Tauri mode, against an in-memory ring store. keysTab.test.ts
// covers the browser banner; this file covers the ring itself.
//
// The ring is ONE passphrase over many files, and the panel never keeps that
// passphrase beyond the field it was typed into. What is pinned is what each
// gesture sends to Rust (ring id, passphrase, paths — nothing more), that every
// result Rust reports per file is shown rather than summarised away, and that
// switching rings forgets everything typed for the previous one.
//
// The Tauri API is faked at its IPC hook (contactsView.test.ts explains why),
// which also carries the dialog plugin's file picker.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import type { KeyringEntry, KeyringFileOutcome } from "rakotis";

import "@tauri-apps/api/core";
import "@tauri-apps/plugin-dialog";
import { i18n } from "../../src/i18n";
import KeyringPanel from "../../src/components/local/KeyringPanel.vue";

(i18n.global.locale as unknown as { value: string }).value = "en";

// ── fake ring store ─────────────────────────────────────────────────────────
// Rust's keyring commands reject with a plain string; a wrong passphrase reads
// as the AEAD failure it is underneath.
const rustErr = (msg: string) => Promise.reject(msg);
const WRONG = "wrong passphrase or corrupt data";

interface Ring {
  id: string;
  name: string;
  pass: string;
  entries: KeyringEntry[];
}
let store: Ring[];
let nextId: number;
/** What the native file picker answers next (null = cancelled). */
let picked: string | string[] | null;

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args);
});
const callsTo = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

/** The ring named by `ringId`, if `pass` opens it. */
function open(args: Record<string, unknown>, pass = args.passphrase): Ring | Promise<never> {
  const ring = store.find((r) => r.id === args.ringId);
  if (!ring) return rustErr("no key ring exists yet");
  if (ring.pass !== pass) return rustErr(WRONG);
  return ring;
}
const isRing = (r: Ring | Promise<never>): r is Ring => !(r instanceof Promise);

function defaultHandlers(): Record<string, Handler> {
  return {
    keyring_list: () => store.map((r) => ({ id: r.id, name: r.name, entryCount: r.entries.length })),
    keyring_create: (a) => {
      const id = `r${nextId++}`;
      store.push({ id, name: a.name as string, pass: a.passphrase as string, entries: [] });
      return id;
    },
    keyring_entries: (a) => {
      const r = open(a);
      return isRing(r) ? r.entries : r;
    },
    keyring_lock: (a) => {
      const r = open(a);
      if (!isRing(r)) return r;
      return (a.paths as string[]).map((path) => {
        r.entries.push({ path, name: path.split("/").pop()!, size: 1, lockedAt: 1, present: true });
        return { path, status: "locked", newPath: `${path}.enigr` };
      });
    },
    keyring_unlock: (a) => {
      const r = open(a);
      if (!isRing(r)) return r;
      const paths = a.paths as string[];
      r.entries = r.entries.filter((e) => !paths.includes(e.path));
      return paths.map((path) => ({ path, status: "unlocked" }));
    },
    keyring_unlock_all: (a) => {
      const r = open(a);
      if (!isRing(r)) return r;
      const out = r.entries.filter((e) => e.present).map((e) => ({ path: e.path, status: "unlocked" }));
      r.entries = r.entries.filter((e) => !e.present);
      return out;
    },
    keyring_change_passphrase: (a) => {
      const r = open(a, a.old);
      if (!isRing(r)) return r;
      r.pass = a.new as string;
      return null;
    },
    keyring_rotate: (a) => {
      const r = open(a, a.old);
      if (!isRing(r)) return r;
      r.pass = a.new as string;
      return r.entries.map((e) => ({ path: e.path, status: "rotated" }));
    },
    keyring_rename: (a) => {
      const r = open(a);
      if (!isRing(r)) return r;
      r.name = a.name as string;
      return null;
    },
    keyring_delete: (a) => {
      const r = open(a);
      if (!isRing(r)) return r;
      if (r.entries.length) {
        return rustErr(`this ring still holds ${r.entries.length} locked file(s) — unlock them first`);
      }
      store = store.filter((x) => x !== r);
      return null;
    },
    "plugin:dialog|open": () => picked,
  };
}

function entry(path: string, present = true): KeyringEntry {
  return { path, name: path.split("/").pop()!, size: 10, lockedAt: 1_700_000_000_000, present };
}

beforeEach(() => {
  invokeMock.mockClear();
  store = [];
  nextId = 1;
  picked = null;
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
  const w = mount(KeyringPanel, { global: { plugins: [i18n], stubs: { teleport: true } } });
  await settle();
  return w;
}

const byId = (w: VueWrapper, id: string) => w.find(`[data-testid='${id}']`);
const disabled = (w: VueWrapper, id: string) => byId(w, id).attributes("disabled") !== undefined;
/** The main passphrase field (the create modal has a second one, bound to the same value). */
const passField = (w: VueWrapper) => w.findAll("[data-testid='keys-pass']")[0];

async function click(w: VueWrapper, id: string) {
  await byId(w, id).trigger("click");
  await settle();
}

/** One ring, "Personal", passphrase "pw", already listed. */
async function mountListed(entries: KeyringEntry[] = [entry("/home/a/a.txt")]) {
  store = [{ id: "p", name: "Personal", pass: "pw", entries }];
  const w = await mountPanel();
  await passField(w).setValue("pw");
  await click(w, "keys-list");
  return w;
}

const outcomes = (w: VueWrapper) => byId(w, "keys-outcomes").findAll("li").map((li) => li.text().replace(/\s+/g, " "));

// ── first run ───────────────────────────────────────────────────────────────
describe("KeyringPanel — first run", () => {
  it("offers to create a ring and nothing else", async () => {
    const w = await mountPanel();
    expect(w.text()).toContain("Choose the passphrase that will lock and unlock every file on this ring.");
    expect(byId(w, "keys-create-open").exists()).toBe(true);
    expect(byId(w, "keys-rings").exists()).toBe(false);
    expect(byId(w, "keys-lock").exists()).toBe(false);
    expect(w.text()).not.toContain("needs the desktop or mobile app");
  });

  it("a ring list that fails to load still leaves the first-run screen, with no error", async () => {
    // Gate errors surface on the action that hits them, never on mount.
    handlers.keyring_list = () => rustErr("keyring disabled in this build");
    const w = await mountPanel();
    expect(byId(w, "keys-create-open").exists()).toBe(true);
    expect(byId(w, "keys-error").exists()).toBe(false);
  });

  it("wants a name before anything reaches Rust", async () => {
    const w = await mountPanel();
    await click(w, "keys-create-open");
    await w.findAll("[data-testid='keys-pass']").at(-1)!.setValue("pw");
    await byId(w, "keys-pass-repeat").setValue("pw");
    await byId(w, "keys-pass-repeat").trigger("keyup", { key: "Enter" });
    await settle();
    expect(w.text()).toContain("Give the ring a name.");
    expect(callsTo("keyring_create")).toEqual([]);
  });

  it("refuses passphrases that do not match", async () => {
    const w = await mountPanel();
    await click(w, "keys-create-open");
    await byId(w, "keys-create-name").setValue("Personal");
    await w.findAll("[data-testid='keys-pass']").at(-1)!.setValue("one");
    await byId(w, "keys-pass-repeat").setValue("two");
    await byId(w, "keys-pass-repeat").trigger("keyup", { key: "Enter" });
    await settle();
    expect(w.text()).toContain("The passphrases do not match.");
    expect(callsTo("keyring_create")).toEqual([]);
  });

  it("creates the first ring, selects it and opens its empty listing", async () => {
    const w = await mountPanel();
    await click(w, "keys-create-open");
    await byId(w, "keys-create-name").setValue("  Personal ");
    await w.findAll("[data-testid='keys-pass']").at(-1)!.setValue("pw");
    await byId(w, "keys-pass-repeat").setValue("pw");
    await byId(w, "keys-pass-repeat").trigger("keyup", { key: "Enter" });
    await settle();

    expect(callsTo("keyring_create")).toEqual([{ name: "Personal", passphrase: "pw" }]);
    expect(byId(w, "keys-create-name").exists()).toBe(false); // modal closed
    expect(byId(w, "keys-name").text()).toBe("· Personal");
    expect(callsTo("keyring_entries")).toEqual([{ ringId: "r1", passphrase: "pw" }]);
    expect(w.text()).toContain("No files on the ring yet.");
  });

  it("a create Rust refuses keeps the modal open with the reason", async () => {
    handlers.keyring_create = () => rustErr("a key ring already exists");
    const w = await mountPanel();
    await click(w, "keys-create-open");
    await byId(w, "keys-create-name").setValue("Personal");
    await w.findAll("[data-testid='keys-pass']").at(-1)!.setValue("pw");
    await byId(w, "keys-pass-repeat").setValue("pw");
    await byId(w, "keys-pass-repeat").trigger("keyup", { key: "Enter" });
    await settle();
    expect(byId(w, "keys-create-name").exists()).toBe(true);
    expect(w.find("p.text-warn-dark").text()).toBe("a key ring already exists");
  });
});

// ── several rings ───────────────────────────────────────────────────────────
describe("KeyringPanel — rings", () => {
  beforeEach(() => {
    store = [
      { id: "p", name: "Personal", pass: "pw", entries: [entry("/home/a/a.txt"), entry("/home/a/b.txt")] },
      { id: "w", name: "Work", pass: "work", entries: [] },
    ];
  });

  it("lists every ring with its file count and starts on the first", async () => {
    const w = await mountPanel();
    expect(byId(w, "keys-ring-p").text().replace(/\s+/g, " ")).toBe("Personal 2");
    expect(byId(w, "keys-ring-w").text().replace(/\s+/g, " ")).toBe("Work 0");
    expect(byId(w, "keys-name").text()).toBe("· Personal");
  });

  it("switching rings forgets the passphrase, the listing and the outcomes", async () => {
    const w = await mountPanel();
    await passField(w).setValue("pw");
    await click(w, "keys-unlock-all");
    expect(byId(w, "keys-outcomes").exists()).toBe(true);
    await click(w, "keys-list");
    expect(w.text()).toContain("No files on the ring yet.");

    await click(w, "keys-ring-w");
    expect((passField(w).element as HTMLInputElement).value).toBe("");
    expect(byId(w, "keys-outcomes").exists()).toBe(false);
    expect(w.text()).not.toContain("No files on the ring yet.");
    expect(byId(w, "keys-name").text()).toBe("· Work");
  });

  it("New ring creates a second ring beside the first and selects it", async () => {
    const w = await mountPanel();
    await click(w, "keys-new-ring");
    await byId(w, "keys-create-name").setValue("Travel");
    await w.findAll("[data-testid='keys-pass']").at(-1)!.setValue("trip");
    await byId(w, "keys-pass-repeat").setValue("trip");
    await click(w, "keys-create");

    expect(callsTo("keyring_create")).toEqual([{ name: "Travel", passphrase: "trip" }]);
    expect(byId(w, "keys-ring-r1").exists()).toBe(true);
    expect(byId(w, "keys-ring-p").exists()).toBe(true);
    expect(byId(w, "keys-name").text()).toBe("· Travel");
  });

  it("deleting an empty ring falls back to the one that is left", async () => {
    const w = await mountPanel();
    await click(w, "keys-ring-w");
    await passField(w).setValue("work");
    await click(w, "keys-delete-ring");

    expect(callsTo("keyring_delete")).toEqual([{ ringId: "w", passphrase: "work" }]);
    expect(byId(w, "keys-ring-w").exists()).toBe(false);
    expect(byId(w, "keys-name").text()).toBe("· Personal");
    expect((passField(w).element as HTMLInputElement).value).toBe("");
  });

  it("deleting a ring that still holds files shows Rust's refusal as it is", async () => {
    const w = await mountPanel();
    await passField(w).setValue("pw");
    await click(w, "keys-delete-ring");
    expect(byId(w, "keys-error").text()).toBe("this ring still holds 2 locked file(s) — unlock them first");
    expect(byId(w, "keys-ring-p").exists()).toBe(true);
  });
});

// ── acting on one ring ──────────────────────────────────────────────────────
describe("KeyringPanel — acting on a ring", () => {
  it("every action waits for a passphrase", async () => {
    store = [{ id: "p", name: "Personal", pass: "pw", entries: [] }];
    const w = await mountPanel();
    for (const id of ["keys-list", "keys-lock", "keys-unlock", "keys-unlock-all"]) {
      expect(disabled(w, id), id).toBe(true);
    }
    await passField(w).setValue("pw");
    for (const id of ["keys-list", "keys-lock", "keys-unlock-all"]) {
      expect(disabled(w, id), id).toBe(false);
    }
    // Nothing ticked yet.
    expect(disabled(w, "keys-unlock")).toBe(true);
  });

  it("lists the ring's files and flags the ones gone from disk", async () => {
    const w = await mountListed([entry("/home/a/a.txt"), entry("/home/a/b.txt", false)]);
    expect(callsTo("keyring_entries")).toEqual([{ ringId: "p", passphrase: "pw" }]);
    const items = byId(w, "keys-entries").findAll("li");
    expect(items.map((li) => [...li.findAll("p, span").map((el) => el.text())])).toEqual([
      ["a.txt", "/home/a/a.txt", "locked"],
      ["b.txt", "/home/a/b.txt", "file not found on disk"],
    ]);
    // A missing file cannot be unlocked, so it cannot be ticked.
    expect(items[1].find("input[type='checkbox']").attributes("disabled")).toBeDefined();
    expect(items[0].find("input[type='checkbox']").attributes("disabled")).toBeUndefined();
  });

  it("Enter in the passphrase field lists the ring too", async () => {
    store = [{ id: "p", name: "Personal", pass: "pw", entries: [entry("/home/a/a.txt")] }];
    const w = await mountPanel();
    await passField(w).setValue("pw");
    await passField(w).trigger("keyup", { key: "Enter" });
    await settle();
    expect(byId(w, "keys-entries").text()).toContain("a.txt");
  });

  it("says 'Wrong passphrase.' whatever Rust called the failure", async () => {
    store = [{ id: "p", name: "Personal", pass: "pw", entries: [] }];
    const w = await mountPanel();
    await passField(w).setValue("nope");
    await click(w, "keys-list");
    expect(byId(w, "keys-error").text()).toBe("Wrong passphrase.");
    expect(byId(w, "keys-entries").exists()).toBe(false);
  });

  it("other failures are shown as Rust worded them", async () => {
    store = [{ id: "p", name: "Personal", pass: "pw", entries: [] }];
    handlers.keyring_entries = () => rustErr("key ring file is truncated");
    const w = await mountPanel();
    await passField(w).setValue("pw");
    await click(w, "keys-list");
    expect(byId(w, "keys-error").text()).toBe("key ring file is truncated");
  });

  it("locks the picked files and reports each one's outcome", async () => {
    const w = await mountListed([]);
    picked = ["/home/a/new.txt", "/home/a/dup.txt", "/home/a/ro.txt"];
    handlers.keyring_lock = (): KeyringFileOutcome[] => [
      { path: "/home/a/new.txt", status: "locked", newPath: "/home/a/new.txt.enigr" },
      { path: "/home/a/dup.txt", status: "already-locked" },
      { path: "/home/a/ro.txt", status: "failed", error: "permission denied" },
    ];
    await click(w, "keys-lock");

    expect(callsTo("plugin:dialog|open")).toEqual([{ options: { multiple: true, directory: false } }]);
    expect(callsTo("keyring_lock")).toEqual([{ ringId: "p", passphrase: "pw", paths: picked }]);
    expect(outcomes(w)).toEqual(["new.txt · locked", "dup.txt · already locked", "ro.txt · failed"]);
    expect(byId(w, "keys-outcomes").find(".text-red-500").text()).toBe("failed");
    // The listing is re-read so it shows what the ring holds now.
    expect(callsTo("keyring_entries")).toHaveLength(2);
  });

  it("a single picked file still goes over as a list; a cancelled picker locks nothing", async () => {
    const w = await mountListed([]);
    await click(w, "keys-lock");
    expect(callsTo("keyring_lock")).toEqual([]);

    picked = "/home/a/one.txt";
    await click(w, "keys-lock");
    expect(callsTo("keyring_lock")).toEqual([{ ringId: "p", passphrase: "pw", paths: ["/home/a/one.txt"] }]);
    expect(byId(w, "keys-entries").text()).toContain("one.txt");
  });

  it("reads an outcome it has no words for as failed", async () => {
    const w = await mountListed([]);
    picked = ["/home/a/x.txt"];
    handlers.keyring_lock = () => [{ path: "/home/a/x.txt", status: "quarantined" }];
    await click(w, "keys-lock");
    expect(outcomes(w)).toEqual(["x.txt · failed"]);
  });

  it("unlocks exactly the ticked files, then clears the selection", async () => {
    const w = await mountListed([entry("/home/a/a.txt"), entry("/home/a/b.txt"), entry("/home/a/c.txt")]);
    const boxes = () => byId(w, "keys-entries").findAll("input[type='checkbox']");
    await boxes()[0].trigger("change");
    await boxes()[1].trigger("change");
    await boxes()[1].trigger("change"); // second tick un-ticks
    expect(disabled(w, "keys-unlock")).toBe(false);
    await click(w, "keys-unlock");

    expect(callsTo("keyring_unlock")).toEqual([{ ringId: "p", passphrase: "pw", paths: ["/home/a/a.txt"] }]);
    expect(outcomes(w)).toEqual(["a.txt · unlocked"]);
    expect(byId(w, "keys-entries").text()).not.toContain("/home/a/a.txt");
    expect(disabled(w, "keys-unlock")).toBe(true);
  });

  it("Unlock all hands the whole ring to Rust", async () => {
    const w = await mountListed([entry("/home/a/a.txt"), entry("/home/a/gone.txt", false)]);
    await click(w, "keys-unlock-all");
    expect(callsTo("keyring_unlock_all")).toEqual([{ ringId: "p", passphrase: "pw" }]);
    expect(outcomes(w)).toEqual(["a.txt · unlocked"]);
  });

  it("holds every action while one is in flight", async () => {
    const w = await mountListed([]);
    let release!: () => void;
    handlers.keyring_unlock_all = () => new Promise((res) => (release = () => res([])));
    await byId(w, "keys-unlock-all").trigger("click");
    await settle();
    for (const id of ["keys-list", "keys-lock", "keys-unlock-all"]) expect(disabled(w, id), id).toBe(true);

    release();
    await settle();
    expect(disabled(w, "keys-list")).toBe(false);
  });

  it("changing the passphrase re-wraps the ring and keeps you in with the new one", async () => {
    const w = await mountListed();
    await click(w, "keys-change-toggle");
    expect(disabled(w, "keys-change")).toBe(true);
    await byId(w, "keys-change-new").setValue("pw2");
    await click(w, "keys-change");

    expect(callsTo("keyring_change_passphrase")).toEqual([{ ringId: "p", old: "pw", new: "pw2" }]);
    expect(w.text()).toContain("Passphrase changed.");
    expect((passField(w).element as HTMLInputElement).value).toBe("pw2");
    expect(byId(w, "keys-change-new").exists()).toBe(false);
    // No file is touched by a plain change.
    expect(byId(w, "keys-outcomes").exists()).toBe(false);
  });

  it("a change with the wrong current passphrase leaves everything as it was", async () => {
    const w = await mountListed();
    await passField(w).setValue("not-it");
    await click(w, "keys-change-toggle");
    await byId(w, "keys-change-new").setValue("pw2");
    await click(w, "keys-change");
    expect(byId(w, "keys-error").text()).toBe("Wrong passphrase.");
    expect(byId(w, "keys-change-new").exists()).toBe(true);
    expect(store[0].pass).toBe("pw");
  });

  it("rotating re-seals every file, reports each, and re-lists under the new passphrase", async () => {
    const w = await mountListed([entry("/home/a/a.txt"), entry("/home/a/b.txt")]);
    await click(w, "keys-change-toggle");
    await byId(w, "keys-change-new").setValue("fresh");
    await click(w, "keys-rotate");

    expect(callsTo("keyring_rotate")).toEqual([{ ringId: "p", old: "pw", new: "fresh" }]);
    expect(w.text()).toContain("Ring rotated — new passphrase, fresh keys, files re-sealed.");
    expect(outcomes(w)).toEqual(["a.txt · re-sealed with a fresh key", "b.txt · re-sealed with a fresh key"]);
    expect(callsTo("keyring_entries").at(-1)).toEqual({ ringId: "p", passphrase: "fresh" });
  });

  it("renaming starts from the current name and sends the trimmed new one", async () => {
    const w = await mountListed();
    await click(w, "keys-rename-toggle");
    expect((byId(w, "keys-rename-input").element as HTMLInputElement).value).toBe("Personal");
    await byId(w, "keys-rename-input").setValue("  Private ");
    await click(w, "keys-rename");

    expect(callsTo("keyring_rename")).toEqual([{ ringId: "p", passphrase: "pw", name: "Private" }]);
    expect(byId(w, "keys-name").text()).toBe("· Private");
    expect(byId(w, "keys-rename-input").exists()).toBe(false);
  });

  it("a rename Rust refuses keeps the form open", async () => {
    const w = await mountListed();
    await passField(w).setValue("not-it");
    await click(w, "keys-rename-toggle");
    await byId(w, "keys-rename-input").setValue("Private");
    await click(w, "keys-rename");
    expect(byId(w, "keys-error").text()).toBe("Wrong passphrase.");
    expect(byId(w, "keys-rename-input").exists()).toBe(true);
    expect(byId(w, "keys-name").text()).toBe("· Personal");
  });

  it("deleting the last ring returns to first run", async () => {
    const w = await mountListed([]);
    await click(w, "keys-delete-ring");
    expect(store).toEqual([]);
    expect(byId(w, "keys-create-open").exists()).toBe(true);
    expect(byId(w, "keys-name").exists()).toBe(false);
  });
});

describe("KeyringPanel — failures leave the ring as it was", () => {
  it("a lock with the wrong passphrase reports it and records no outcomes", async () => {
    const w = await mountListed([]);
    await passField(w).setValue("not-it");
    picked = ["/home/a/x.txt"];
    await click(w, "keys-lock");
    expect(byId(w, "keys-error").text()).toBe("Wrong passphrase.");
    expect(byId(w, "keys-outcomes").exists()).toBe(false);
    expect(store[0].entries).toEqual([]);
  });

  it("a failed unlock keeps the selection, so the user can retry with the right passphrase", async () => {
    const w = await mountListed([entry("/home/a/a.txt")]);
    await byId(w, "keys-entries").find("input[type='checkbox']").trigger("change");
    await passField(w).setValue("not-it");
    await click(w, "keys-unlock");
    expect(byId(w, "keys-error").text()).toBe("Wrong passphrase.");

    await passField(w).setValue("pw");
    await click(w, "keys-unlock");
    expect(callsTo("keyring_unlock").at(-1)).toEqual({ ringId: "p", passphrase: "pw", paths: ["/home/a/a.txt"] });
    expect(byId(w, "keys-error").exists()).toBe(false);
  });

  it("a failed Unlock all reports it", async () => {
    const w = await mountListed([entry("/home/a/a.txt")]);
    await passField(w).setValue("not-it");
    await click(w, "keys-unlock-all");
    expect(byId(w, "keys-error").text()).toBe("Wrong passphrase.");
    expect(store[0].entries).toHaveLength(1);
  });

  it("a failed rotation keeps the old passphrase in the field and the form open", async () => {
    const w = await mountListed([entry("/home/a/a.txt")]);
    handlers.keyring_rotate = () => rustErr("No space left on device (os error 28)");
    await click(w, "keys-change-toggle");
    await byId(w, "keys-change-new").setValue("fresh");
    await click(w, "keys-rotate");

    expect(byId(w, "keys-error").text()).toBe("No space left on device (os error 28)");
    expect((passField(w).element as HTMLInputElement).value).toBe("pw");
    expect(byId(w, "keys-change-new").exists()).toBe(true);
    expect(w.text()).not.toContain("Ring rotated");
  });

  it("the create dialog's Cancel closes it without creating anything", async () => {
    const w = await mountPanel();
    await click(w, "keys-create-open");
    await byId(w, "keys-create-name").setValue("Personal");
    await w.findAll("button").find((b) => b.text() === "Cancel")!.trigger("click");
    expect(byId(w, "keys-create-name").exists()).toBe(false);
    expect(callsTo("keyring_create")).toEqual([]);
  });

  it("the create dialog's backdrop closes it too", async () => {
    const w = await mountPanel();
    await click(w, "keys-create-open");
    await w.find("[data-testid='oya-modal-overlay']").trigger("click");
    expect(byId(w, "keys-create-name").exists()).toBe(false);
  });
});
