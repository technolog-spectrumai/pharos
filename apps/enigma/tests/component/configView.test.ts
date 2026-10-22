// Settings, tab by tab, against the real rakotis settings layer in Tauri mode.
//
// Almost every control here is a privacy or safety decision, so what is pinned
// is what reaches Rust: the stored value after clamping, the Privacy HP charge
// or credit a switch triggers (and that it fires only in the costly direction),
// the confirm that stands in front of the expensive ones, and the vault
// commands with their exact arguments. tabVisibility.test.ts already covers the
// Tabs card; it mounts this view in browser mode.
//
// The backend is an in-memory kv plus whatever command a test needs, behind the
// real Tauri IPC hook (see contactsView.test.ts for why the hook, not vi.mock).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import type { AppProfileState } from "rakotis";

const { notif } = vi.hoisted(() => ({
  notif: { granted: false, requests: 0 },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => notif.granted,
  requestPermission: async () => {
    notif.requests += 1;
    return "granted";
  },
}));

vi.mock("../../src/stores/chat", () => ({ useChatStore: () => ({ clearLocalChatState: vi.fn() }) }));

import "@tauri-apps/api/core";
import { i18n, setLocale } from "../../src/i18n";
import EnigmaConfigView from "../../src/views/EnigmaConfigView.vue";
import { hpConfirm, resolveHpConfirm, setHpTranslator, stopHp } from "../../src/components/hp/useHp";

(i18n.global.locale as any).value = "en";

// ── fake backend ────────────────────────────────────────────────────────────
type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args);
});
const callsTo = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
const sent = () => invokeMock.mock.calls.map((c) => c[0]);

const kv = new Map<string, string>();
const kvKey = (a: Record<string, unknown>) => `${a.ns}/${a.scope}/${a.k}`;
const setting = (k: string) => kv.get(`p2p:settings/default/${k}`);
const seed = (k: string, v: string) => kv.set(`p2p:settings/default/${k}`, v);

let network: { offline: boolean; useTor: boolean };
let profileState: AppProfileState;

function defaultHandlers(): Record<string, Handler> {
  return {
    kv_get: (a) => kv.get(kvKey(a)) ?? null,
    kv_put: (a) => {
      kv.set(kvKey(a), String(a.v));
    },
    app_get_runtime_config: () => ({ profile: "alice", identity: "alice", profile_state_path: "/data/alice/state.json" }),
    app_get_offline: () => network.offline,
    app_get_use_tor: () => network.useTor,
    app_set_offline: ({ offline }) => {
      network.offline = Boolean(offline);
    },
    app_set_use_tor: ({ useTor }) => {
      network.useTor = Boolean(useTor);
    },
    app_get_stable_onion: () => false,
    app_set_stable_onion: () => null,
    app_get_profile_state: () => profileState,
    app_clear_offline_profile: () => ({
      ...profileState,
      offline_profiles: profileState.offline_profiles.map((p) => ({
        ...p,
        profile: { display_name: "", email: "", phone: "", bio: "", date_of_birth: "" },
      })),
    }),
    tor_clean_keystore: () => null,
    dht_status: () => ({ enabled: true, running: true, bootstrapped: true }),
    dht_apply: () => null,
    vault_has_panic_code: () => false,
    vault_pin_status: () => ({ enrolled: false, digits: 6, attemptsLeft: 5 }),
    hp_ledger: () => [],
    hp_charge: ({ actionId }) => ({ applied: -100, code: actionId }),
    hp_recover: ({ recoveryId }) => ({ applied: 100, code: recoveryId }),
    hp_set_tor_posture: () => true,
    panic_targets_resync: () => null,
  };
}

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/:any(.*)*", component: { render: () => null } }],
});

beforeEach(async () => {
  invokeMock.mockClear();
  kv.clear();
  notif.granted = false;
  notif.requests = 0;
  network = { offline: false, useTor: false };
  profileState = {
    offline_profile: { display_name: "Ala", email: "", phone: "", bio: "", date_of_birth: "" },
    offline_profiles: [
      { id: "p1", label: "Personal", profile: { display_name: "Ala", email: "", phone: "", bio: "", date_of_birth: "" } },
      { id: "p2", label: "Work", profile: { display_name: "", email: "", phone: "", bio: "", date_of_birth: "" } },
    ],
    selected_offline_profile_id: "p1",
  };
  handlers = defaultHandlers();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
  setActivePinia(createPinia());
  stopHp();
  setHpTranslator({
    t: (k) => String((i18n.global.t as (x: string) => string)(k)),
    has: (k) => Boolean((i18n.global.te as (x: string) => boolean)(k)),
  });
  await router.replace("/config");
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 5; i++) await flushPromises();
}

