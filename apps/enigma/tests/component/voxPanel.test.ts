import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

// VoxPanel reads the chat store's `vox` controller + `p2p` channel. Stub the store
// so the component renders in isolation (no real iroh/chat wiring).
const voxStub = {
  available: ref(false),
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
vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    vox: voxStub,
    p2p: { participants: ref([]), mlsIdentity: ref("me") },
  }),
}));

import VoxPanel from "../../src/components/vox/VoxPanel.vue";
import { i18n } from "../../src/i18n";

// Force a known locale so the assertions are stable.
(i18n.global.locale as any).value = "en";

describe("VoxPanel", () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    voxStub.available.value = false;
    voxStub.phase.value = "idle";
  });

  it("shows the desktop-only notice when Vox is unavailable (browser)", () => {
    const wrapper = mount(VoxPanel, {
      props: { darkMode: true },
      global: { plugins: [i18n, pinia] },
    });
    expect(wrapper.text()).toContain("Voice calls are available");
  });

  it("shows the incoming-call prompt when a call is ringing", () => {
    voxStub.available.value = true;
    voxStub.phase.value = "incoming";
    voxStub.incomingName.value = "Bob";
    const wrapper = mount(VoxPanel, {
      props: { darkMode: true },
      global: { plugins: [i18n, pinia] },
    });
    expect(wrapper.text()).toContain("Bob is calling");
  });
});
