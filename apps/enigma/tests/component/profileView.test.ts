// The profile form (standalone, and embedded as Settings → Profile).
//
// Enigma26 has no account: who you are is this locally stored profile, and the
// display name is what every peer sees in chat. So what is pinned here is the
// round trip to the Rust profile store — the exact profile each button writes,
// that the form re-reads what Rust answers instead of trusting itself, and that
// the irreversible "Clear all data" only moves on when the clear succeeded.
//
// Runs in Tauri mode against a small in-memory profile store behind the real
// Tauri IPC hook (see contactsView.test.ts for why the hook and not vi.mock).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import type { AppProfileState, OfflineProfile } from "rakotis";

const { downscale } = vi.hoisted(() => ({ downscale: vi.fn() }));
// jsdom has no canvas to shrink a picture with; the resize itself belongs to rakotis.
vi.mock("rakotis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("rakotis")>()),
  downscaleImageToDataUrl: (...a: unknown[]) => downscale(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chatStore: any;
vi.mock("../../src/stores/chat", () => ({ useChatStore: () => chatStore }));

import "@tauri-apps/api/core";
import { i18n } from "../../src/i18n";
import EnigmaProfileView from "../../src/views/EnigmaProfileView.vue";

(i18n.global.locale as any).value = "en";

const EMPTY: OfflineProfile = { display_name: "", email: "", phone: "", bio: "", date_of_birth: "", avatar: "" };

// ── the fake Rust profile store ─────────────────────────────────────────────
let profiles: Record<string, { label: string; profile: OfflineProfile }>;
let selected: string;
function state(): AppProfileState {
  return {
    offline_profile: { ...profiles[selected].profile },
    offline_profiles: Object.entries(profiles).map(([id, p]) => ({ id, label: p.label, profile: { ...p.profile } })),
    selected_offline_profile_id: selected,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args);
});
const callsTo = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

function defaultHandlers(): Record<string, Handler> {
  return {
    app_get_profile_state: () => state(),
    app_set_offline_profile: ({ offlineProfile }) => {
      profiles[selected].profile = { ...(offlineProfile as OfflineProfile) };
    },
    app_set_selected_offline_profile: ({ selectedOfflineProfileId }) => {
      selected = String(selectedOfflineProfileId);
      return state();
    },
    app_upsert_offline_profile: ({ offlineProfileId, label, offlineProfile }) => {
      profiles[String(offlineProfileId)] = { label: String(label), profile: { ...(offlineProfile as OfflineProfile) } };
      selected = String(offlineProfileId);
      return state();
    },
    app_clear_offline_profile: () => {
      profiles[selected].profile = { ...EMPTY };
      return state();
    },
    app_clear_profile_state: () => {
      profiles = { default: { label: "Default", profile: { ...EMPTY } } };
      selected = "default";
      return state();
    },
  };
}

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/:any(.*)*", component: { render: () => null } }],
});

