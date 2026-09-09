import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import App from "../../src/App.vue";
import { APP_TABS } from "../../src/tabs";
import { i18n } from "../../src/i18n";
import { collabAvailable } from "../../src/collab/transport";

// The probe is what decides whether the Collab tab exists. Mocked at the
// module boundary, so the rest of the transport stays real.
vi.mock("../../src/collab/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/collab/transport")>()),
  collabAvailable: vi.fn(async () => false),
}));

function mountApp() {
  return mount(App, {
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  vi.mocked(collabAvailable).mockResolvedValue(false);
});

describe("the tab bar", () => {
  it("lists the tabs in this order", () => {
    // No `code`: the Code tab was removed. This app draws, and a general text
    // editor beside the canvas is what made the Files panel route sixteen
    // extensions into it. The editor itself survives as a viewer for images
    // and for a refused `.svg` — see EditorHost — but it has no tab.
    expect(APP_TABS.map((t) => t.id)).toEqual(["sketch", "collab", "security", "settings"]);
  });

  it("hides Collab when the build cannot collaborate", async () => {
    // A default build has no collab commands; a tab whose every button fails
    // is worse than no tab. Everything else is there.
    const w = mountApp();
    await flushPromises();
    for (const id of ["sketch", "security", "settings"]) {
      expect(w.find(`[data-testid="nav-${id}"]`).exists(), id).toBe(true);
    }
    expect(w.find('[data-testid="nav-collab"]').exists()).toBe(false);
  });

  it("shows Collab when the Rust side says it is there", async () => {
    vi.mocked(collabAvailable).mockResolvedValue(true);
    const w = mountApp();
    await flushPromises();
    expect(w.find('[data-testid="nav-collab"]').exists()).toBe(true);
    await w.get('[data-testid="nav-collab"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-testid="collab-panel"]').exists()).toBe(true);
    // A tab with no file: no files sidepanel, no editor host for it.
    expect(w.find('[data-testid="collab-share"]').exists()).toBe(true);
  });

  it("gives every tab a label in both locales", () => {
    for (const locale of ["en", "pl"] as const) {
      i18n.global.locale.value = locale;
      for (const tab of APP_TABS) {
        expect(i18n.global.t(tab.labelKey), `${tab.labelKey} in ${locale}`).not.toBe(tab.labelKey);
      }
    }
    i18n.global.locale.value = "en";
  });
});