async function mountAt(tab?: string) {
  await router.replace(tab ? `/config?tab=${tab}` : "/config");
  const pinia = createPinia();
  setActivePinia(pinia);
  const w = mount(EnigmaConfigView, {
    props: { darkMode: true },
    global: { plugins: [i18n, router, pinia], stubs: { teleport: true } },
  });
  await settle();
  invokeMock.mockClear();
  return w;
}

function button(w: VueWrapper, label: string) {
  const btn = w.findAll("button").find((b) => b.text().trim() === label);
  expect(btn, `button "${label}"`).toBeDefined();
  return btn!;
}

/** The switch in the row whose title is `label`. */
function switchFor(w: VueWrapper, label: string) {
  const row = w
    .findAll("div.flex.items-center.gap-3")
    .find((r) => r.find("p.text-sm.font-semibold").exists() && r.find("p.text-sm.font-semibold").text() === label);
  expect(row, `row "${label}"`).toBeDefined();
  return row!.find('button[role="switch"]');
}

/** The number field in the row whose title is `label`. */
function numberFor(w: VueWrapper, label: string) {
  const row = w
    .findAll("div.flex.items-center.gap-3")
    .find((r) => r.find("p.text-sm.font-semibold").exists() && r.find("p.text-sm.font-semibold").text() === label);
  expect(row, `row "${label}"`).toBeDefined();
  return { input: row!.find('input[type="number"]'), row: row! };
}

/** Type a value the way a user commits it (setValue fires input AND change). */
async function enter(w: VueWrapper, label: string, value: number) {
  const { input } = numberFor(w, label);
  await input.setValue(String(value));
  await settle();
  return input;
}

// ── which tab is open ───────────────────────────────────────────────────────

describe("the tab strip", () => {
  it("opens on the settings controls by default", async () => {
    const w = await mountAt();
    expect(w.text()).toContain("Interface language");
    expect(w.text()).not.toContain("Route over Tor");
  });

  it("opens the tab the link asks for, and falls back to settings for an unknown one", async () => {
    expect((await mountAt("lock")).text()).toContain("Panic code");
    expect((await mountAt("connections")).text()).toContain("Route over Tor");
    expect((await mountAt("data")).text()).toContain("Offline Data");
    const unknown = await mountAt("nonsense");
    expect(unknown.text()).toContain("Interface language");
  });

  it("follows a ?tab= change while already on the page (the view is reused)", async () => {
    const w = await mountAt();
    await router.replace("/config?tab=data");
    await settle();
    expect(w.text()).toContain("Offline Data");
    expect(w.text()).not.toContain("Interface language");
  });

  it("embeds the profile form without its standalone header", async () => {
    const w = await mountAt();
    await button(w, "My Profile").trigger("click");
    await settle();
    expect(w.find('input[placeholder="Your name"]').exists()).toBe(true);
    // The page has exactly one Back button: Settings' own.
    expect(w.findAll("button").filter((b) => b.text().trim() === "Back")).toHaveLength(1);
  });

  it("Back leaves for the start page", async () => {
    const w = await mountAt();
    await button(w, "Back").trigger("click");
    await settle();
    expect(router.currentRoute.value.path).toBe("/");
  });
});

// ── Settings tab ────────────────────────────────────────────────────────────

describe("language", () => {
  it("switches the whole interface live", async () => {
    const w = await mountAt();
    try {
      await w.find("select").setValue("pl");
      await settle();
      expect(w.find("h1").text()).toBe("Konfiguracja");
    } finally {
      setLocale("en", true);
    }
    await settle();
    expect(w.find("h1").text()).toBe("Configuration");
  });
});

