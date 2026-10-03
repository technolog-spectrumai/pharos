import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { getHiddenTabs, initBuildConfig, setHiddenTabs } from "rakotis";
import router from "../../src/router";
import {
  APP_TABS,
  availableTabs,
  firstVisiblePath,
  isTabVisible,
  loadTabVisibility,
  setTabVisible,
  visibleTabs,
  type AppTabId,
} from "../../src/tabs";

// Per-user tab visibility: the user picks which tabs the app presents, on top of
// the build-feature gates. The two rules that must never break are that
// Settings stays reachable (it is the only route back to the checkboxes) and
// that a hidden tab is hidden EVERYWHERE — nav, router, and the "/" landing.
//
// The router is the real one (memory history, as in the app). Views are only
// resolved, never rendered, so no component is mounted here — the nav side is
// covered in tests/component/tabVisibility.test.ts.

/** The module state is a singleton; reload it from a cleared kv between cases. */
async function resetTabs(hidden: AppTabId[] = []) {
  localStorage.clear();
  await setHiddenTabs(hidden);
  await loadTabVisibility();
}

/** Let the router's visible-set watcher run (pre-flush) and its replace settle. */
async function settle() {
  await nextTick();
  await flushPromises();
}

beforeEach(async () => {
  await resetTabs();
  await router.replace("/config");
  await router.isReady();
});

describe("defaults", () => {
  it("shows every tab the build contains, in nav order", () => {
    expect(visibleTabs.value.map((t) => t.id)).toEqual([
      "chat", "files", "vox", "calendar", "contacts",
    ]);
    expect(availableTabs().map((t) => t.id)).toEqual(APP_TABS.map((t) => t.id));
  });

  it("stores nothing until the user changes something", async () => {
    await resetTabs();
    localStorage.clear();
    await loadTabVisibility();
    expect(await getHiddenTabs()).toEqual([]);
    expect(APP_TABS.every((t) => isTabVisible(t.id))).toBe(true);
  });

  it("never offers Settings as a hideable tab — it is the way back", () => {
    expect(APP_TABS.map((t) => t.path)).not.toContain("/config");
  });
});

describe("hiding a tab", () => {
  it("takes it out of the visible set and persists the choice", async () => {
    await setTabVisible("calendar", false);
    expect(isTabVisible("calendar")).toBe(false);
    expect(visibleTabs.value.map((t) => t.id)).not.toContain("calendar");
    expect(await getHiddenTabs()).toEqual(["calendar"]);

    // Survives the next unlock (the only time the choice is read).
    await loadTabVisibility();
    expect(isTabVisible("calendar")).toBe(false);
  });

  it("makes its route unreachable — a deep link redirects like a build gate", async () => {
    await setTabVisible("calendar", false);
    await router.push("/calendar");
    await settle();
    expect(router.currentRoute.value.path).toBe("/chat");
  });

  it("moves the user off it when they are looking at it", async () => {
    await router.push("/calendar");
    expect(router.currentRoute.value.path).toBe("/calendar");

    await setTabVisible("calendar", false);
    await settle();
    expect(router.currentRoute.value.path).toBe("/chat");
  });

  it("leaves a tab the user is NOT on alone", async () => {
    await router.push("/files");
    await setTabVisible("calendar", false);
    await settle();
    expect(router.currentRoute.value.path).toBe("/files");
  });

  it("turning it back on restores the tab and its route", async () => {
    await setTabVisible("calendar", false);
    await setTabVisible("calendar", true);
    await settle();
    expect(isTabVisible("calendar")).toBe(true);

    await router.push("/calendar");
    await settle();
    expect(router.currentRoute.value.path).toBe("/calendar");
  });
});