beforeEach(async () => {
  invokeMock.mockClear();
  downscale.mockReset();
  profiles = {
    p1: {
      label: "Personal",
      profile: {
        display_name: "Ala",
        email: "ala@example.com",
        phone: "+48 600 100 200",
        bio: "Climbs on weekends.",
        date_of_birth: "1990-05-01",
        avatar: "",
      },
    },
    p2: { label: "Work", profile: { ...EMPTY, display_name: "Ala K.", email: "ala@work.example" } },
  };
  selected = "p1";
  handlers = defaultHandlers();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
  chatStore = { clearLocalChatState: vi.fn() };
  setActivePinia(createPinia());
  await router.replace("/config");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mountView(props: Record<string, unknown> = {}) {
  const w = mount(EnigmaProfileView, {
    props: { darkMode: true, ...props },
    global: { plugins: [i18n, router] },
  });
  await flushPromises();
  return w;
}

function button(w: VueWrapper, label: string) {
  const btn = w.findAll("button").find((b) => b.text().includes(label));
  expect(btn, `button "${label}"`).toBeDefined();
  return btn!;
}

const nameField = (w: VueWrapper) => w.find('input[placeholder="Your name"]');
const valueOf = (w: VueWrapper, selector: string) =>
  (w.find(selector).element as HTMLInputElement | HTMLTextAreaElement).value;

// ── loading ─────────────────────────────────────────────────────────────────

describe("the profile form", () => {
  it("shows the selected stored profile, field by field", async () => {
    const w = await mountView();
    expect(valueOf(w, 'input[placeholder="Your name"]')).toBe("Ala");
    expect(valueOf(w, 'input[type="email"]')).toBe("ala@example.com");
    expect(valueOf(w, 'input[type="tel"]')).toBe("+48 600 100 200");
    expect(valueOf(w, 'input[type="date"]')).toBe("1990-05-01");
    expect(valueOf(w, "textarea")).toBe("Climbs on weekends.");
    // The save button names the profile it writes to.
    expect(w.text()).toContain("Save Personal");
  });

  it("offers every stored profile in the picker, with the selected one chosen", async () => {
    const w = await mountView();
    const select = w.find("select");
    expect(select.findAll("option").map((o) => o.text())).toEqual(["Personal", "Work"]);
    expect((select.element as HTMLSelectElement).value).toBe("p1");
  });

  it("falls back to a generic label when no profile is selected", async () => {
    selected = "p1";
    handlers.app_get_profile_state = () => ({ ...state(), selected_offline_profile_id: "" });
    const w = await mountView();
    expect(w.text()).toContain("Save Selected profile");
  });

  it("has its own header and Back button when standalone, none when embedded", async () => {
    const standalone = await mountView();
    expect(standalone.text()).toContain("My Profile");
    await button(standalone, "Back").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/");

    const embedded = await mountView({ embedded: true });
    expect(embedded.text()).not.toContain("My Profile");
    expect(embedded.findAll("button").some((b) => b.text().includes("Back"))).toBe(false);
  });
});

// ── saving ──────────────────────────────────────────────────────────────────

describe("saving", () => {
  it("writes the whole edited profile, then shows it as saved for two seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = await mountView();
    await nameField(w).setValue("Ala Nowak");
    await w.find('input[type="email"]').setValue("ala@nowak.example");
    await button(w, "Save Personal").trigger("click");
    await flushPromises();

    expect(callsTo("app_set_offline_profile")).toEqual([
      {
        offlineProfile: {
          display_name: "Ala Nowak",
          email: "ala@nowak.example",
          phone: "+48 600 100 200",
          bio: "Climbs on weekends.",
          date_of_birth: "1990-05-01",
          avatar: "",
        },
      },
    ]);
    // Re-read from Rust after the write, not assumed.
    expect(callsTo("app_get_profile_state")).toHaveLength(2);
    expect(w.text()).toContain("Saved locally");

    vi.advanceTimersByTime(2000);
    await flushPromises();
    expect(w.text()).not.toContain("Saved locally");
    expect(w.text()).toContain("Save Personal");
  });

  it("refuses to save without a display name — it is what peers see", async () => {
    const w = await mountView();
    await nameField(w).setValue("   ");
    await button(w, "Save Personal").trigger("click");
    await flushPromises();

    expect(callsTo("app_set_offline_profile")).toHaveLength(0);
    expect(w.text()).not.toContain("Saved locally");
  });
});

describe("the profile picture", () => {
  function pick(w: VueWrapper, file: File | null) {
    const input = w.find('input[type="file"]');
    Object.defineProperty(input.element, "files", { value: file ? [file] : [], configurable: true });
    return input.trigger("change");
  }

  it("shrinks the picked image and saves it with the profile", async () => {
    downscale.mockResolvedValue("data:image/jpeg;base64,QUJD");
    const w = await mountView();
    const file = new File(["png-bytes"], "me.png", { type: "image/png" });
    await pick(w, file);
    await flushPromises();

    // 256 px JPEG at 0.8: small enough to ride encrypted presence.
    expect(downscale).toHaveBeenCalledWith(file, 256, 0.8);
    expect(w.find("img").attributes("src")).toBe("data:image/jpeg;base64,QUJD");

    await button(w, "Save Personal").trigger("click");
    await flushPromises();
    expect(callsTo("app_set_offline_profile")[0]).toEqual({
      offlineProfile: expect.objectContaining({ avatar: "data:image/jpeg;base64,QUJD" }),
    });
  });

  it("ignores a cancelled file dialog", async () => {
    const w = await mountView();
    await pick(w, null);
    await flushPromises();
    expect(downscale).not.toHaveBeenCalled();
    expect(w.find("img").exists()).toBe(false);
  });

  it("removes a picture, falling back to the initials", async () => {
    profiles.p1.profile.avatar = "data:image/jpeg;base64,T0xE";
    const w = await mountView();
    expect(w.find("img").exists()).toBe(true);

    await button(w, "Remove").trigger("click");
    expect(w.find("img").exists()).toBe(false);
    expect(w.text()).toContain("AL");
    expect(w.findAll("button").some((b) => b.text() === "Remove")).toBe(false);
  });
});

// ── profiles ────────────────────────────────────────────────────────────────

describe("switching and adding profiles", () => {
  it("switches to another stored profile and shows its data", async () => {
    const w = await mountView();
    await w.find("select").setValue("p2");
    await flushPromises();

    expect(callsTo("app_set_selected_offline_profile")).toEqual([{ selectedOfflineProfileId: "p2" }]);
    expect(valueOf(w, 'input[placeholder="Your name"]')).toBe("Ala K.");
    expect(w.text()).toContain("Save Work");
  });

  it("does not re-select the profile that is already selected", async () => {
    const w = await mountView();
    await w.find("select").trigger("change");
    await flushPromises();
    expect(callsTo("app_set_selected_offline_profile")).toHaveLength(0);
  });

  it("saves the current form as a new named profile", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const w = await mountView();
    await nameField(w).setValue("Ala (travel)");
    const label = w.find('input[placeholder="New profile name"]');
    await label.setValue("  Travel  ");
    await button(w, "Add profile").trigger("click");
    await flushPromises();

    expect(callsTo("app_upsert_offline_profile")).toEqual([
      {
        offlineProfileId: "00000000-0000-4000-8000-000000000001",
        label: "Travel",
        offlineProfile: expect.objectContaining({ display_name: "Ala (travel)" }),
      },
    ]);
    expect((label.element as HTMLInputElement).value).toBe("");
    expect(w.find("select").findAll("option").map((o) => o.text())).toContain("Travel");
    expect(w.text()).toContain("Saved locally");
  });

  it("needs a name for the new profile", async () => {
    const w = await mountView();
    await w.find('input[placeholder="New profile name"]').setValue("  ");
    await button(w, "Add profile").trigger("click");
    await flushPromises();
    expect(callsTo("app_upsert_offline_profile")).toHaveLength(0);
  });
});

