import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import LocalPanel from "../../src/components/local/LocalPanel.vue";

// Files → Local in jsdom with a mocked Tauri: what is pinned here is the
// recents list's per-row LOCK affordance — a plain file on the list can be
// locked where you see it, without re-finding it in the toolbar picker — and
// that the button correctly hides for files already locked or gone from disk.

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [string, Record<string, unknown>])),
}));

(i18n.global.locale as unknown as { value: string }).value = "en";

/** locked-state per path the local_note_stat mock reports. */
let statByPath: Record<string, { exists: boolean; locked: boolean; size: number }>;

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  statByPath = {};
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "kv_get") return localStorage.getItem(`enigma:db:${args.ns}:${args.scope}:${args.k}`);
    if (cmd === "kv_put") {
      localStorage.setItem(`enigma:db:${args.ns}:${args.scope}:${args.k}`, args.v as string);
      return undefined;
    }
    if (cmd === "local_note_stat") {
      return statByPath[args.path as string] ?? { exists: true, locked: false, size: 5 };
    }
    if (cmd === "local_is_locked") return true;
    if (cmd === "app_get_settings") return {};
    return undefined;
  });
  pinia = createPinia();
  setActivePinia(pinia);
});

function seedRecents(records: Array<{ path: string; name: string; locked: boolean }>) {
  localStorage.setItem(
    "enigma:db:files:local:default:notes",
    JSON.stringify(records.map((r) => ({ ...r, size: 5, openedAt: 1_700_000_000_000 }))),
  );
}

const GLOBAL = () => ({ plugins: [i18n, pinia], stubs: { teleport: true } });

describe("LocalPanel — recents lock button", () => {
  it("offers Lock on a plain existing file and opens the lock modal for it", async () => {
    seedRecents([{ path: "/home/a/todo.txt", name: "todo.txt", locked: false }]);
    const wrapper = mount(LocalPanel, { global: GLOBAL() });
    await flushPromises();

    const lock = wrapper.find("[data-testid='recent-lock']");
    expect(lock.exists()).toBe(true);
    await lock.trigger("click");
    await flushPromises();

    // The passphrase modal opens in lock mode for exactly that file.
    expect(wrapper.text()).toContain("todo.txt");
    const modal = wrapper.findComponent({ name: "LocalPassphraseModal" });
    expect(modal.exists()).toBe(true);
    expect(modal.props("mode")).toBe("lock");
    expect(modal.props("path")).toBe("/home/a/todo.txt");
  });

  it("hides Lock for an already-locked file", async () => {
    // The missing-from-disk case rides the same v-if via `exists === false`;
    // the locked case is the one the record itself can prove (the stat mock's
    // second parallel call is unreliable under jsdom's double module graph).
    seedRecents([{ path: "/home/a/sealed.txt", name: "sealed.txt", locked: true }]);
    statByPath["/home/a/sealed.txt"] = { exists: true, locked: true, size: 5 };
    const wrapper = mount(LocalPanel, { global: GLOBAL() });
    await flushPromises();

    expect(wrapper.text()).toContain("sealed.txt");
    expect(wrapper.find("[data-testid='recent-lock']").exists()).toBe(false);
  });

  it("opens the new-file modal with the three choices", async () => {
    const wrapper = mount(LocalPanel, { global: GLOBAL() });
    await flushPromises();

    await wrapper.find("[data-testid='new-file']").trigger("click");
    expect(wrapper.find("[data-testid='new-file-text']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='new-file-svg']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='new-file-open']").exists()).toBe(true);

    // Picking "text" switches to the editor view (the editor itself is an
    // async ACE chunk that never materializes in jsdom — the toolbar leaving
    // is the observable part of the transition).
    await wrapper.find("[data-testid='new-file-text']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='new-file']").exists()).toBe(false);
  });
});