describe("number settings", () => {
  it("stores the file-size limit and confirms it for a moment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = await mountAt();
    await enter(w, "Max file size", 2048);

    expect(setting("max_file_size_mb")).toBe("2048");
    expect(numberFor(w, "Max file size").row.text()).toContain("Saved");
    vi.advanceTimersByTime(1500);
    await settle();
    expect(numberFor(w, "Max file size").row.text()).not.toContain("Saved");
  });

  it("clamps out-of-range input to the build's bounds and shows what was stored", async () => {
    const w = await mountAt();
    const size = await enter(w, "Max file size", 10_000_000);
    expect(setting("max_file_size_mb")).toBe(String(100 * 1024));
    expect((size.element as HTMLInputElement).value).toBe(String(100 * 1024));

    const chunk = await enter(w, "File chunk size", 1);
    expect(setting("file_chunk_kib")).toBe("16");
    expect((chunk.element as HTMLInputElement).value).toBe("16");
  });

  it("reads the stored values back on open", async () => {
    seed("max_file_size_mb", "512");
    seed("file_key_rotation_days", "90");
    seed("meeting_reminder_mins", "5");
    const w = await mountAt();
    expect((numberFor(w, "Max file size").input.element as HTMLInputElement).value).toBe("512");
    expect((numberFor(w, "Rotate file keys").input.element as HTMLInputElement).value).toBe("90");
    expect((numberFor(w, "Meeting reminder").input.element as HTMLInputElement).value).toBe("5");
  });

  it("stores the key-rotation reminder", async () => {
    const w = await mountAt();
    await enter(w, "Rotate file keys", 30);
    expect(setting("file_key_rotation_days")).toBe("30");
  });

  it("asks for the notification permission when reminders are switched on, not off", async () => {
    // Turning reminders on is the friendly moment to ask, rather than at the
    // first reminder.
    const w = await mountAt();
    await enter(w, "Meeting reminder", 0);
    expect(setting("meeting_reminder_mins")).toBe("0");
    expect(notif.requests).toBe(0);

    await enter(w, "Meeting reminder", 10);
    expect(setting("meeting_reminder_mins")).toBe("10");
    expect(notif.requests).toBe(1);
  });

  it("does not ask again once the permission is granted", async () => {
    notif.granted = true;
    const w = await mountAt();
    await enter(w, "Meeting reminder", 10);
    expect(notif.requests).toBe(0);
  });
});

describe("file integrity", () => {
  it("prices switching verification off, and charges only that direction", async () => {
    const w = await mountAt();
    const toggle = switchFor(w, "Verify transferred files");
    expect(toggle.attributes("aria-checked")).toBe("true");
    expect(w.get('[data-testid="hp-badge-integrity"]').text()).toContain("−0.5 HP");

    await toggle.trigger("click");
    await settle();
    expect(setting("file_integrity")).toBe("off");
    expect(callsTo("hp_charge")).toEqual([{ actionId: "local.file_integrity.off", bytes: null, minutes: null }]);
    // Off already: the next tap restores protection, which costs nothing.
    expect(w.find('[data-testid="hp-badge-integrity"]').exists()).toBe(false);

    await toggle.trigger("click");
    await settle();
    expect(setting("file_integrity")).toBe("on");
    expect(callsTo("hp_charge")).toHaveLength(1);
  });
});

// ── Connections tab ─────────────────────────────────────────────────────────

describe("Tor", () => {
  it("switching Tor on routes through Rust, records the posture, and swaps the cards", async () => {
    const w = await mountAt("connections");
    expect(w.text()).toContain("DHT discovery");
    expect(w.text()).not.toContain("Keep onion address stable");

    await switchFor(w, "Route over Tor").trigger("click");
    await settle();

    expect(callsTo("app_set_use_tor")).toEqual([{ useTor: true }]);
    // Not a charge: the switch changes how fast HP comes back, from here on.
    expect(callsTo("hp_set_tor_posture")).toEqual([{ on: true }]);
    expect(callsTo("hp_charge")).toHaveLength(0);
    // The DHT rides iroh, which Tor mode shuts down — nothing to decide there.
    expect(w.text()).not.toContain("DHT discovery");
    expect(w.text()).toContain("Keep onion address stable");
    expect(w.get('[data-testid="hp-badge-tor"]').text()).toContain("Regenerating");
  });

  it("charges for a stable onion only when it is switched on", async () => {
    network.useTor = true;
    const w = await mountAt("connections");
    expect(w.get('[data-testid="hp-badge-stable-onion"]').text()).toContain("−1.5 HP");

    const toggle = switchFor(w, "Keep onion address stable");
    await toggle.trigger("click");
    await settle();
    expect(callsTo("app_set_stable_onion")).toEqual([{ stableOnion: true }]);
    expect(callsTo("hp_charge")).toEqual([{ actionId: "transport.onion_stable.enable", bytes: null, minutes: null }]);

    await toggle.trigger("click");
    await settle();
    expect(callsTo("app_set_stable_onion")).toEqual([{ stableOnion: true }, { stableOnion: false }]);
    // Switching back earns nothing: the old address was already seen.
    expect(callsTo("hp_charge")).toHaveLength(1);
    expect(callsTo("hp_recover")).toHaveLength(0);
  });
});

