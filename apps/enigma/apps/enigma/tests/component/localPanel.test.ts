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

// The cloud store drags its own invoke traffic in; LocalPanel only reads
// `enabled` and `transfers` and calls init() — stub it whole.
vi.mock("../../src/stores/cloud", () => ({
  useCloudStore: () => ({
    enabled: false,
    transfers: new Map(),
    init: async () => {},
    upload: async () => {},
  }),
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

  it("hides Lock for an already-locked file and for one missing from disk", async () => {
    seedRecents([
      { path: "/home/a/sealed.txt", name: "sealed.txt", locked: true },
      { path: "/home/a/gone.txt", name: "gone.txt", locked: false },
    ]);
    statByPath["/home/a/sealed.txt"] = { exists: true, locked: true, size: 5 };
    statByPath["/home/a/gone.txt"] = { exists: false, locked: false, size: 5 };
    const wrapper = mount(LocalPanel, { global: GLOBAL() });
    await flushPromises();

    expect(wrapper.find("[data-testid='recent-lock']").exists()).toBe(false);
  });
});
