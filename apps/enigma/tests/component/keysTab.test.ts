import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import KeyringPanel from "../../src/components/local/KeyringPanel.vue";

// The Keys sub-tab rides the `keyring` build feature: a build without it has
// no pill and no dormant panel. What is
// pinned here is the panel's own jsdom-visible surface — the gate itself is a
// one-line `v-if` on the same const the Rust side enforces with
// KEYRING_DISABLED, and EnigmaFilesView is not mounted by any test in this
// repo (the dhtGate precedent).

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
});

const GLOBAL = () => ({ plugins: [i18n, pinia], stubs: { teleport: true } });

describe("KeyringPanel", () => {
  it("shows the desktop-only banner in the browser and no create form", async () => {
    const wrapper = mount(KeyringPanel, { global: GLOBAL() });
    await flushPromises();
    // jsdom is not Tauri: the ring cannot exist here, only the banner.
    expect(wrapper.text()).toContain("Key ring");
    expect(wrapper.text()).toContain("needs the desktop or mobile app");
    expect(wrapper.find("[data-testid='keys-create']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='keys-lock']").exists()).toBe(false);
  });

  it("never renders a stored passphrase — the field starts empty", async () => {
    const wrapper = mount(KeyringPanel, { global: GLOBAL() });
    await flushPromises();
    for (const input of wrapper.findAll("input[type='password']")) {
      expect((input.element as HTMLInputElement).value).toBe("");
    }
  });
});