describe("DHT discovery", () => {
  it("asks before announcing this node, and changes nothing on a no", async () => {
    const w = await mountAt("connections");
    expect(w.get('[data-testid="hp-badge-dht"]').text()).toContain("−5 HP");

    await switchFor(w, "DHT discovery").trigger("click");
    await settle();
    expect(hpConfirm.value?.centi).toBe(-500);

    resolveHpConfirm(false);
    await settle();
    expect(setting("dht_discovery")).toBeUndefined();
    expect(callsTo("dht_apply")).toHaveLength(0);
    expect(switchFor(w, "DHT discovery").attributes("aria-checked")).toBe("false");
  });

  it("once confirmed: stores it, rebinds, charges after the rebind, and probes the DHT", async () => {
    const w = await mountAt("connections");
    await switchFor(w, "DHT discovery").trigger("click");
    await settle();
    resolveHpConfirm(true);
    await settle();

    expect(setting("dht_discovery")).toBe("on");
    const order = sent();
    // Charged after dht_apply: until the rebind nothing has been announced.
    expect(order.indexOf("dht_apply")).toBeLessThan(order.indexOf("hp_charge"));
    expect(callsTo("hp_charge")).toEqual([{ actionId: "dht.presence.enable", bytes: null, minutes: null }]);
    expect(callsTo("dht_status")).toHaveLength(1);
    expect(w.text()).toContain("DHT reachable");
    // The tuning knobs appear with it, and the badge now shows the withdrawal credit.
    expect(w.text()).toContain("Room announce interval");
    expect(w.get('[data-testid="hp-badge-dht"]').text()).toContain("+2.5 HP");
  });

  it("switching it off needs no confirm and claims the withdrawal credit", async () => {
    seed("dht_discovery", "on");
    const w = await mountAt("connections");
    await switchFor(w, "DHT discovery").trigger("click");
    await settle();

    expect(hpConfirm.value).toBeNull();
    expect(setting("dht_discovery")).toBe("off");
    expect(callsTo("dht_apply")).toHaveLength(1);
    expect(callsTo("hp_recover")).toEqual([{ recoveryId: "dht.presence.withdraw" }]);
    expect(w.text()).not.toContain("Room announce interval");
  });

  it("retries a node that has not bootstrapped yet before calling it unreachable", async () => {
    // A fresh Mainline node needs a few seconds to fill its routing table.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seed("dht_discovery", "on");
    handlers.dht_status = () => ({ enabled: true, running: true, bootstrapped: false });
    const w = await mountAt("connections");
    expect(w.text()).toContain("Checking DHT…");

    vi.advanceTimersByTime(5000);
    await settle();
    expect(w.text()).toContain("Checking DHT…");
    vi.advanceTimersByTime(5000);
    await settle();

    expect(w.text()).toContain("DHT unreachable");
    // Three probes, five seconds apart — then it gives up.
    expect(callsTo("dht_status")).toHaveLength(2);
  });

  it("reports a bootstrap that lands on a retry as reachable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seed("dht_discovery", "on");
    let probes = 0;
    handlers.dht_status = () => ({ enabled: true, running: true, bootstrapped: ++probes >= 2 });
    const w = await mountAt("connections");
    vi.advanceTimersByTime(5000);
    await settle();

    expect(w.text()).toContain("DHT reachable");
    expect(probes).toBe(2);
  });

  it("says the node is idle, not unreachable, when it is not running at all", async () => {
    seed("dht_discovery", "on");
    handlers.dht_status = () => ({ enabled: true, running: false, bootstrapped: false });
    const w = await mountAt("connections");
    expect(w.text()).toContain("Not active — offline or Tor mode is blocking the P2P node");
    expect(w.text()).not.toContain("DHT unreachable");
  });

  it("Test DHT probes again on demand", async () => {
    seed("dht_discovery", "on");
    const w = await mountAt("connections");
    await w.findAll("button").find((b) => b.text().includes("Test DHT"))!.trigger("click");
    await settle();
    expect(callsTo("dht_status")).toHaveLength(1);
    expect(w.text()).toContain("DHT reachable");
  });

  it("stores the announce and presence cadences, clamped", async () => {
    seed("dht_discovery", "on");
    const w = await mountAt("connections");
    await enter(w, "Room announce interval", 5);
    expect(setting("dht_room_publish_secs")).toBe("60");
    await enter(w, "Presence refresh", 900);
    expect(setting("dht_presence_poll_secs")).toBe("900");
  });
});

