// Tor is always on and file transfer rides the room's onions, so Tor gates
// nothing. The only switch that disables file transfer is airplane mode — and
// it does so visibly, not by hiding it.
//
// The backend fails networked commands with OFFLINE_BLOCKED; these tests pin
// the frontend half of the contract: the buttons stay rendered, become
// disabled, a reason is shown, and flipping the store re-enables them live —
// no remount.
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

function sendButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll("button").filter((b) => /send/i.test(b.text()))[0];
}

describe("file transfer over Tor", () => {
  it("is open by default: Send enabled, no reason line", async () => {
    const wrapper = mount(FilePanel, {
      global: { plugins: [i18n, pinia] },
    });
    await nextTick();

    expect(wrapper.text()).toContain("Ala");
    expect(isDisabled(sendButton(wrapper))).toBe(false);
    expect(wrapper.find("[data-testid=fileshare-blocked]").exists()).toBe(false);

    await sendButton(wrapper).trigger("click");
    expect(fileStub.offer).toHaveBeenCalledWith({ id: "peer-1", name: "Ala" });
  });
});

describe("file transfer in airplane mode", () => {
  beforeEach(() => fileStub.offer.mockClear());

  it("keeps the peer list visible but disables Send, with the reason", async () => {
    const wrapper = mount(FilePanel, {
      global: { plugins: [i18n, pinia] },
    });
    useNetworkStore().offline = true;
    await nextTick();

    expect(wrapper.text()).toContain("Ala"); // peer row still shown
    expect(isDisabled(sendButton(wrapper))).toBe(true);
    expect(wrapper.find("[data-testid=fileshare-blocked]").text()).toContain("airplane mode");
  });

  it("clicking the disabled Send offers nothing", async () => {
    const wrapper = mount(FilePanel, {
      global: { plugins: [i18n, pinia] },
    });
    useNetworkStore().offline = true;
    await nextTick();

    await sendButton(wrapper).trigger("click");
    expect(fileStub.offer).not.toHaveBeenCalled();
  });

  it("re-enables Send live when airplane mode goes off", async () => {
    const wrapper = mount(FilePanel, {
      global: { plugins: [i18n, pinia] },
    });
    const network = useNetworkStore();
    network.offline = true;
    await nextTick();
    expect(isDisabled(sendButton(wrapper))).toBe(true);

    network.offline = false;
    await nextTick();
    expect(isDisabled(sendButton(wrapper))).toBe(false);
    expect(wrapper.find("[data-testid=fileshare-blocked]").exists()).toBe(false);
  });
});

describe("the network store", () => {
  it("blocks file transfer only in airplane mode", () => {
    const network = useNetworkStore();
    expect(network.canFileTransfer).toBe(true);
    expect(network.blockedReasonKey).toBe("");

    network.offline = true;
    expect(network.canFileTransfer).toBe(false);
    expect(network.blockedReasonKey).toBe("network.blockedOffline");
  });

  it("has no Tor switch to flip", () => {
    const network = useNetworkStore() as unknown as Record<string, unknown>;
    expect(network.useTor).toBeUndefined();
    expect(network.setUseTor).toBeUndefined();
  });
});
