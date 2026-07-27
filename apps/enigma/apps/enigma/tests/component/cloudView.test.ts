import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";

// The Cloud tab shell (cloud.md): the knob card always renders; with the
// master switch off NOTHING else does; turning it on demands the danger
// confirm modal (no kv write before the confirm press); the ?tab= query picks
// the sub-tab, Notes-style.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const routeQuery: { tab?: string } = {};
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return {
    ...actual,
    useRoute: () => ({ query: routeQuery }),
    useRouter: () => ({ push: vi.fn() }),
  };
});

import EnigmaCloudView from "../../src/views/EnigmaCloudView.vue";
import { useCloudStore } from "../../src/stores/cloud";
import { getCloudEnabled } from "rakotis";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  delete routeQuery.tab;
  pinia = createPinia();
  setActivePinia(pinia);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

// The heavy workspaces are their own components — this test owns the shell.
const GLOBAL = () => ({
  plugins: [i18n, pinia],
  stubs: {
    teleport: true,
    CloudPanel: true,
    CloudInvitesPanel: true,
    CloudSetupCard: true,
  },
});

describe("EnigmaCloudView", () => {
  it("knob off: Connection is the only sub-tab, holding the switch + explanation", async () => {
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-tab-connection"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-knob"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-off-card"]').exists()).toBe(true);
    // Files/Invites would be dead ends without a session — no pills, no setup.
    expect(wrapper.find('[data-testid="cloud-tab-files"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="cloud-tab-invites"]').exists()).toBe(false);
    expect(wrapper.find("cloud-setup-card-stub").exists()).toBe(false);
  });

  it("clicking the knob opens the confirm modal WITHOUT writing the kv flag", async () => {
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    await wrapper.find('[data-testid="cloud-knob"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-enable-confirm"]').exists()).toBe(true);
    // Conscious enable: nothing persisted until the modal is confirmed.
    expect(await getCloudEnabled()).toBe(false);
    const cloud = useCloudStore();
    expect(cloud.enabled).toBe(false);
  });

  it("confirming the modal enables the switch and reveals the workspaces", async () => {
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    await wrapper.find('[data-testid="cloud-knob"]').trigger("click");
    await wrapper.find('[data-testid="cloud-enable-confirm"]').trigger("click");
    await flushPromises();
    expect(await getCloudEnabled()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-off-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="cloud-tab-files"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-tab-invites"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-tab-connection"]').exists()).toBe(true);
    // Signed out: land on Connection, the only sub-tab that can get a session.
    expect(wrapper.find("cloud-setup-card-stub").exists()).toBe(true);
    expect(wrapper.find("cloud-panel-stub").exists()).toBe(false);
  });

  it("Connection sub-tab keeps the knob beside the setup card; Files is one click away", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find("cloud-setup-card-stub").exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-knob"]').exists()).toBe(true);
    await wrapper.find('[data-testid="cloud-tab-files"]').trigger("click");
    expect(wrapper.find("cloud-panel-stub").exists()).toBe(true);
    expect(wrapper.find("cloud-setup-card-stub").exists()).toBe(false);
    // The knob lives in Connection only — it is not a permanent header control.
    expect(wrapper.find('[data-testid="cloud-knob"]').exists()).toBe(false);
  });

  it("turning the knob off is instant (no modal) and hides the workspaces again", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-tab-files"]').exists()).toBe(true);
    await wrapper.find('[data-testid="cloud-knob"]').trigger("click");
    await flushPromises();
    expect(await getCloudEnabled()).toBe(false);
    expect(wrapper.find('[data-testid="cloud-off-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-tab-files"]').exists()).toBe(false);
  });

  it("a Files selection falls back to Connection when the switch goes off", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    await wrapper.find('[data-testid="cloud-tab-files"]').trigger("click");
    expect(wrapper.find("cloud-panel-stub").exists()).toBe(true);
    await cloud.setEnabled(false);
    await flushPromises();
    expect(wrapper.find("cloud-panel-stub").exists()).toBe(false);
    expect(wrapper.find('[data-testid="cloud-off-card"]').exists()).toBe(true);
  });

  it("?tab=invites selects the Invites pill", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    routeQuery.tab = "invites";
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-tab-invites"]').classes().join(" ")).toContain("bg-accent");
    expect(wrapper.find("cloud-invites-panel-stub").exists()).toBe(true);
    expect(wrapper.find("cloud-panel-stub").exists()).toBe(false);
  });
});