describe("connection timeout", () => {
  it("stores the timeout, clamped to the build's minimum", async () => {
    const w = await mountAt("connections");
    const input = await enter(w, "Connection timeout", 1);
    expect(setting("connect_timeout_secs")).toBe("5");
    expect((input.element as HTMLInputElement).value).toBe("5");
  });
});

// ── Lock tab ────────────────────────────────────────────────────────────────

describe("auto-lock", () => {
  it("changing the minutes is stored and charges nothing", async () => {
    const w = await mountAt("lock");
    await enter(w, "Auto-lock", 30);

    expect(setting("idle_lock_mins")).toBe("30");
    expect(callsTo("hp_charge")).toHaveLength(0);
    // Rust decides whether a recovery is owed; an edit between two non-zero
    // values never is, so only the request goes out.
    expect(callsTo("hp_recover")).toEqual([{ recoveryId: "local.autolock.on" }]);
  });

  it("prices 'never lock' on the field itself", async () => {
    seed("idle_lock_mins", "0");
    const w = await mountAt("lock");
    expect(w.get('[data-testid="hp-badge-autolock"]').text()).toContain("−5 HP");
  });

  it("re-saving an already-off auto-lock does not ask again", async () => {
    seed("idle_lock_mins", "0");
    const w = await mountAt("lock");
    await enter(w, "Auto-lock", 0);
    expect(hpConfirm.value).toBeNull();
    expect(setting("idle_lock_mins")).toBe("0");
  });
});

describe("lock when hidden", () => {
  it("charges for switching it off, not on", async () => {
    const w = await mountAt("lock");
    const toggle = switchFor(w, "Lock when hidden");
    await toggle.trigger("click");
    await settle();
    expect(setting("lock_on_hide")).toBe("1");
    expect(callsTo("hp_charge")).toHaveLength(0);
    expect(w.get('[data-testid="hp-badge-lock-on-hide"]').text()).toContain("−0.5 HP");

    await toggle.trigger("click");
    await settle();
    expect(setting("lock_on_hide")).toBe("0");
    expect(callsTo("hp_charge")).toEqual([{ actionId: "local.lock_on_hide.off", bytes: null, minutes: null }]);
  });
});

