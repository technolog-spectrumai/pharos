import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { setHiddenTabs } from "rakotis";

const ALL = ["chat", "files", "vox", "calendar", "map", "contacts"] as const;

async function settle() {
  await nextTick();
  await flushPromises();
}

/** A cold app boot: fresh module registry, so tabs.ts starts with an empty
 *  hidden set and the router starts with no history — exactly what
 *  window.location.reload() does after a lock. */
async function coldBoot() {
  vi.resetModules();
  const tabs = await import("../../src/tabs");
  const router = (await import("../../src/router")).default;
  // From the SAME fresh registry: the build config lives in a module-level
  // variable, so the top-level `rakotis` import here is a different instance
  // and writing to it would never be seen by the tabs module under test.
  const store = await import("rakotis");
  return { tabs, router, store };
}

beforeEach(() => {
  localStorage.clear();
});

describe("cold boot with everything hidden", () => {
  it("lands on Settings, not on a blank hidden view", async () => {
    await setHiddenTabs([...ALL]);
    const { tabs, router } = await coldBoot();

    // The first navigation happens at mount, before the vault is unlocked.
    await router.replace("/");
    await router.isReady();
    // Then the vault opens and the choice is finally readable.
    await tabs.loadTabVisibility();
    await settle();

    expect(router.currentRoute.value.path).toBe("/config");
  });

  it("kicks the app off the tab it booted into once the choice loads", async () => {
    await setHiddenTabs([...ALL]);
    const { tabs, router } = await coldBoot();
    await router.replace("/chat");
    await router.isReady();
    expect(router.currentRoute.value.path).toBe("/chat");

    await tabs.loadTabVisibility();
    await settle();
    expect(router.currentRoute.value.path).toBe("/config");
  });

  it("kicks it off a hidden tab even when other tabs remain", async () => {
    await setHiddenTabs(["chat", "files"]);
    const { tabs, router } = await coldBoot();
    await router.replace("/chat");
    await router.isReady();

    await tabs.loadTabVisibility();
    await settle();
    expect(router.currentRoute.value.path).toBe("/vox");
  });
});

describe("no redirect loop", () => {
  it("survives a build gate that turns off after the choice was read", async () => {
    // The guard's fallback must be computed from the CURRENT build gates, not
    // from a cached list: a stale head sends the guard back to a path the guard
    // itself denies, which vue-router reports as an infinite redirection.
    await setHiddenTabs(["chat", "files"]);
    const { tabs, router, store } = await coldBoot();
    await tabs.loadTabVisibility();
    await router.replace("/config");

    await store.initBuildConfig({
      calls_enabled: false, calendar_enabled: false,
      maps_enabled: false, contacts_enabled: false,
    });
    try {
      expect(tabs.firstVisiblePath()).toBe("/config");
      await router.push("/vox");
      await settle();
      expect(router.currentRoute.value.path).toBe("/config");
    } finally {
      await store.initBuildConfig({
        calls_enabled: true, calendar_enabled: true,
        maps_enabled: true, contacts_enabled: true,
      });
    }
  });

  it("never redirects a denied tab back to itself", async () => {
    const { tabs, router } = await coldBoot();
    await tabs.loadTabVisibility();
    for (const id of ALL) {
      await setHiddenTabs([id]);
      await tabs.loadTabVisibility();
      await settle();
      expect(tabs.firstVisiblePath(), id).not.toBe(`/${id === "vox" ? "vox" : id}`);
    }
  });
});

describe("Settings stays usable in every hidden state", () => {
  it("still offers a checkbox for every tab when all are hidden", async () => {
    await setHiddenTabs([...ALL]);
    const { tabs } = await coldBoot();
    await tabs.loadTabVisibility();
    expect(tabs.availableTabs().length).toBe(6);
    expect(tabs.visibleTabs.value.length).toBe(0);
    // and turning one back on works
    await tabs.setTabVisible("chat", true);
    expect(tabs.isTabVisible("chat")).toBe(true);
  });

  it("keeps /config and /profile resolving with everything hidden", async () => {
    await setHiddenTabs([...ALL]);
    const { tabs, router } = await coldBoot();
    await tabs.loadTabVisibility();
    for (const p of ["/config", "/profile", "/config?tab=profile"]) {
      await router.push(p);
      await settle();
      expect(router.currentRoute.value.path, p).toBe("/config");
    }
  });
});

describe("stored value abuse", () => {
  it("does not choke on a huge / duplicated hidden list", async () => {
    localStorage.setItem(
      "enigma:db:p2p:settings:default:hidden_tabs",
      JSON.stringify(["map", "map", "map", ...Array.from({ length: 500 }, (_, i) => `x${i}`)]),
    );
    const { tabs } = await coldBoot();
    await tabs.loadTabVisibility();
    expect(tabs.isTabVisible("map")).toBe(false);
    expect(tabs.isTabVisible("chat")).toBe(true);
  });

  it("treats a nested-array / object value as garbage, not as a hide-all", async () => {
    for (const junk of ['[["chat"]]', '[{"id":"chat"}]', "[[]]", '""', "[true]"]) {
      localStorage.setItem("enigma:db:p2p:settings:default:hidden_tabs", junk);
      const { tabs } = await coldBoot();
      await tabs.loadTabVisibility();
      expect(tabs.visibleTabs.value.length, junk).toBe(6);
    }
  });
});