// ── clearing ────────────────────────────────────────────────────────────────

describe("clearing data", () => {
  it("clears only the selected profile's fields", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = await mountView();
    await button(w, "Clear data").trigger("click");
    await flushPromises();

    expect(callsTo("app_clear_offline_profile")).toHaveLength(1);
    expect(valueOf(w, 'input[placeholder="Your name"]')).toBe("");
    // The other profile is untouched, and still on offer.
    expect(profiles.p2.profile.display_name).toBe("Ala K.");
    expect(w.text()).toContain("Cleared");
    vi.advanceTimersByTime(2000);
    await flushPromises();
    expect(w.text()).toContain("Clear data");
  });

  it("clear all data wipes the profiles, resets the chat state and returns to chat", async () => {
    const w = await mountView();
    await button(w, "Clear all data").trigger("click");
    await flushPromises();

    expect(callsTo("app_clear_profile_state")).toHaveLength(1);
    expect(chatStore.clearLocalChatState).toHaveBeenCalledWith("Cleared profile data and reset MLS.");
    expect(router.currentRoute.value.path).toBe("/chat");
    expect(w.find("select").findAll("option").map((o) => o.text())).toEqual(["Default"]);
  });

  it("a failed wipe says why and leaves the chat state and the page alone", async () => {
    handlers.app_clear_profile_state = () => {
      throw new Error("profile store is locked");
    };
    const w = await mountView();
    await button(w, "Clear all data").trigger("click");
    await flushPromises();

    expect(w.text()).toContain("profile store is locked");
    expect(chatStore.clearLocalChatState).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe("/config");
    // The button is usable again for a retry.
    expect(w.text()).toContain("Clear all data");
  });

  it("ignores a second click while the wipe is still running", async () => {
    let finish!: (s: AppProfileState) => void;
    handlers.app_clear_profile_state = () => new Promise<AppProfileState>((r) => (finish = r));
    const w = await mountView();
    await button(w, "Clear all data").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Clearing…");
    await button(w, "Clearing…").trigger("click");
    await flushPromises();
    expect(callsTo("app_clear_profile_state")).toHaveLength(1);

    finish(state());
    await flushPromises();
    expect(chatStore.clearLocalChatState).toHaveBeenCalledTimes(1);
  });
});