describe("reset passphrase", () => {
  async function open() {
    const w = await mountAt("lock");
    await button(w, "Reset passphrase").trigger("click");
    const fields = w.findAll('input[type="password"]');
    return { w, current: fields[0], next: fields[1], confirm: fields[2] };
  }

  it("refuses a too-short passphrase before asking Rust", async () => {
    const { w, current, next, confirm } = await open();
    await current.setValue("old-passphrase");
    await next.setValue("short");
    await confirm.setValue("short");
    await button(w, "Change passphrase").trigger("click");
    await settle();
    expect(w.text()).toContain("Passphrase must be at least 8 characters.");
    expect(callsTo("vault_change_passphrase")).toHaveLength(0);
  });

  it("refuses a mismatched confirmation", async () => {
    const { w, current, next, confirm } = await open();
    await current.setValue("old-passphrase");
    await next.setValue("new-passphrase-1");
    await confirm.setValue("new-passphrase-2");
    await button(w, "Change passphrase").trigger("click");
    await settle();
    expect(w.text()).toContain("Passphrases don't match.");
    expect(callsTo("vault_change_passphrase")).toHaveLength(0);
  });

  it("reports a wrong current passphrase", async () => {
    handlers.vault_change_passphrase = () => {
      throw "wrong passphrase";
    };
    const { w, current, next, confirm } = await open();
    await current.setValue("not-it-at-all");
    await next.setValue("new-passphrase");
    await confirm.setValue("new-passphrase");
    await button(w, "Change passphrase").trigger("click");
    await settle();
    expect(w.text()).toContain("Wrong passphrase.");
    expect(w.text()).not.toContain("Passphrase changed.");
  });

  it("changes it with exactly the current and new passphrase, then closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    handlers.vault_change_passphrase = () => null;
    const { w, current, next, confirm } = await open();
    await current.setValue("old-passphrase");
    await next.setValue("new-passphrase");
    await confirm.setValue("new-passphrase");
    await button(w, "Change passphrase").trigger("click");
    await settle();

    expect(callsTo("vault_change_passphrase")).toEqual([{ current: "old-passphrase", new: "new-passphrase" }]);
    expect(w.text()).toContain("Passphrase changed.");
    vi.advanceTimersByTime(1200);
    await settle();
    expect(w.find('input[type="password"]').exists()).toBe(false);
  });
});

describe("PIN unlock", () => {
  it("enrols a PIN with the passphrase as proof, and charges the enrolment", async () => {
    handlers.vault_pin_enroll = () => null;
    const w = await mountAt("lock");
    expect(w.get('[data-testid="pin-card"]').text()).toContain("No PIN");

    await w.get('[data-testid="pin-setup"]').trigger("click");
    expect(w.text()).toContain("the PIN is 6 digits");
    const fields = w.findAll('input[type="password"]');
    await fields[0].setValue("my-passphrase");
    await w.get('[data-testid="pin-input"]').setValue("123456");
    await w.get('[data-testid="pin-submit"]').trigger("click");
    await settle();

    // No panic PIN typed → none sent (undefined, not an empty string Rust would reject).
    expect(callsTo("vault_pin_enroll")).toEqual([
      { passphrase: "my-passphrase", pin: "123456", panicPin: undefined, panicCode: undefined },
    ]);
    expect(callsTo("hp_charge")).toEqual([{ actionId: "local.pin.enroll", bytes: null, minutes: null }]);
    expect(w.get('[data-testid="pin-card"]').text()).toContain("A PIN is set for this session.");
    expect(w.find('[data-testid="pin-input"]').exists()).toBe(false);
  });

  it("asks for the panic code only once a panic PIN is typed, and sends both", async () => {
    handlers.vault_pin_enroll = () => null;
    const w = await mountAt("lock");
    await w.get('[data-testid="pin-setup"]').trigger("click");
    expect(w.find('input[placeholder="Your panic code"]').exists()).toBe(false);
    await w.find('input[placeholder="Panic PIN (optional)"]').setValue("654321");
    expect(w.find('input[placeholder="Your panic code"]').exists()).toBe(true);

    await w.find('input[placeholder="Passphrase"]').setValue("my-passphrase");
    await w.get('[data-testid="pin-input"]').setValue("123456");
    await w.find('input[placeholder="Your panic code"]').setValue("panic-code-1");
    await w.get('[data-testid="pin-submit"]').trigger("click");
    await settle();

    expect(callsTo("vault_pin_enroll")).toEqual([
      { passphrase: "my-passphrase", pin: "123456", panicPin: "654321", panicCode: "panic-code-1" },
    ]);
  });

  it("shows Rust's refusal and keeps the dialog open, uncharged", async () => {
    handlers.vault_pin_enroll = () => {
      throw "panic PIN must differ from the PIN in at least two digits";
    };
    const w = await mountAt("lock");
    await w.get('[data-testid="pin-setup"]').trigger("click");
    await w.get('[data-testid="pin-input"]').setValue("123456");
    await w.get('[data-testid="pin-submit"]').trigger("click");
    await settle();

    expect(w.get('[data-testid="pin-error"]').text()).toBe("panic PIN must differ from the PIN in at least two digits");
    expect(w.find('[data-testid="pin-input"]').exists()).toBe(true);
    expect(callsTo("hp_charge")).toHaveLength(0);
  });

  it("removes an enrolled PIN", async () => {
    handlers.vault_pin_status = () => ({ enrolled: true, digits: 6, attemptsLeft: 5 });
    handlers.vault_pin_clear = () => null;
    const w = await mountAt("lock");
    expect(w.get('[data-testid="pin-setup"]').text()).toBe("Change PIN");

    await w.get('[data-testid="pin-remove"]').trigger("click");
    await settle();
    expect(callsTo("vault_pin_clear")).toHaveLength(1);
    expect(w.get('[data-testid="pin-card"]').text()).toContain("No PIN");
    expect(w.find('[data-testid="pin-remove"]').exists()).toBe(false);
  });
});

