// The app shell's front door: the encryption-at-rest gate, and what happens
// once it opens.
//
// Nothing behind the gate may load before the vault is unlocked — the tab
// choice, the HP ledger and the profile all live in the encrypted store — so
// these tests pin which gate a given vault state shows, what each form sends to
// Rust, how a failure is reported, and that the shell (and only the shell)
// appears once unlocking succeeds. tabVisibility.test.ts and scrolling.test.ts
// cover the unlocked chrome in browser mode; this file runs in Tauri mode,
// where the gate is real.
//
// The backend sits behind the real Tauri IPC hook (see contactsView.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { createRouter, createMemoryHistory } from "vue-router";

const listeners = new Map<string, () => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: () => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  },
}));

const p2p = { currentUserName: ref(""), myAvatar: ref("") };
const fileShare = { state: ref("idle") };
const chatStore = {
  syncRuntimeIdentity: vi.fn(async () => {}),
  init: vi.fn(async () => {}),
  p2p,
  fileShare,
  invites: { incoming: ref(null) },
  meetings: { attentionCount: ref(0) },
};
vi.mock("../../src/stores/chat", () => ({ useChatStore: () => chatStore }));

import "@tauri-apps/api/core";
import App from "../../src/App.vue";
import { i18n } from "../../src/i18n";
import { stopHp } from "../../src/components/hp/useHp";

(i18n.global.locale as any).value = "en";

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args);
});
const callsTo = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

const kv = new Map<string, string>();
const kvKey = (a: Record<string, unknown>) => `${a.ns}/${a.scope}/${a.k}`;

function backend(vault: { exists: boolean; unlocked: boolean }): Record<string, Handler> {
  return {
    vault_status: () => vault,
    vault_pin_status: () => ({ enrolled: false, digits: 6, attemptsLeft: 5 }),
    vault_touch: () => null,
    kv_get: (a) => kv.get(kvKey(a)) ?? null,
    kv_put: (a) => {
      kv.set(kvKey(a), String(a.v));
    },
    app_get_use_tor: () => false,
    hp_set_tor_posture: () => false,
    hp_ledger: () => [],
    app_get_profile_state: () => ({
      offline_profile: {
        display_name: "Ala",
        email: "",
        phone: "",
        bio: "",
        date_of_birth: "",
        avatar: "data:image/jpeg;base64,QUxB",
      },
      offline_profiles: [],
      selected_offline_profile_id: "",
    }),
  };
}

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/:any(.*)*", component: { render: () => null } }],
});

beforeEach(async () => {
  invokeMock.mockClear();
  chatStore.syncRuntimeIdentity.mockClear();
  chatStore.init.mockClear();
  kv.clear();
  listeners.clear();
  p2p.currentUserName.value = "";
  p2p.myAvatar.value = "";
  handlers = backend({ exists: true, unlocked: true });
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
  setActivePinia(createPinia());
  await router.replace("/chat");
});

afterEach(() => {
  // The HP meter tick is module-level; stop it so it does not outlive the test.
  stopHp();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 5; i++) await flushPromises();
}

async function mountApp() {
  const w = mount(App, {
    global: { plugins: [i18n, createPinia(), router], stubs: { RouterView: true, teleport: true } },
  });
  await settle();
  return w;
}

const passField = (w: VueWrapper) => w.find('input[placeholder="Passphrase"]');
const confirmField = (w: VueWrapper) => w.find('input[placeholder="Confirm passphrase"]');
const shellIsUp = (w: VueWrapper) => w.find("header").exists();

// ── which gate ──────────────────────────────────────────────────────────────

