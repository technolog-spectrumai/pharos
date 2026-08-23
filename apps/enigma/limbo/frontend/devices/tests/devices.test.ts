import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import DevicesTab from "../../src/components/devices/DevicesTab.vue";
import FileSyncPanel from "../../src/components/devices/FileSyncPanel.vue";
import type { DeviceRegistry } from "rakotis";

// Parked linked-device UI in the jsdom shell: no Tauri runtime, so file sync
// shows its desktop-only banner. What we pin here is the pure UI: the device
// list with its this-device marker and online dots, unlink delegation, the
// parked-pairing empty state, and the file-list controls.
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
      devOnline: holder(false),
      onlineLeafIds: holder<string[]>([]),
      fileEntries: holder<Record<string, unknown>[]>([]),
      pendingPushOffers: holder<Record<string, unknown>[]>([]),
      acceptCalls: [] as string[],
      declineCalls: [] as string[],
      acceptPushOffer(offerId: string) {
        fakeSync.acceptCalls.push(offerId);
      },
      declinePushOffer(offerId: string) {
        fakeSync.declineCalls.push(offerId);
        return Promise.resolve();
      },
      refresh: async () => {},
      start: async () => {},
      onDevlinkFile: () => () => {},
      sendDevlinkFile: async () => {},
      upsertFileEntry: async () => true,
      tombstoneFileEntry: async () => {},
      recordFileCopy: async () => {},
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
  fakeSync.devOnline.value = false;
  fakeSync.onlineLeafIds.value = [];
  fakeSync.fileEntries.value = [];
  fakeSync.pendingPushOffers.value = [];
  fakeSync.acceptCalls.length = 0;
  fakeSync.declineCalls.length = 0;
  fakeSync.unlinkCalls.length = 0;
  pinia = createPinia();
  setActivePinia(pinia);
});

const GLOBAL = () => ({ plugins: [i18n, pinia], stubs: { teleport: true } });

function linkTwoDevices() {
  fakeSync.linked.value = true;
  fakeSync.registry.value = REGISTRY;
  fakeSync.link.value = { myDeviceId: "primary" };
}

describe("DevicesTab — the device list header", () => {
  it("shows the not-linked state and file controls", async () => {
    const wrapper = mount(DevicesTab, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find("[data-testid='devices-not-linked']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='devices-not-linked']").text()).toContain("parked");
    expect(wrapper.find("[data-testid='fsync-add']").exists()).toBe(true);
  });

  it("lists devices with this-device marker, online dots, and unlink on others", async () => {
    linkTwoDevices();
    fakeSync.onlineLeafIds.value = ["alice#dev-abcd2345"];
    const wrapper = mount(DevicesTab, { global: GLOBAL() });
    await flushPromises();

    expect(wrapper.text()).toContain("Desktop");
    expect(wrapper.text()).toContain("Phone");
    expect(wrapper.text()).toContain("this device");
    // The phone's leaf is in the room ⇒ its row reads as connected.
    expect(wrapper.text()).toContain("connected");

    const unlink = wrapper.find("[data-testid='devices-unlink-abcd2345']");
    expect(unlink.exists()).toBe(true);
    expect(wrapper.find("[data-testid='devices-unlink-primary']").exists()).toBe(false);
    await unlink.trigger("click");
    expect(fakeSync.unlinkCalls).toEqual(["abcd2345"]);
  });

  it("does not expose the parked Pairing sub-tab", async () => {
    const wrapper = mount(DevicesTab, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.findAll("button").some((b) => b.text() === "Pairing")).toBe(false);
    expect(wrapper.text()).not.toContain("Show pairing QR");
    expect(wrapper.text()).not.toContain("This is the new device");
  });
});