describe("panic code", () => {
  async function open(armed = false) {
    handlers.vault_has_panic_code = () => armed;
    const w = await mountAt("lock");
    await button(w, armed ? "Change panic code" : "Set panic code").trigger("click");
    const fields = w.findAll('input[type="password"]');
    return { w, current: fields[0], code: fields[1], confirm: fields[2] };
  }
  const submit = (w: VueWrapper) =>
    w.findAll("button").filter((b) => b.text().trim() === "Set panic code").pop()!.trigger("click");

  it("arms a panic code with the real passphrase as authority", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    handlers.vault_set_panic_code = () => null;
    const { w, current, code, confirm } = await open();
    expect(w.text()).toContain("No panic code set.");
    await current.setValue("my-passphrase");
    await code.setValue("burn-it-all");
    await confirm.setValue("burn-it-all");
    await submit(w);
    await settle();

    expect(callsTo("vault_set_panic_code")).toEqual([{ current: "my-passphrase", code: "burn-it-all" }]);
    expect(w.text()).toContain("Panic code set.");
    expect(w.text()).toContain("A panic code is set.");
    vi.advanceTimersByTime(1200);
    await settle();
    expect(w.find('input[type="password"]').exists()).toBe(false);
  });

  it("checks length and confirmation before asking Rust", async () => {
    handlers.vault_set_panic_code = () => null;
    const { w, current, code, confirm } = await open();
    await current.setValue("my-passphrase");
    await code.setValue("short");
    await confirm.setValue("short");
    await submit(w);
    await settle();
    expect(w.text()).toContain("Passphrase must be at least 8 characters.");

    await code.setValue("burn-it-all");
    await confirm.setValue("burn-it-al1");
    await submit(w);
    await settle();
    expect(w.text()).toContain("Passphrases don't match.");
    expect(callsTo("vault_set_panic_code")).toHaveLength(0);
  });

  it("tells a code equal to the passphrase apart from a wrong passphrase", async () => {
    // Rust is the authority on "same as your passphrase": it tests the code
    // against the real key slot.
    handlers.vault_set_panic_code = () => {
      throw new Error("panic code must differ from the passphrase");
    };
    const { w, current, code, confirm } = await open();
    await current.setValue("my-passphrase");
    await code.setValue("my-passphrase");
    await confirm.setValue("my-passphrase");
    await submit(w);
    await settle();
    expect(w.text()).toContain("The panic code must be different from your passphrase.");

    handlers.vault_set_panic_code = () => {
      throw new Error("bad key");
    };
    await code.setValue("burn-it-all");
    await confirm.setValue("burn-it-all");
    await submit(w);
    await settle();
    expect(w.text()).toContain("Wrong passphrase.");
    expect(w.text()).toContain("No panic code set.");
  });

  it("removes an armed code with the passphrase alone, and charges the loss of protection", async () => {
    handlers.vault_clear_panic_code = () => null;
    const { w, current } = await open(true);
    await current.setValue("my-passphrase");
    await button(w, "Remove").trigger("click");
    await settle();

    expect(callsTo("vault_clear_panic_code")).toEqual([{ current: "my-passphrase" }]);
    expect(callsTo("hp_charge")).toEqual([{ actionId: "local.panic_code.clear", bytes: null, minutes: null }]);
    expect(w.text()).toContain("Panic code removed.");
    expect(w.text()).toContain("No panic code set.");
  });

  it("a refused removal leaves the code armed and charges nothing", async () => {
    handlers.vault_clear_panic_code = () => {
      throw "wrong passphrase";
    };
    const { w, current } = await open(true);
    await current.setValue("guess");
    await button(w, "Remove").trigger("click");
    await settle();

    expect(w.text()).toContain("Wrong passphrase.");
    expect(w.text()).toContain("A panic code is set.");
    expect(callsTo("hp_charge")).toHaveLength(0);
  });
});