describe("the gate", () => {
  it("asks a first-run device to create a passphrase, with a confirmation", async () => {
    handlers = backend({ exists: false, unlocked: false });
    const w = await mountApp();
    expect(w.text()).toContain("Set a passphrase to encrypt this device's data.");
    expect(confirmField(w).exists()).toBe(true);
    expect(shellIsUp(w)).toBe(false);
    // Nothing behind the gate has been read yet.
    expect(callsTo("app_get_profile_state")).toHaveLength(0);
    expect(chatStore.init).not.toHaveBeenCalled();
  });

  it("asks a locked device for its passphrase only", async () => {
    handlers = backend({ exists: true, unlocked: false });
    const w = await mountApp();
    expect(w.text()).toContain("Enter your passphrase to unlock this device's data.");
    expect(passField(w).exists()).toBe(true);
    expect(confirmField(w).exists()).toBe(false);
    expect(shellIsUp(w)).toBe(false);
  });

  it("goes straight to the app when the vault is already open", async () => {
    const w = await mountApp();
    expect(shellIsUp(w)).toBe(true);
    expect(passField(w).exists()).toBe(false);
    expect(chatStore.syncRuntimeIdentity).toHaveBeenCalledTimes(1);
    expect(chatStore.init).toHaveBeenCalledTimes(1);
  });

  it("falls back to the passphrase form, with the reason, when the status probe fails", async () => {
    handlers.vault_status = () => {
      throw "vault file is unreadable";
    };
    const w = await mountApp();
    expect(passField(w).exists()).toBe(true);
    expect(w.text()).toContain("vault file is unreadable");
    expect(shellIsUp(w)).toBe(false);
  });
});

// ── first run ───────────────────────────────────────────────────────────────

describe("creating the vault", () => {
  async function setupWith(pass: string, confirm: string) {
    handlers = backend({ exists: false, unlocked: false });
    handlers.vault_setup = () => null;
    const w = await mountApp();
    await passField(w).setValue(pass);
    await confirmField(w).setValue(confirm);
    await w.find("form").trigger("submit");
    await settle();
    return w;
  }

  it("refuses a passphrase under the minimum length without asking Rust", async () => {
    const w = await setupWith("short", "short");
    expect(w.text()).toContain("Passphrase must be at least 8 characters.");
    expect(callsTo("vault_setup")).toHaveLength(0);
  });

  it("refuses a mismatched confirmation", async () => {
    const w = await setupWith("correct horse", "correct h0rse");
    expect(w.text()).toContain("Passphrases don't match.");
    expect(callsTo("vault_setup")).toHaveLength(0);
  });

  it("creates the vault and opens the app on it", async () => {
    const w = await setupWith("correct horse", "correct horse");
    expect(callsTo("vault_setup")).toEqual([{ passphrase: "correct horse" }]);
    expect(shellIsUp(w)).toBe(true);
    expect(callsTo("app_get_profile_state")).toHaveLength(1);
  });

  it("shows Rust's reason when the vault cannot be created", async () => {
    handlers = backend({ exists: false, unlocked: false });
    handlers.vault_setup = () => {
      throw "no space left on device";
    };
    const w = await mountApp();
    await passField(w).setValue("correct horse");
    await confirmField(w).setValue("correct horse");
    await w.find("form").trigger("submit");
    await settle();

    expect(w.text()).toContain("no space left on device");
    expect(shellIsUp(w)).toBe(false);
  });
});

// ── unlocking ───────────────────────────────────────────────────────────────

describe("unlocking with the passphrase", () => {
  it("keeps the gate up on a wrong passphrase", async () => {
    handlers = backend({ exists: true, unlocked: false });
    handlers.vault_unlock = () => {
      throw "decryption failed";
    };
    const w = await mountApp();
    await passField(w).setValue("not it");
    await w.find("form").trigger("submit");
    await settle();

    expect(w.text()).toContain("Wrong passphrase.");
    // Rust's raw message is not what the user needs to read here.
    expect(w.text()).not.toContain("decryption failed");
    expect(shellIsUp(w)).toBe(false);
  });

  it("unlocks with the typed passphrase and loads the profile into the chat identity", async () => {
    handlers = backend({ exists: true, unlocked: false });
    handlers.vault_unlock = () => null;
    const w = await mountApp();
    await passField(w).setValue("correct horse");
    await w.find("form").trigger("submit");
    await settle();

    expect(callsTo("vault_unlock")).toEqual([{ passphrase: "correct horse" }]);
    expect(shellIsUp(w)).toBe(true);
    // The name peers see and the picture shared over presence both come from
    // the local profile that was just decrypted.
    expect(p2p.currentUserName.value).toBe("Ala");
    expect(p2p.myAvatar.value).toBe("data:image/jpeg;base64,QUxB");
  });
});

