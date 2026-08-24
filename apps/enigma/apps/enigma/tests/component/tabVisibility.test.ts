import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { initBuildConfig, setHiddenTabs } from "rakotis";

// The rendered half of per-user tab visibility: a hidden tab must be gone from
// BOTH navs (the desktop bar and the mobile drawer are two independent copies of
// the same list), and Settings must offer a checkbox for exactly the tabs this
// build contains — never one for itself.

const fileShare = { state: ref("idle") };
const vox = { phase: ref("idle") };
const invites = { incoming: ref(false) };
const meetings = { attentionCount: ref(0) };

vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    syncRuntimeIdentity: vi.fn(),
    init: vi.fn(),
    p2p: { currentUserName: ref(""), myAvatar: ref("") },
    fileShare,
    vox,
    invites,
    meetings,
    callsEnabled: true,
    contactsEnabled: true,
    calendarEnabled: true,
  }),
}));

import App from "../../src/App.vue";
import EnigmaConfigView from "../../src/views/EnigmaConfigView.vue";
import router from "../../src/router";
import { i18n } from "../../src/i18n";
import { APP_TABS, loadTabVisibility, setTabVisible } from "../../src/tabs";

(i18n.global.locale as any).value = "en";

// that have nothing to do with tabs; off here so the mount stays about the nav.
afterAll(async () => {
  await initBuildConfig({ calls_enabled: true });
});

let pinia: ReturnType<typeof createPinia>;

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  await loadTabVisibility();
  await router.replace("/config");
  await router.isReady();
  fileShare.state.value = "idle";
  vox.phase.value = "idle";
  invites.incoming.value = false;
  meetings.attentionCount.value = 0;
});

/** App with the routed view stubbed out — this is a test about the chrome. */
async function mountApp() {
  const wrapper = mount(App, {
    global: { plugins: [i18n, pinia, router], stubs: { RouterView: true } },
  });
  await flushPromises();
  // Open the hamburger drawer so the SECOND nav list renders too: a gate applied
  // to only one of them leaves the tab reachable from the other.
  await wrapper.find('button[aria-label="Open menu"]').trigger("click");
  await flushPromises();
  return wrapper;
}

/** How many nav entries point at `path` (desktop bar + mobile drawer = 2). */
const linksTo = (wrapper: ReturnType<typeof mount>, path: string) =>
  wrapper.findAll(`a[href="${path}"]`).length;

describe("the nav", () => {
  it("shows every tab by default, in both lists", async () => {
    const wrapper = await mountApp();
    for (const path of ["/chat", "/files", "/vox", "/calendar", "/map", "/contacts", "/privacy", "/config"]) {
      expect(linksTo(wrapper, path), path).toBe(2);
    }
  });

  it("drops a hidden tab from the desktop bar AND the mobile drawer", async () => {
    await setTabVisible("map", false);
    await setTabVisible("chat", false);
    const wrapper = await mountApp();

    expect(linksTo(wrapper, "/map")).toBe(0);
    expect(linksTo(wrapper, "/chat")).toBe(0);
    expect(wrapper.text()).not.toContain("Map");
    // Everything else is untouched, Settings above all.
    expect(linksTo(wrapper, "/files")).toBe(2);
    expect(linksTo(wrapper, "/config")).toBe(2);
  });

  it("reacts to the checkbox without a remount (App mounts once, for good)", async () => {
    const wrapper = await mountApp();
    expect(linksTo(wrapper, "/calendar")).toBe(2);

    await setTabVisible("calendar", false);
    await flushPromises();
    expect(linksTo(wrapper, "/calendar")).toBe(0);

    await setTabVisible("calendar", true);
    await flushPromises();
    expect(linksTo(wrapper, "/calendar")).toBe(2);
  });

  it("keeps Settings even when the user has hidden everything else", async () => {
    for (const id of ["chat", "files", "vox", "calendar", "map", "contacts", "privacy"] as const) {
      await setTabVisible(id, false);
    }
    const wrapper = await mountApp();
    expect(linksTo(wrapper, "/config")).toBe(2);
    expect(wrapper.text()).toContain("Settings");
  });

  it("still lights the attention dots on the tabs that remain", async () => {
    await setTabVisible("map", false);
    const wrapper = await mountApp();

    // Hiding one tab must not disturb the badges of the others: the composables
    // behind them run app-wide, independently of what the nav shows.
    fileShare.state.value = "incoming";
    vox.phase.value = "incoming";
    invites.incoming.value = true;
    meetings.attentionCount.value = 2;
    await flushPromises();

    for (const path of ["/files", "/vox", "/calendar", "/contacts"]) {
      const dots = wrapper.findAll(`a[href="${path}"] span.animate-pulse`);
      expect(dots.length, path).toBeGreaterThan(0);
    }
  });

  it("hides a tab whose feature the BUILD lacks, with no way to bring it back", async () => {
    await initBuildConfig({ calls_enabled: false });
    try {
      await loadTabVisibility();
      const wrapper = await mountApp();
      expect(linksTo(wrapper, "/vox")).toBe(0);
    } finally {
      await initBuildConfig({ calls_enabled: true });
    }
  });
});

describe("the Settings checkboxes", () => {
  async function mountSettings() {
    const wrapper = mount(EnigmaConfigView, {
      props: { darkMode: true },
      global: { plugins: [i18n, pinia, router] },
    });
    await flushPromises();
    return wrapper;
  }

  const box = (wrapper: any, id: string) => wrapper.find(`input[data-testid="tab-visible-${id}"]`);

  it("offers one ticked box per tab this build contains", async () => {
    const wrapper = await mountSettings();
    for (const id of ["chat", "files", "vox", "calendar", "map", "contacts"]) {
      expect(box(wrapper, id).exists(), id).toBe(true);
      expect((box(wrapper, id).element as HTMLInputElement).checked, id).toBe(true);
    }
  });

  it("has NO checkbox for Settings itself — it is the only way back here", async () => {
    const wrapper = await mountSettings();
    expect(box(wrapper, "config").exists()).toBe(false);
    expect(box(wrapper, "settings").exists()).toBe(false);
    expect(wrapper.findAll('input[data-testid^="tab-visible-"]').length).toBe(APP_TABS.length);
  });

  it("unticking one hides the tab and writes the choice through", async () => {
    const wrapper = await mountSettings();
    await box(wrapper, "map").trigger("change");
    await flushPromises();

    expect((box(wrapper, "map").element as HTMLInputElement).checked).toBe(false);
    // Same source the nav reads, so the two can never disagree.
    const nav = await mountApp();
    expect(linksTo(nav, "/map")).toBe(0);

    // And it is the persisted state, not just this session's.
    await loadTabVisibility();
    expect((await mountSettings()).find('input[data-testid="tab-visible-map"]').element).toHaveProperty("checked", false);
  });

  it("offers no checkbox for a tab the build does not contain", async () => {
    await initBuildConfig({ calls_enabled: false });
    try {
      const wrapper = await mountSettings();
      expect(box(wrapper, "vox").exists()).toBe(false);
      expect(wrapper.findAll('input[data-testid^="tab-visible-"]').length).toBe(APP_TABS.length - 1);
      // A stored "hidden" from a Vox-capable build stays untouched underneath.
      await setHiddenTabs(["vox"]);
      await loadTabVisibility();
      expect((await mountSettings()).findAll('input[data-testid^="tab-visible-"]').length).toBe(APP_TABS.length - 1);
    } finally {
      await initBuildConfig({ calls_enabled: true });
    }
  });
});