describe("FileSyncPanel", () => {
  it("explains itself when nothing is linked and shows the empty list", async () => {
    const wrapper = mount(FileSyncPanel, { global: GLOBAL() });
    await flushPromises();
    // Browser shell has no Tauri: the desktop-only reason wins.
    expect(wrapper.find("[data-testid='fsync-blocked']").text()).toContain("desktop or mobile app");
    expect(wrapper.text()).toContain("No files yet");
  });

  it("renders entries with select-all, and Push/Pull are disabled without a live peer", async () => {
    linkTwoDevices();
    fakeSync.fileEntries.value = [
      { id: "e1", name: "notes.txt", addedBy: "primary", addedAt: 1, updatedAt: 1, copies: {} },
      { id: "e2", name: "budget.ods", addedBy: "primary", addedAt: 1, updatedAt: 1, copies: {} },
    ];
    const wrapper = mount(FileSyncPanel, { global: GLOBAL() });
    await flushPromises();

    expect(wrapper.text()).toContain("notes.txt");
    expect(wrapper.text()).toContain("budget.ods");
    expect(wrapper.find("[data-testid='fsync-push']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-testid='fsync-pull']").attributes("disabled")).toBeDefined();

    // Select all ticks every row.
    await wrapper.find("[data-testid='fsync-select-all']").trigger("change");
    expect((wrapper.find("[data-testid='tree-check-e1']").element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.find("[data-testid='tree-check-e2']").element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.text()).toContain("(2/2)");

    // …and unticks them again.
    await wrapper.find("[data-testid='fsync-select-all']").trigger("change");
    expect(wrapper.text()).toContain("(0/2)");
  });

  it("toggles a single row", async () => {
    linkTwoDevices();
    fakeSync.fileEntries.value = [
      { id: "e1", name: "notes.txt", addedBy: "primary", addedAt: 1, updatedAt: 1, copies: {} },
    ];
    const wrapper = mount(FileSyncPanel, { global: GLOBAL() });
    await flushPromises();
    await wrapper.find("[data-testid='tree-check-e1']").trigger("change");
    expect(wrapper.text()).toContain("(1/1)");
  });

  it("renders a listed-but-absent file as a ghost row marked missing", async () => {
    linkTwoDevices();
    fakeSync.fileEntries.value = [
      { id: "e1", name: "notes.txt", addedBy: "primary", addedAt: 1, updatedAt: 1, copies: {} },
    ];
    const wrapper = mount(FileSyncPanel, { global: GLOBAL() });
    await flushPromises();
    const marker = wrapper.find("[data-testid='tree-marker-e1']");
    expect(marker.exists()).toBe(true);
    expect(marker.text()).toBe("not on this device");
  });

  it("shows each sibling as its own names-only bucket with markers relative to us", async () => {
    linkTwoDevices();
    fakeSync.fileEntries.value = [
      // The phone holds it, we do not → excess ("only here") in ITS bucket.
      {
        id: "e1", name: "theirs.txt", addedBy: "abcd2345", addedAt: 1, updatedAt: 1,
        copies: { abcd2345: { hash: "a".repeat(64), size: 5, updatedAt: 1 } },
      },
    ];
    const wrapper = mount(FileSyncPanel, { global: GLOBAL() });
    await flushPromises();

    const bucket = wrapper.find("[data-testid='fsync-tree-abcd2345']");
    expect(bucket.exists()).toBe(true);
    expect(bucket.text()).toContain("theirs.txt");
    expect(wrapper.find("[data-testid='tree-marker-abcd2345:e1']").text()).toBe("only here");
  });

  it("surfaces a pending push offer and routes Accept / Decline", async () => {
    linkTwoDevices();
    fakeSync.pendingPushOffers.value = [
      {
        offerId: "off-1",
        fromDeviceId: "abcd2345",
        fromLabel: "Phone",
        items: [{ entryId: "e1", offerId: "x", addr: "a", name: "cv.pdf", size: 1, hash: "a".repeat(64) }],
        receivedAt: 1,
      },
    ];
    const wrapper = mount(FileSyncPanel, { global: GLOBAL() });
    await flushPromises();

    const card = wrapper.find("[data-testid='fsync-offer']");
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain("Phone");
    expect(card.text()).toContain("cv.pdf");

    await wrapper.find("[data-testid='fsync-accept-off-1']").trigger("click");
    expect(fakeSync.acceptCalls).toEqual(["off-1"]);
    await wrapper.find("[data-testid='fsync-decline-off-1']").trigger("click");
    expect(fakeSync.declineCalls).toEqual(["off-1"]);
  });

  it("disables Push and explains when a selected file is hash-diverged", async () => {
    linkTwoDevices();
    fakeSync.devOnline.value = true;
    localStorage.setItem(
      "enigma:db:filesync:default:local",
      JSON.stringify({ e1: { path: "/enigma/a.txt", hash: "a".repeat(64), size: 5, verifiedAt: 1 } }),
    );
    fakeSync.fileEntries.value = [
      {
        id: "e1", name: "a.txt", addedBy: "primary", addedAt: 1, updatedAt: 1,
        copies: {
          primary: { hash: "a".repeat(64), size: 5, updatedAt: 1 },
          abcd2345: { hash: "b".repeat(64), size: 5, updatedAt: 2 },
        },
      },
    ];
    const wrapper = mount(FileSyncPanel, { global: GLOBAL() });
    await flushPromises();
    // No Tauri in jsdom: seed the scan the panel would otherwise fetch, so the
    // entry resolves against real on-disk presence instead of ghosting.
    const { useFileSyncStore } = await import("../../src/stores/fileSync");
    const store = useFileSyncStore();
    store.root = "/enigma";
    store.scanFiles = [{ dir: "", name: "a.txt", size: 5, mtimeMs: 1 }];
    await flushPromises();

    expect(wrapper.find("[data-testid='tree-marker-e1']").text()).toBe("differs");
    await wrapper.find("[data-testid='tree-check-e1']").trigger("change");
    expect(wrapper.find("[data-testid='fsync-pull-only']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='fsync-push']").attributes("disabled")).toBeDefined();
  });
});
