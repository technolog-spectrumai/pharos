import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";

// The Cloud tab shell (cloud.md): three sub-tabs, but with the master switch
// off Connection is the only one — it explains what Cloud is and points at
// Settings → Connections, where the switch itself lives. The ?tab= query picks
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
    RouterLink: true,
    CloudPanel: true,
    CloudInvitesPanel: true,
    CloudSetupCard: true,
  },
});

describe("EnigmaCloudView", () => {
  it("switch off: Connection is the only sub-tab, explaining and pointing at Settings", async () => {
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-tab-connection"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-off-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-settings-link"]').exists()).toBe(true);
    // Files/Invites would be dead ends; the switch itself is not here.
    expect(wrapper.find('[data-testid="cloud-tab-files"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="cloud-tab-invites"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="cloud-knob"]').exists()).toBe(false);
    expect(wrapper.find("cloud-setup-card-stub").exists()).toBe(false);
  });

  it("switch on: all three pills, Connection hosts the setup card", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-tab-files"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-tab-invites"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-tab-connection"]').exists()).toBe(true);
    // Signed out ⇒ land on Connection, where the login lives.
    expect(wrapper.find("cloud-setup-card-stub").exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-off-card"]').exists()).toBe(false);
    await wrapper.find('[data-testid="cloud-tab-files"]').trigger("click");
    expect(wrapper.find("cloud-panel-stub").exists()).toBe(true);
    expect(wrapper.find("cloud-setup-card-stub").exists()).toBe(false);
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

describe("EnigmaCloudView — server capabilities", () => {
  // A server without `toto.aster` (zenobia, and any vault-only toto host) has no
  // invite mailbox and no setting that would create one, so the pill is hidden
  // rather than disabled (cloud.md D8). Capabilities are optimistic until
  // learned, so an unpatched server keeps behaving exactly as before.
  const VAULT_ONLY = { vault: true, aster: false, beacon: false };

  it("shows the Invites pill while capabilities are unknown", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    expect(cloud.caps).toBeNull();
    expect(wrapper.find('[data-testid="cloud-tab-invites"]').exists()).toBe(true);
  });

  it("hides the Invites pill once the server says it has no aster", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    cloud.caps = VAULT_ONLY;
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-tab-invites"]').exists()).toBe(false);
    // Files and Connection remain — only the dead end went.
    expect(wrapper.find('[data-testid="cloud-tab-files"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cloud-tab-connection"]').exists()).toBe(true);
  });

  it("a pinned Invites selection falls back instead of rendering a pill-less panel", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    routeQuery.tab = "invites";
    const wrapper = mount(EnigmaCloudView, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find("cloud-invites-panel-stub").exists()).toBe(true);
    // The server turns out to have no invite mailbox: the pinned selection must
    // not survive, or the panel renders with no pill highlighted.
    cloud.caps = VAULT_ONLY;
    await flushPromises();
    expect(wrapper.find('[data-testid="cloud-tab-invites"]').exists()).toBe(false);
    expect(wrapper.find("cloud-invites-panel-stub").exists()).toBe(false);
    expect(wrapper.find("cloud-panel-stub").exists()).toBe(true);
  });
});
