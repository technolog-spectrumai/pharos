// The one passphrase prompt behind every Local action: lock, unlock, rotate,
// and the editor's open / encrypt. It is the last check before a passphrase
// becomes a key, so what is pinned is that nothing reaches Rust until the form
// is right (present, long enough, typed twice when it is new), that a refusal
// keeps the modal open with the reason inline instead of closing as if it
// worked, and that every opening starts from an empty form.
//
// localPanel.test.ts covers the lock-method chooser; this file covers the
// rest. The Tauri API is faked at its IPC hook (see contactsView.test.ts).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";

import "@tauri-apps/api/core";
import { i18n } from "../../src/i18n";
import LocalPassphraseModal from "../../src/components/local/LocalPassphraseModal.vue";

(i18n.global.locale as unknown as { value: string }).value = "en";

const rustErr = (msg: string) => Promise.reject(msg);

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args);
});

beforeEach(() => {
  invokeMock.mockClear();
  handlers = {
    local_lock_file: () => ({ name: "f.txt", size: 42 }),
    local_unlock_file: (a) => (a.passphrase === "right one" ? { name: "f.txt", size: 42 } : rustErr("wrong passphrase")),
    local_rotate_file: (a) => (a.current === "right one" ? { name: "f.txt", size: 42 } : rustErr("wrong passphrase")),
  };
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
});

const RING = { id: "default", name: "Personal", entryCount: 0 };