describe("delete files on panic", () => {
  it("is inert without a panic code to trigger it", async () => {
    const w = await mountAt("lock");
    const toggle = switchFor(w, "Delete files on panic");
    expect((toggle.element as HTMLButtonElement).disabled).toBe(true);
    expect(w.text()).toContain("Set a panic code first");
  });

  it("with a code armed, stores the choice and re-seals the panic target list", async () => {
    handlers.vault_has_panic_code = () => true;
    const w = await mountAt("lock");
    const toggle = switchFor(w, "Delete files on panic");
    expect((toggle.element as HTMLButtonElement).disabled).toBe(false);

    await toggle.trigger("click");
    await settle();
    expect(setting("delete_files_on_panic")).toBe("1");
    // The path list lives in a sidecar sealed under the panic code; Rust has to
    // re-seal it for the change to mean anything at the gate.
    expect(callsTo("panic_targets_resync")).toHaveLength(1);
    expect(toggle.attributes("aria-checked")).toBe("true");
  });
});

// ── Data tab ────────────────────────────────────────────────────────────────

describe("offline mode", () => {
  it("switches airplane mode through Rust and says what it means", async () => {
    const w = await mountAt("data");
    expect(w.text()).toContain("Online — connections are allowed.");
    await switchFor(w, "Offline mode").trigger("click");
    await settle();
    expect(callsTo("app_set_offline")).toEqual([{ offline: true }]);
    expect(w.text()).toContain("Airplane mode — every P2P connection is blocked.");
  });
});

describe("offline data", () => {
  it("summarises the active profile and how much is stored", async () => {
    const w = await mountAt("data");
    const text = w.text();
    expect(text).toMatch(/Active APP_PROFILE\s*alice/);
    expect(text).toMatch(/Active CHAT_USER\s*alice/);
    expect(text).toContain("Data saved");
    expect(text).toMatch(/Profiles\s*2/);
    // The field starts on the active profile's name.
    expect((w.find('input[placeholder="alice"]').element as HTMLInputElement).value).toBe("alice");
  });

  it("reports an empty selected profile as empty", async () => {
    profileState.selected_offline_profile_id = "p2";
    const w = await mountAt("data");
    expect(w.text()).toMatch(/Stored fields\s*Empty/);
  });

  it("clearing the selected data also resets the Tor keystore", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = await mountAt("data");
    await w.findAll("button").find((b) => b.text().includes("Clear selected data"))!.trigger("click");
    await settle();

    expect(sent().filter((c) => c === "app_clear_offline_profile" || c === "tor_clean_keystore")).toEqual([
      "app_clear_offline_profile",
      "tor_clean_keystore",
    ]);
    expect(w.text()).toContain("Offline data cleared.");
    expect(w.text()).toMatch(/Stored fields\s*Empty/);
    vi.advanceTimersByTime(2000);
    await settle();
    expect(w.text()).not.toContain("Offline data cleared.");
  });

  it("does not try to load a profile without a name", async () => {
    const w = await mountAt("data");
    // The chip next to the field clears it.
    await w.findAll("button").find((b) => b.text().trim() === "alice")!.trigger("click");
    expect((w.find('input[placeholder="alice"]').element as HTMLInputElement).value).toBe("");
    await w.find('input[placeholder="alice"]').trigger("keyup.enter");
    await settle();
    expect(callsTo("app_set_active_profile")).toHaveLength(0);
  });

  it("shows why switching to another profile failed", async () => {
    handlers.app_set_active_profile = () => {
      throw new Error("profile name is not allowed");
    };
    const w = await mountAt("data");
    const field = w.find('input[placeholder="alice"]');
    await field.setValue("  bob ");
    await field.trigger("keyup.enter");
    await settle();

    // The profile and the chat identity are the same name.
    expect(callsTo("app_set_active_profile")).toEqual([{ profile: "bob", identity: "bob" }]);
    const message = w.findAll("p").find((p) => p.text() === "profile name is not allowed");
    expect(message, "error line").toBeDefined();
    expect(message!.classes()).toContain("text-warn-dark");
  });
});
