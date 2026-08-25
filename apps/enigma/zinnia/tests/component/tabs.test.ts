import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import App from "../../src/App.vue";
import { APP_TABS, DEFAULT_TAB, KIND_FILES } from "../../src/tabs";
import { i18n } from "../../src/i18n";

function mountApp() {
  return mount(App, {
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

describe("the tab bar", () => {
  it("shows every tab", () => {
    const w = mountApp();
    for (const tab of APP_TABS) {
      expect(w.find(`[data-testid="nav-${tab.id}"]`).exists(), tab.id).toBe(true);
    }
    expect(APP_TABS.map((t) => t.id))
      .toEqual(["document", "sketch", "sheet", "deck", "code", "security", "settings"]);
  });

  it("opens on the default tab and mounts nothing else yet", async () => {
    // Lazy on purpose: Univer alone is ~5 MB and mounts a React tree, so a tab
    // nobody opened should cost nothing.
    const w = mountApp();
    await flushPromises();
    expect(w.findComponent({ name: "DocumentEditor" }).exists()).toBe(true);
    expect(w.findComponent({ name: "SheetEditor" }).exists()).toBe(false);
    expect(w.findComponent({ name: "PresentationEditor" }).exists()).toBe(false);
    expect(w.findComponent({ name: "SettingsView" }).exists()).toBe(false);
    expect(DEFAULT_TAB).toBe("document");
  });

  it("mounts a tab the first time it is opened", async () => {
    const w = mountApp();
    await w.get('[data-testid="nav-sheet"]').trigger("click");
    await flushPromises();
    expect(w.findComponent({ name: "SheetEditor" }).exists()).toBe(true);
  });

  it("keeps a visited tab alive so its unsaved work survives a switch", async () => {
    // The whole reason these tabs do not route: switching away from a
    // half-written document must not throw it away.
    const w = mountApp();
    await flushPromises();
    const doc = w.findComponent({ name: "DocumentEditor" });
    expect(doc.exists()).toBe(true);
    // The internal uid, not `.vm`: findComponent hands back a fresh proxy each
    // call, so comparing the proxies compares wrappers, not instances.
    const uid = (doc.vm as unknown as { $: { uid: number } }).$.uid;

    await w.get('[data-testid="nav-sketch"]').trigger("click");
    await flushPromises();
    // Still mounted, just hidden.
    expect(w.findComponent({ name: "DocumentEditor" }).exists()).toBe(true);
    expect(w.findComponent({ name: "SketchEditor" }).exists()).toBe(true);

    await w.get('[data-testid="nav-document"]').trigger("click");
    await flushPromises();
    // The SAME component instance, not a fresh one.
    const again = w.findComponent({ name: "DocumentEditor" }).vm as unknown as
      { $: { uid: number } };
    expect(again.$.uid).toBe(uid);
  });

  it("settings holds no file, so it hosts no editor", async () => {
    const w = mountApp();
    await w.get('[data-testid="nav-settings"]').trigger("click");
    await flushPromises();
    const settings = w.findComponent({ name: "SettingsView" });
    expect(settings.exists()).toBe(true);
    expect(settings.find('[data-testid="file-save"]').exists()).toBe(false);
  });

  it("gives every tab a label in both locales", () => {
    // A missing key renders as the key itself, which looks like a bug in the UI
    // rather than a gap in a catalogue.
    for (const locale of ["en", "pl"] as const) {
      i18n.global.locale.value = locale;
      for (const tab of APP_TABS) {
        const label = i18n.global.t(tab.labelKey);
        expect(label, `${tab.labelKey} in ${locale}`).not.toBe(tab.labelKey);
      }
    }
    i18n.global.locale.value = "en";
  });
});

describe("the kind table", () => {
  it("covers every editor tab", () => {
    for (const tab of APP_TABS) {
      if (tab.kind) expect(KIND_FILES[tab.kind], tab.id).toBeTruthy();
    }
  });

  it("gives each kind an extension and a translated filter name", () => {
    for (const spec of Object.values(KIND_FILES)) {
      expect(spec.extensions.length).toBeGreaterThan(0);
      expect(i18n.global.t(spec.filterKey)).not.toBe(spec.filterKey);
      expect(i18n.global.t(spec.untitledKey)).not.toBe(spec.untitledKey);
    }
  });
});
