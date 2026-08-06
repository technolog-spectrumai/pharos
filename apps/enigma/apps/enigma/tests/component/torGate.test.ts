// Tor mode disables what cannot work over Tor — visibly, not by hiding it.
//
// The backend already fails these commands (vox.rs / file_xfer.rs /
// device_link.rs / peer_link.rs all return TOR_BLOCKED); these tests pin the
// frontend half of the contract: the buttons stay rendered, become disabled,
// a reason is shown, and flipping the store re-enables them live — no remount.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";

const voxStub = {
  available: ref(true),
  phase: ref("idle"),
  ticket: ref(""),
  incomingName: ref(""),
  peerName: ref(""),
  muted: ref(false),
  error: ref(""),
  callSeconds: ref(0),
  spectrum: ref<number[]>([]),
  encryption: ref(""),
  nickResults: ref<{ node_id: string; name: string; ts: number }[]>([]),
  createCall: vi.fn(),
  joinByTicket: vi.fn(),
  callNode: vi.fn(),
  callByNick: vi.fn(),
  callPeer: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
  hangup: vi.fn(),
  restart: vi.fn(),
  toggleMute: vi.fn(),
};
const fileStub = {
  state: ref("idle"),
  direction: ref("send"),
  fileName: ref(""),
  fileSize: ref(0),
  peerName: ref(""),
  progress: ref(0),
  error: ref(""),
  offer: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
};
vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    vox: voxStub,
    fileShare: fileStub,
    p2p: {
      participants: ref([
        { id: "peer-1", name: "Ala" },
        { id: "me", name: "Me" },
      ]),
      mlsIdentity: ref("me"),
      currentRoom: ref("room"),
      isEncrypted: ref(true),
      currentUserName: ref("Me"),
    },
  }),
}));

import VoxPanel from "../../src/components/vox/VoxPanel.vue";
import FilePanel from "../../src/components/chat/FilePanel.vue";
import { useNetworkStore } from "../../src/stores/network";
import { i18n } from "../../src/i18n";

(i18n.global.locale as any).value = "en";

// FilePanel gates on __TAURI_INTERNALS__; pretend we are the desktop app.
beforeEach(() => {
  (window as any).__TAURI_INTERNALS__ = {};
});

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

function isDisabled(button: ReturnType<ReturnType<typeof mount>["find"]>): boolean {
  return (button.element as HTMLButtonElement).disabled;
}

describe("Vox in Tor mode", () => {
  it("shows every call button but disables the ones that would dial", async () => {
    const wrapper = mount(VoxPanel, {
      props: { darkMode: true },
      global: { plugins: [i18n, pinia] },
    });
    useNetworkStore().useTor = true;
    await nextTick();

    const buttons = wrapper.findAll("button").filter((b) => b.text().length > 0);
    expect(buttons.length).toBeGreaterThan(2); // still rendered, none hidden
    const callButtons = buttons.filter((b) => /call|join/i.test(b.text()));
    expect(callButtons.length).toBeGreaterThan(0);
    for (const b of callButtons) expect(isDisabled(b)).toBe(true);

    expect(wrapper.find("[data-testid=vox-blocked]").text()).toContain("Tor mode");
  });

  it("clicking a disabled call button starts nothing", async () => {
    const wrapper = mount(VoxPanel, {
      props: { darkMode: true },
      global: { plugins: [i18n, pinia] },
    });
    useNetworkStore().useTor = true;
    await nextTick();

    await wrapper.findAll("button").filter((b) => /start a call/i.test(b.text()))[0]
      .trigger("click");
    expect(voxStub.createCall).not.toHaveBeenCalled();
  });

  it("re-enables live when Tor mode is switched off — no remount", async () => {
    const wrapper = mount(VoxPanel, {
      props: { darkMode: true },
      global: { plugins: [i18n, pinia] },
    });
    const network = useNetworkStore();
    network.useTor = true;
    await nextTick();
    expect(wrapper.find("[data-testid=vox-blocked]").exists()).toBe(true);

    network.useTor = false;
    await nextTick();
    expect(wrapper.find("[data-testid=vox-blocked]").exists()).toBe(false);
    const start = wrapper.findAll("button").filter((b) => /start a call/i.test(b.text()))[0];
    expect(isDisabled(start)).toBe(false);
  });

  it("airplane mode disables the same buttons with its own reason", async () => {
    const wrapper = mount(VoxPanel, {
      props: { darkMode: true },
      global: { plugins: [i18n, pinia] },
    });
    useNetworkStore().offline = true;
    await nextTick();
    expect(wrapper.find("[data-testid=vox-blocked]").text()).toContain("airplane");
  });
});

describe("file transfer in Tor mode", () => {
  it("keeps the peer list visible but disables Send, with the reason", async () => {
    const wrapper = mount(FilePanel, {
      global: { plugins: [i18n, pinia] },
    });
    useNetworkStore().useTor = true;
    await nextTick();

    expect(wrapper.text()).toContain("Ala"); // peer row still shown
    const send = wrapper.findAll("button").filter((b) => /send/i.test(b.text()))[0];
    expect(isDisabled(send)).toBe(true);
    expect(wrapper.find("[data-testid=fileshare-blocked]").text()).toContain("Tor mode");
  });

  it("clicking the disabled Send offers nothing", async () => {
    const wrapper = mount(FilePanel, {
      global: { plugins: [i18n, pinia] },
    });
    useNetworkStore().useTor = true;
    await nextTick();

    await wrapper.findAll("button").filter((b) => /send/i.test(b.text()))[0]
      .trigger("click");
    expect(fileStub.offer).not.toHaveBeenCalled();
  });
});

describe("the network store", () => {
  it("blocks all four iroh capabilities in Tor mode, none otherwise", () => {
    const network = useNetworkStore();
    expect(network.canCall).toBe(true);
    expect(network.canFileTransfer).toBe(true);
    expect(network.canDeviceSync).toBe(true);
    expect(network.canPeerSync).toBe(true);

    network.useTor = true;
    expect(network.canCall).toBe(false);
    expect(network.canFileTransfer).toBe(false);
    expect(network.canDeviceSync).toBe(false);
    expect(network.canPeerSync).toBe(false);
    expect(network.blockedReasonKey).toBe("network.blockedTor");
  });

  it("offline wins the reason line over Tor (both blocked anyway)", () => {
    const network = useNetworkStore();
    network.useTor = true;
    network.offline = true;
    expect(network.blockedReasonKey).toBe("network.blockedOffline");
  });
});
