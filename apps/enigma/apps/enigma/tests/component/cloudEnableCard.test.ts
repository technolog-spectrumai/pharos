import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";

// The Cloud master switch as mounted in Settings → Connections (cloud.md
// D2/D4). The contract under test is the conscious enable: the kv flag is
// written only after the danger-confirm press, while turning it off is instant.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import CloudEnableCard from "../../src/components/cloud/CloudEnableCard.vue";
import { useCloudStore } from "../../src/stores/cloud";
import { getCloudEnabled } from "rakotis";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  pinia = createPinia();
  setActivePinia(pinia);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const GLOBAL = () => ({ plugins: [i18n, pinia], stubs: { teleport: true } });

describe("CloudEnableCard", () => {
  it("starts off and explains the metadata price before anything is enabled", async () => {
    const wrapper = mount(CloudEnableCard, { global: GLOBAL() });
    await flushPromises();
    const knob = wrapper.find('[data-testid="cloud-knob"]');
    expect(knob.exists()).toBe(true);
    expect(knob.attributes("aria-checked")).toBe("false");
    expect(wrapper.text()).toContain("file names and sizes");
  });

  it("clicking the knob opens the confirm WITHOUT writing the kv flag", async () => {
    const wrapper = mount(CloudEnableCard, { global: GLOBAL() });
    await wrapper.find('[data-testid="cloud-knob"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-enable-confirm"]').exists()).toBe(true);
    expect(await getCloudEnabled()).toBe(false);
    expect(useCloudStore().enabled).toBe(false);
  });

  it("confirming writes the flag and flips the switch", async () => {
    const wrapper = mount(CloudEnableCard, { global: GLOBAL() });
    await wrapper.find('[data-testid="cloud-knob"]').trigger("click");
    await wrapper.find('[data-testid="cloud-enable-confirm"]').trigger("click");
    await flushPromises();
    expect(await getCloudEnabled()).toBe(true);
    expect(useCloudStore().enabled).toBe(true);
    expect(wrapper.find('[data-testid="cloud-knob"]').attributes("aria-checked")).toBe("true");
  });

  it("turning it off is instant — no confirm", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    const wrapper = mount(CloudEnableCard, { global: GLOBAL() });
    await flushPromises();
    await wrapper.find('[data-testid="cloud-knob"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-enable-confirm"]').exists()).toBe(false);
    expect(await getCloudEnabled()).toBe(false);
    expect(cloud.enabled).toBe(false);
  });

  it("a failed flip surfaces inline instead of escalating to the fatal overlay", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_set_enabled") throw "vault is locked";
      if (cmd === "cloud_status")
        return { logged_in: false, username: null, enabled: false, force_tor: false, transport: "loopback" };
      return undefined;
    });
    const wrapper = mount(CloudEnableCard, { global: GLOBAL() });
    await wrapper.find('[data-testid="cloud-knob"]').trigger("click");
    await wrapper.find('[data-testid="cloud-enable-confirm"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-knob-error"]').text()).toContain("vault is locked");
    expect(useCloudStore().enabled).toBe(false);
  });
});