function mountModal(props: Record<string, unknown> = {}) {
  return mount(LocalPassphraseModal, {
    props: { open: true, mode: "lock", path: "/home/a/f.txt", name: "f.txt", minLen: 8, ...props },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

const fields = (w: VueWrapper) => w.findAll("input[type='password']");
const placeholders = (w: VueWrapper) => fields(w).map((f) => f.attributes("placeholder"));
const primary = (w: VueWrapper) => w.findAll("button").at(-1)!;
const cancel = (w: VueWrapper) => w.findAll("button").find((b) => b.text() === "Cancel")!;
const errorText = (w: VueWrapper) => w.find("p.text-warn-dark").text();

/** Fill the fields in order and press the primary button. */
async function submit(w: VueWrapper, ...values: string[]) {
  for (const [i, v] of values.entries()) await fields(w)[i].setValue(v);
  await primary(w).trigger("click");
  await flushPromises();
}

describe("LocalPassphraseModal — a new passphrase (lock)", () => {
  it("asks for the passphrase twice and says why it matters", () => {
    const w = mountModal();
    expect(w.text()).toContain("Lock file");
    expect(w.text()).toContain("It is never stored — without it the file can't be recovered.");
    expect(placeholders(w)).toEqual(["Passphrase", "Confirm passphrase"]);
  });

  it("refuses an empty passphrase without calling Rust", async () => {
    const w = mountModal();
    await submit(w);
    expect(errorText(w)).toBe("Enter a passphrase.");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses one shorter than the policy minimum", async () => {
    const w = mountModal({ minLen: 12 });
    await submit(w, "only-eleven", "only-eleven");
    expect(errorText(w)).toBe("Passphrase must be at least 12 characters.");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a confirmation that does not match", async () => {
    const w = mountModal();
    await submit(w, "correct horse", "correct hrose");
    expect(errorText(w)).toBe("Passphrases don't match.");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("locks in place, hands the result up and closes", async () => {
    const w = mountModal();
    await submit(w, "correct horse", "correct horse");
    expect(invokeMock).toHaveBeenCalledWith("local_lock_file", { path: "/home/a/f.txt", passphrase: "correct horse" });
    expect(w.emitted("locked")).toEqual([[{ name: "f.txt", size: 42 }]]);
    expect(w.emitted("update:open")).toEqual([[false]]);
  });

  it("Enter in a field submits like the button", async () => {
    const w = mountModal();
    await fields(w)[0].setValue("correct horse");
    await fields(w)[1].setValue("correct horse");
    await fields(w)[1].trigger("keyup", { key: "Enter" });
    await flushPromises();
    expect(w.emitted("locked")).toHaveLength(1);
  });

  it("a ring lock drops the per-file hint for the ring's, and names nameless rings by id", async () => {
    const w = mountModal({ rings: [RING, { id: "ab12", name: "", entryCount: 0 }] });
    await w.find("[data-testid='lock-method-ring']").trigger("click");
    expect(w.text()).not.toContain("It is never stored");
    expect(w.text()).toContain("Locks with your key ring");
    expect(placeholders(w)).toEqual(["Ring passphrase"]);
    expect(w.find("[data-testid='lock-ring-select']").findAll("option").map((o) => o.text())).toEqual([
      "Personal",
      "ab12",
    ]);

    // Switching back restores the two-field form.
    await w.find("[data-testid='lock-method-pass']").trigger("click");
    expect(placeholders(w)).toEqual(["Passphrase", "Confirm passphrase"]);
  });
});

describe("LocalPassphraseModal — key ring refusals", () => {
  async function ringLock(outcome: Record<string, unknown> | undefined) {
    handlers.keyring_lock = () => (outcome ? [outcome] : []);
    const w = mountModal({ rings: [RING] });
    await w.find("[data-testid='lock-method-ring']").trigger("click");
    await submit(w, "ring pass");
    return w;
  }

  it("a file already on a ring is reported, not recorded", async () => {
    const w = await ringLock({ path: "/home/a/f.txt", status: "already-locked" });
    expect(errorText(w)).toBe("already locked");
    expect(w.emitted("locked")).toBeUndefined();
    expect(w.emitted("update:open")).toBeUndefined();
  });

  it("a failed file shows Rust's own reason when it gives one", async () => {
    const w = await ringLock({ path: "/home/a/f.txt", status: "failed", error: "/home/a/f.txt.enigr already exists" });
    expect(errorText(w)).toBe("/home/a/f.txt.enigr already exists");
  });

  it("no outcome at all still reads as a failure", async () => {
    const w = await ringLock(undefined);
    expect(errorText(w)).toBe("failed");
    expect(w.emitted("locked")).toBeUndefined();
  });

  it("a wrong ring passphrase on lock is shown inline", async () => {
    handlers.keyring_lock = () => rustErr("wrong passphrase or corrupt data");
    const w = mountModal({ rings: [RING] });
    await w.find("[data-testid='lock-method-ring']").trigger("click");
    await submit(w, "nope");
    expect(errorText(w)).toBe("wrong passphrase or corrupt data");
  });

  it("a ring unlock that did not unlock keeps the modal open", async () => {
    handlers.keyring_unlock = () => [{ path: "/home/a/f.txt.enigr", status: "failed" }];
    const w = mountModal({ mode: "unlock", path: "/home/a/f.txt.enigr", ringForced: true, ringId: "ab12" });
    await submit(w, "ring pass");
    expect(errorText(w)).toBe("failed");
    expect(w.emitted("unlocked")).toBeUndefined();

    handlers.keyring_unlock = () => [{ path: "/home/a/f.txt.enigr", status: "failed", error: "corrupt file (or a key from a different ring)" }];
    await primary(w).trigger("click");
    await flushPromises();
    expect(errorText(w)).toBe("corrupt file (or a key from a different ring)");
  });
});

describe("LocalPassphraseModal — unlock", () => {
  it("takes one passphrase and offers no hint", () => {
    const w = mountModal({ mode: "unlock" });
    expect(w.text()).toContain("Unlock file");
    expect(placeholders(w)).toEqual(["Passphrase"]);
    expect(w.find("p.text-xs.opacity-60").exists()).toBe(false);
  });

  it("a wrong passphrase stays open with Rust's message, and the next try can succeed", async () => {
    const w = mountModal({ mode: "unlock" });
    await submit(w, "nope");
    expect(errorText(w)).toBe("wrong passphrase");
    expect(w.emitted("update:open")).toBeUndefined();

    await submit(w, "right one");
    expect(invokeMock).toHaveBeenLastCalledWith("local_unlock_file", { path: "/home/a/f.txt", passphrase: "right one" });
    expect(w.emitted("unlocked")).toEqual([[{ name: "f.txt", size: 42 }]]);
    expect(w.emitted("update:open")).toEqual([[false]]);
    expect(w.find("p.text-warn-dark").exists()).toBe(false);
  });
});

describe("LocalPassphraseModal — rotate", () => {
  it("asks for the current passphrase and an optional new one, confirming only a real change", async () => {
    const w = mountModal({ mode: "rotate" });
    expect(w.text()).toContain("Rotate file key");
    expect(placeholders(w)).toEqual(["Current passphrase", "New passphrase (blank = keep the same)"]);

    await fields(w)[1].setValue("brand new one");
    expect(placeholders(w)).toEqual([
      "Current passphrase",
      "New passphrase (blank = keep the same)",
      "Confirm new passphrase",
    ]);
    // Whitespace is not a change.
    await fields(w)[1].setValue("   ");
    expect(placeholders(w)).toHaveLength(2);
  });

  it("a blank new passphrase rolls the key under the same one", async () => {
    const w = mountModal({ mode: "rotate" });
    await submit(w, "right one");
    expect(invokeMock).toHaveBeenCalledWith("local_rotate_file", {
      path: "/home/a/f.txt",
      current: "right one",
      new: "right one",
    });
    expect(w.emitted("rotated")).toEqual([[{ name: "f.txt", size: 42 }]]);
  });

  it("a new passphrase is held to the same rules as a lock", async () => {
    const w = mountModal({ mode: "rotate" });
    await submit(w, "right one", "short", "short");
    expect(errorText(w)).toBe("Passphrase must be at least 8 characters.");
    await submit(w, "right one", "brand new one", "brand new on");
    expect(errorText(w)).toBe("Passphrases don't match.");
    expect(invokeMock).not.toHaveBeenCalled();

    await submit(w, "right one", "brand new one", "brand new one");
    expect(invokeMock).toHaveBeenCalledWith("local_rotate_file", {
      path: "/home/a/f.txt",
      current: "right one",
      new: "brand new one",
    });
  });

  it("a wrong current passphrase is shown inline and nothing is emitted", async () => {
    const w = mountModal({ mode: "rotate" });
    await submit(w, "nope");
    expect(errorText(w)).toBe("wrong passphrase");
    expect(w.emitted("rotated")).toBeUndefined();
  });
});

describe("LocalPassphraseModal — the editor's open and encrypt", () => {
  it("open hands the passphrase to the parent's action and sends nothing itself", async () => {
    const action = vi.fn(async () => {});
    const w = mountModal({ mode: "open", path: "", action });
    expect(w.text()).toContain("Open encrypted file");
    await submit(w, "anything");
    expect(action).toHaveBeenCalledWith("anything");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(w.emitted("update:open")).toEqual([[false]]);
  });

  it("a rejected action keeps the modal open with its message — Error or bare string", async () => {
    const action = vi.fn().mockRejectedValueOnce(new Error("wrong passphrase")).mockRejectedValueOnce("disk full");
    const w = mountModal({ mode: "open", path: "", action });
    await submit(w, "nope");
    expect(errorText(w)).toBe("wrong passphrase");
    await submit(w, "nope");
    expect(errorText(w)).toBe("disk full");
    expect(w.emitted("update:open")).toBeUndefined();
  });

  it("encrypt is a new passphrase, so it is confirmed and length-checked first", async () => {
    const action = vi.fn(async () => {});
    const w = mountModal({ mode: "encrypt", path: "", action });
    expect(w.text()).toContain("Encrypt note");
    expect(w.text()).toContain("its plaintext is never written");
    expect(placeholders(w)).toEqual(["Passphrase", "Confirm passphrase"]);

    await submit(w, "short", "short");
    expect(errorText(w)).toBe("Passphrase must be at least 8 characters.");
    expect(action).not.toHaveBeenCalled();

    await submit(w, "long enough", "long enough");
    expect(action).toHaveBeenCalledWith("long enough");
  });
});

describe("LocalPassphraseModal — closing and reopening", () => {
  it("Cancel closes without submitting", async () => {
    const w = mountModal();
    await cancel(w).trigger("click");
    expect(w.emitted("update:open")).toEqual([[false]]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("cannot be dismissed while a submit is in flight, and ignores a second press", async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((res) => (finish = res)));
    const w = mountModal({ mode: "open", path: "", action });
    await fields(w)[0].setValue("pw");
    await primary(w).trigger("click");
    await primary(w).trigger("click");
    await cancel(w).trigger("click");
    expect(action).toHaveBeenCalledTimes(1);
    expect(w.emitted("update:open")).toBeUndefined();
    expect((fields(w)[0].element as HTMLInputElement).disabled).toBe(true);

    finish();
    await flushPromises();
    expect(w.emitted("update:open")).toEqual([[false]]);
  });

  it("every opening starts from an empty form, on the per-file method", async () => {
    const w = mountModal({ open: false, rings: [RING] });
    await w.setProps({ open: true });
    await w.find("[data-testid='lock-method-ring']").trigger("click");
    await submit(w, "typed");
    // keyring_lock is not in this backend: the attempt fails inline.
    expect(w.find("p.text-warn-dark").exists()).toBe(true);

    await w.setProps({ open: false });
    await w.setProps({ open: true });
    expect(w.find("p.text-warn-dark").exists()).toBe(false);
    expect(placeholders(w)).toEqual(["Passphrase", "Confirm passphrase"]);
    for (const f of fields(w)) expect((f.element as HTMLInputElement).value).toBe("");
  });

  it("a forced-ring unlock reopens on the ring method", async () => {
    const w = mountModal({ open: false, mode: "unlock", ringForced: true, ringId: "ab12" });
    await w.setProps({ open: true });
    expect(placeholders(w)).toEqual(["Ring passphrase"]);
    expect(w.find("[data-testid='lock-method-pass']").exists()).toBe(false);
  });
});
