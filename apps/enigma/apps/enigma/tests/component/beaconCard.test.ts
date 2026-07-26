import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import BeaconCard from "../../src/components/map/BeaconCard.vue";
import { useBeaconStore } from "../../src/stores/beacon";
import { useCloudStore } from "../../src/stores/cloud";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

// The sidebar card for server (beacon) shares: honest logged-out state, the
// grouped active-share lists with expiry text, and owner-only delete buttons.

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  pinia = createPinia();
  setActivePinia(pinia);
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

const GLOBAL = () => ({ plugins: [i18n, pinia] });

const IN_SIX_HOURS = new Date(Date.now() + 6 * 3600_000).toISOString();
const CREATED = new Date(Date.now() - 60_000).toISOString();

function wirePin(id: number, user: string, comment = "") {
  return {
    id,
    user,
    geometry: { type: "Point", coordinates: [21.0122, 52.2297] },
    comment,
    expires_at: IN_SIX_HOURS,
    created_at: CREATED,
  };
}

function wireZone(id: number, user: string) {
  return {
    id,
    user,
    name: "camp",
    geometry: {
      type: "Polygon",
      coordinates: [[[21.0, 52.2], [21.1, 52.2], [21.1, 52.3], [21.0, 52.2]]],
    },
    comment: "",
    expires_at: IN_SIX_HOURS,
    created_at: CREATED,
  };
}

describe("BeaconCard", () => {
  it("shows the login hint when the cloud session is logged out", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_status") return { logged_in: false, username: null };
      return undefined;
    });
    const wrapper = mount(BeaconCard, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find('[data-testid="beacon-login-hint"]').exists()).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("beacon_all", expect.anything());
  });

  it("fetches on mount when logged in and renders grouped shares with expiry", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_status") return { logged_in: true, username: "alice" };
      if (cmd === "beacon_all") {
        return {
          pins: [wirePin(1, "alice", "market"), wirePin(2, "bob")],
          zones: [wireZone(7, "bob")],
          routes: [],
        };
      }
      if (cmd === "cloud_list") return { files: [], buckets: [] };
      return undefined;
    });
    const wrapper = mount(BeaconCard, { global: GLOBAL() });
    await flushPromises();
    expect(invokeMock).toHaveBeenCalledWith("beacon_all", expect.anything());
    const text = wrapper.text();
    expect(text).toContain("you"); // own pin labelled "you"
    expect(text).toContain("bob");
    expect(text).toContain("camp");
    expect(text).toContain("expires in 6 h");
    // bob's zone must not offer MY delete button.
    expect(wrapper.findAll('[title="Remove from server"]')).toHaveLength(0);
  });

  it("offers delete only for my own zones and emits focus on row click", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_status") return { logged_in: true, username: "bob" };
      if (cmd === "beacon_all") {
        return { pins: [wirePin(2, "bob")], zones: [wireZone(7, "bob")], routes: [] };
      }
      if (cmd === "cloud_list") return { files: [], buckets: [] };
      return undefined;
    });
    const wrapper = mount(BeaconCard, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.findAll('[title="Remove from server"]')).toHaveLength(1);
    await wrapper.find('[data-testid="beacon-card"] ul li button').trigger("click");
    expect(wrapper.emitted("focus-pin")).toHaveLength(1);
  });

  it("toggles the layer flag and refreshes on the refresh button", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_status") return { logged_in: true, username: "alice" };
      if (cmd === "beacon_all") return { pins: [], zones: [], routes: [] };
      if (cmd === "cloud_list") return { files: [], buckets: [] };
      return undefined;
    });
    const wrapper = mount(BeaconCard, { global: GLOBAL() });
    await flushPromises();
    const beacon = useBeaconStore();
    const cloud = useCloudStore();
    expect(cloud.loggedIn).toBe(true);
    expect(beacon.layerVisible).toBe(true);
    await wrapper.find('[data-testid="beacon-layer-toggle"]').trigger("click");
    expect(beacon.layerVisible).toBe(false);
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "beacon_all").length;
    await wrapper.find('[data-testid="beacon-refresh"]').trigger("click");
    await flushPromises();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "beacon_all").length).toBe(calls + 1);
  });
});