describe('the "/" landing', () => {
  it("goes to the first VISIBLE tab, not blindly to /chat", async () => {
    await router.replace("/");
    expect(router.currentRoute.value.path).toBe("/chat");

    // Chat is hideable too, so "/" cannot be a fixed string — the header logo
    // and both Back buttons come through here, as does every lock reload.
    await setTabVisible("chat", false);
    await settle();
    await router.replace("/");
    expect(router.currentRoute.value.path).toBe("/files");
  });

  it("falls through to Settings once every tab is hidden", async () => {
    for (const tab of availableTabs()) await setTabVisible(tab.id, false);
    await settle();
    expect(visibleTabs.value).toEqual([]);
    expect(firstVisiblePath()).toBe("/config");

    await router.replace("/");
    expect(router.currentRoute.value.path).toBe("/config");
  });

  it("keeps Settings reachable from a hidden tab's route, with no redirect loop", async () => {
    for (const tab of availableTabs()) await setTabVisible(tab.id, false);
    await settle();
    await router.push("/chat");
    await settle();
    expect(router.currentRoute.value.path).toBe("/config");
    // /profile is the other path into Settings — it must keep resolving.
    await router.push("/profile");
    await settle();
    expect(router.currentRoute.value.path).toBe("/config");
  });
});

// One JSON value under one kv key (kv has no key enumeration). A profile is
// long-lived and shared with other builds, so a value that is not what this
// version expects has to degrade to "show everything" rather than to a blank nav.
describe("the stored value", () => {
  const KV_KEY = "enigma:db:p2p:settings:default:hidden_tabs";

  it("is written as the HIDDEN list, so a tab added later defaults to visible", async () => {
    await resetTabs();
    await setTabVisible("files", false);
    expect(JSON.parse(localStorage.getItem(KV_KEY)!)).toEqual(["files"]);
  });

  it("falls back to everything visible when it is garbage", async () => {
    for (const junk of ["not json", '{"calendar":true}', "null", "17"]) {
      localStorage.clear();
      localStorage.setItem(KV_KEY, junk);
      await loadTabVisibility();
      expect(visibleTabs.value.length, junk).toBe(APP_TABS.length);
    }
  });

  it("ignores non-string entries but keeps ids it does not know", async () => {
    localStorage.clear();
    localStorage.setItem(KV_KEY, JSON.stringify(["calendar", 7, null, "sketch"]));
    await loadTabVisibility();
    expect(isTabVisible("calendar")).toBe(false);

    // "sketch" belongs to a newer build; hiding another tab must not silently
    // un-hide it when that build reopens the profile.
    await setTabVisible("files", false);
    expect(await getHiddenTabs()).toEqual(["calendar", "sketch", "files"]);
  });
});

// The build gate is the OUTER gate: a per-user "show" must never resurrect a tab
// whose feature was not compiled in (its composable is null, so the view would
// throw). setup.ts seeds a full build; this is the other case.
describe("a build without Vox", () => {
  beforeAll(async () => {
    await initBuildConfig({ calls_enabled: false });
  });
  afterAll(async () => {
    await initBuildConfig({ calls_enabled: true });
  });

  it("offers no checkbox for it — the user cannot enable what is not there", () => {
    expect(availableTabs().map((t) => t.id)).not.toContain("vox");
    expect(availableTabs().map((t) => t.id)).toEqual([
      "chat", "files", "calendar", "contacts",
    ]);
  });

  it("stays hidden and unreachable even with the profile's choice set to visible", async () => {
    await resetTabs();
    expect(isTabVisible("vox")).toBe(false);
    expect(visibleTabs.value.map((t) => t.id)).not.toContain("vox");

    await router.push("/vox");
    await settle();
    expect(router.currentRoute.value.path).toBe("/chat");
  });

  it("does not rewrite the stored choice, so a capable build restores it", async () => {
    // The user hid Vox on a build that had calls; this one, without, must not touch that
    // record (same rule as rakotis' getDhtDiscovery).
    await resetTabs(["vox"]);
    expect(await getHiddenTabs()).toEqual(["vox"]);

    await initBuildConfig({ calls_enabled: true });
    try {
      await loadTabVisibility();
      expect(isTabVisible("vox")).toBe(false);
      await setTabVisible("vox", true);
      expect(isTabVisible("vox")).toBe(true);
    } finally {
      await initBuildConfig({ calls_enabled: false });
    }
  });
});
