// Tor mode disables what cannot work over Tor — visibly, not by hiding it.
//
// The backend already fails these commands (file_xfer.rs returns
// TOR_BLOCKED); these tests pin the
// frontend half of the contract: the buttons stay rendered, become disabled,
// a reason is shown, and flipping the store re-enables them live — no remount.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";

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
  it("blocks file transfer in Tor mode, nothing otherwise", () => {
    const network = useNetworkStore();
    expect(network.canFileTransfer).toBe(true);

    network.useTor = true;
    expect(network.canFileTransfer).toBe(false);
    expect(network.blockedReasonKey).toBe("network.blockedTor");
  });

  it("offline wins the reason line over Tor (both blocked anyway)", () => {
    const network = useNetworkStore();
    network.useTor = true;
    network.offline = true;
    expect(network.blockedReasonKey).toBe("network.blockedOffline");
  });
});