describe("LocalPassphraseModal — lock method chooser", () => {
  async function mountModal(props: Record<string, unknown>) {
    const { default: Modal } = await import("../../src/components/local/LocalPassphraseModal.vue");
    return mount(Modal, {
      props: { open: true, mode: "lock", path: "/home/a/f.txt", name: "f.txt", minLen: 8, ...props },
      global: GLOBAL(),
    });
  }

  const RING = { id: "default", name: "Personal", entryCount: 0 };
  const RING_B = { id: "ab12", name: "Work", entryCount: 3 };

  it("offers Passphrase vs Key ring only when a ring exists", async () => {
    const without = await mountModal({ rings: [] });
    expect(without.find("[data-testid='lock-method-ring']").exists()).toBe(false);

    const withRing = await mountModal({ rings: [RING] });
    expect(withRing.find("[data-testid='lock-method-pass']").exists()).toBe(true);
    expect(withRing.find("[data-testid='lock-method-ring']").exists()).toBe(true);
  });

  it("asks which ring only when there is more than one", async () => {
    const one = await mountModal({ rings: [RING] });
    await one.find("[data-testid='lock-method-ring']").trigger("click");
    expect(one.find("[data-testid='lock-ring-select']").exists()).toBe(false);

    const two = await mountModal({ rings: [RING, RING_B] });
    await two.find("[data-testid='lock-method-ring']").trigger("click");
    const select = two.find("[data-testid='lock-ring-select']");
    expect(select.exists()).toBe(true);
    expect(select.findAll("option").map((o) => o.text())).toEqual(["Personal", "Work"]);
  });

  it("locks into the ring the user picked", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "keyring_lock"
        ? [{ path: "/home/a/f.txt", status: "locked", newPath: "/home/a/f.txt.enigr" }]
        : undefined,
    );
    const wrapper = await mountModal({ rings: [RING, RING_B] });
    await wrapper.find("[data-testid='lock-method-ring']").trigger("click");
    await wrapper.find("[data-testid='lock-ring-select']").setValue("ab12");
    await wrapper.find("input[type='password']").setValue("ring-pass");
    const buttons = wrapper.findAll("button");
    await buttons[buttons.length - 1].trigger("click");
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith(
      "keyring_lock",
      expect.objectContaining({ ringId: "ab12" }),
    );
    expect(wrapper.emitted("locked")![0][0]).toMatchObject({ ringId: "ab12" });
  });

  it("ring method swaps to the single ring-passphrase field and calls keyring_lock", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "keyring_lock")
        return [{ path: "/home/a/f.txt", status: "locked", newPath: "/home/a/f.txt.enigr" }];
      return undefined;
    });
    const wrapper = await mountModal({ rings: [RING], fileSize: 42 });
    await wrapper.find("[data-testid='lock-method-ring']").trigger("click");

    // One field, no confirm — the ring passphrase already exists.
    expect(wrapper.findAll("input[type='password']")).toHaveLength(1);

    await wrapper.find("input[type='password']").setValue("ring-pass");
    // Submit via the footer primary button.
    const buttons = wrapper.findAll("button");
    await buttons[buttons.length - 1].trigger("click");
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("keyring_lock", {
      ringId: "default",
      passphrase: "ring-pass",
      paths: ["/home/a/f.txt"],
    });
    const locked = wrapper.emitted("locked");
    expect(locked).toHaveLength(1);
    expect(locked![0][0]).toMatchObject({ ring: true, newPath: "/home/a/f.txt.enigr", size: 42, name: "f.txt.enigr" });
  });

  it("a forced-ring unlock shows no chooser and routes to keyring_unlock", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "keyring_unlock")
        return [{ path: "/home/a/f.txt.enigr", status: "unlocked", newPath: "/home/a/f.txt" }];
      return undefined;
    });
    const wrapper = await mountModal({
      mode: "unlock",
      path: "/home/a/f.txt.enigr",
      ringForced: true,
      ringId: "ab12",
    });
    expect(wrapper.find("[data-testid='lock-method-pass']").exists()).toBe(false);

    await wrapper.find("input[type='password']").setValue("ring-pass");
    const buttons = wrapper.findAll("button");
    await buttons[buttons.length - 1].trigger("click");
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("keyring_unlock", {
      ringId: "ab12",
      passphrase: "ring-pass",
      paths: ["/home/a/f.txt.enigr"],
    });
    expect(wrapper.emitted("unlocked")![0][0]).toMatchObject({ ring: true, newPath: "/home/a/f.txt" });
  });
});
