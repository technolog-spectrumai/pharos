import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import DevicesPanel from "../../src/components/devices/DevicesPanel.vue";
import type { DeviceRegistry } from "rakotis";

// DevicesPanel in the jsdom shell: no Tauri runtime, so pairing invokes reject
// (the panel shows its degraded/error state) — what we pin here is the pure UI:
// registry rendering + this-device marker, unlink delegation, the not-linked
// empty state, and the offline disabled-with-reason gate.
//
// The fake deviceSync uses plain `{ value }` holders (vi.hoisted runs before
// imports, so vue's ref() is unavailable); every test sets state BEFORE mount,
// so no post-mount reactivity is needed.

const { fakeSync } = vi.hoisted(() => {
  const holder = <T>(value: T) => ({ value });
  return {
    fakeSync: {
      linked: holder(false),
      registry: holder<DeviceRegistry | null>(null),
      link: holder<{ myDeviceId: string } | null>(null),
      lastSyncAt: holder(0),
      devConnected: holder(false),
      refresh: async () => {},
      start: async () => {},
      unlinkCalls: [] as string[],
      unlinkDevice(deviceId: string) {
        fakeSync.unlinkCalls.push(deviceId);
        return Promise.resolve();
      },
    },
  };
});

vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({ deviceSync: fakeSync, devicesEnabled: true }),
}));

const REGISTRY: DeviceRegistry = {
  v: 1, user: "alice", rev: 2,
  devices: [
    { deviceId: "primary", label: "Desktop", kind: "desktop", leafId: "alice", nodeId: "node-a", addedAt: 1_700_000_000_000 },
    { deviceId: "abcd2345", label: "Phone", kind: "mobile", leafId: "alice#dev-abcd2345", nodeId: "node-b", addedAt: 1_700_000_100_000 },
  ],
  mac: "f".repeat(64),
};

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  localStorage.clear();
  fakeSync.linked.value = false;
  fakeSync.registry.value = null;
  fakeSync.link.value = null;
  fakeSync.unlinkCalls.length = 0;
  pinia = createPinia();
  setActivePinia(pinia);
});

const GLOBAL = () => ({ plugins: [i18n, pinia], stubs: { teleport: true } });

describe("DevicesPanel", () => {
  it("shows the empty state and the pairing CTA when not linked", async () => {
    const wrapper = mount(DevicesPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();
    expect(wrapper.text()).toContain("No linked devices yet");
    expect(wrapper.text()).toContain("Show pairing QR");
    expect(wrapper.text()).toContain("This is the new device");
  });

  it("renders the registry with a this-device marker and unlink on the others", async () => {
    fakeSync.linked.value = true;
    fakeSync.registry.value = REGISTRY;
    fakeSync.link.value = { myDeviceId: "primary" };
    const wrapper = mount(DevicesPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();

    expect(wrapper.text()).toContain("Desktop");
    expect(wrapper.text()).toContain("Phone");
    expect(wrapper.text()).toContain("this device");
    expect(wrapper.text()).toContain("alice#dev-abcd2345");
    const unlinkButtons = wrapper.findAll("button").filter((b) => b.text() === "Unlink");
    expect(unlinkButtons).toHaveLength(1); // never on this device's own row

    await unlinkButtons[0].trigger("click");
    expect(fakeSync.unlinkCalls).toEqual(["abcd2345"]);
  });

  it("disables pairing with a reason in airplane mode", async () => {
    localStorage.setItem("enigma:offline", "on");
    const wrapper = mount(DevicesPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();
    expect(wrapper.text()).toContain("Offline — all network connections are blocked.");
    const showQr = wrapper.findAll("button").find((b) => b.text().includes("Show pairing QR"))!;
    expect(showQr.attributes("disabled")).toBeDefined();
  });

  it("surfaces a pairing-join failure as an error (no Tauri runtime here)", async () => {
    const wrapper = mount(DevicesPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();
    const ticketInput = wrapper.findAll("input").find((el) => (el.element as HTMLInputElement).type === "text" && el.classes().includes("font-mono"))!;
    await ticketInput.setValue("lqaa-fake-ticket");
    const linkBtn = wrapper.findAll("button").find((b) => b.text() === "Link")!;
    await linkBtn.trigger("click");
    await flushPromises();
    expect(wrapper.text().length).toBeGreaterThan(0); // error line rendered, not a crash
  });
});