describe("unlocking with a PIN", () => {
  // A PIN only exists for the process that enrolled it, so its presence is the
  // "locked within this session" signal.
  function pinBackend(status: { enrolled: boolean; digits: number }) {
    handlers = backend({ exists: true, unlocked: false });
    handlers.vault_pin_status = () => ({ ...status, attemptsLeft: 3 });
  }
  async function typePin(w: VueWrapper, pin: string) {
    for (const d of pin) await w.find(`[data-testid='pin-key-${d}']`).trigger("click");
    await settle();
  }

  it("offers the keypad, sized to the enrolled PIN", async () => {
    pinBackend({ enrolled: true, digits: 4 });
    const w = await mountApp();
    expect(w.text()).toContain("Enter your PIN to unlock.");
    expect(w.findAll("[data-testid='pin-dots'] span")).toHaveLength(4);
    expect(passField(w).exists()).toBe(false);
  });

  it("offers the passphrase instead when no PIN was enrolled this session", async () => {
    pinBackend({ enrolled: false, digits: 6 });
    const w = await mountApp();
    expect(w.find("[data-testid='pin-pad']").exists()).toBe(false);
    expect(passField(w).exists()).toBe(true);
  });

  it("unlocks with the typed PIN", async () => {
    pinBackend({ enrolled: true, digits: 4 });
    handlers.vault_pin_unlock = () => null;
    const w = await mountApp();
    await typePin(w, "2468");

    expect(callsTo("vault_pin_unlock")).toEqual([{ pin: "2468" }]);
    expect(shellIsUp(w)).toBe(true);
  });

  it("stays on the keypad after a wrong PIN while attempts remain", async () => {
    pinBackend({ enrolled: true, digits: 4 });
    handlers.vault_pin_unlock = () => {
      throw "wrong pin";
    };
    const w = await mountApp();
    await typePin(w, "1111");

    expect(w.get("[data-testid='pin-error']").text()).toBe("Wrong PIN.");
    expect(w.find("[data-testid='pin-pad']").exists()).toBe(true);
  });

  it("falls back to the passphrase once Rust has dropped the PIN", async () => {
    // Exhausting the attempts deletes the PIN; a keypad left on screen could
    // then never succeed.
    pinBackend({ enrolled: true, digits: 4 });
    handlers.vault_pin_unlock = () => {
      handlers.vault_pin_status = () => ({ enrolled: false, digits: 4, attemptsLeft: 0 });
      throw "wrong pin";
    };
    const w = await mountApp();
    await typePin(w, "1111");

    expect(w.find("[data-testid='pin-pad']").exists()).toBe(false);
    expect(passField(w).exists()).toBe(true);
    expect(w.text()).toContain("Too many wrong PINs — enter your passphrase.");
  });

  it("lets the user switch to the passphrase at any time", async () => {
    pinBackend({ enrolled: true, digits: 4 });
    const w = await mountApp();
    await w.get("[data-testid='gate-use-passphrase']").trigger("click");
    expect(passField(w).exists()).toBe(true);
    expect(w.find("[data-testid='pin-pad']").exists()).toBe(false);
  });
});

// ── the unlocked shell ──────────────────────────────────────────────────────

describe("the unlocked shell", () => {
  it("toggles the dark theme on the document root", async () => {
    const w = await mountApp();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    const toggle = w.findAll("button").find((b) => b.text().trim() === "Light")!;
    await toggle.trigger("click");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(toggle.text().trim()).toBe("Dark");
    await toggle.trigger("click");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("closes the mobile menu when the route changes", async () => {
    const w = await mountApp();
    await w.find('button[aria-label="Open menu"]').trigger("click");
    expect(w.find('button[aria-label="Close menu"]').exists()).toBe(true);

    await router.push("/files");
    await settle();
    expect(w.find('button[aria-label="Open menu"]').exists()).toBe(true);
  });

  it("listens for the Rust watchdog's lock from the moment it mounts", async () => {
    await mountApp();
    expect(listeners.has("vault://locked")).toBe(true);
  });
});

describe("auto-lock warning", () => {
  it("warns before locking an idle session, and Stay dismisses it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    kv.set("p2p:settings/default/idle_lock_mins", "1");
    const w = await mountApp();
    expect(w.text()).not.toContain("Auto-lock imminent");

    // One minute's timeout warns in its last third.
    vi.advanceTimersByTime(40_000);
    await settle();
    expect(w.text()).toContain("Auto-lock imminent");
    expect(callsTo("vault_lock")).toHaveLength(0);

    await w.findAll("button").find((b) => b.text().trim() === "Stay unlocked")!.trigger("click");
    expect(w.text()).not.toContain("Auto-lock imminent");
  });

});
