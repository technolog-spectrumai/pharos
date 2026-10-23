import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { ChatChannel } from "rakotis";
import { i18n } from "../../src/i18n";
import CreateRoomModal from "../../src/components/chat/CreateRoomModal.vue";
import { useP2pRooms } from "../../src/components/chat/useP2pRooms";

(i18n.global.locale as any).value = "en";

describe("probe", () => {
  it("shows the name form on first open", async () => {
    const ch = {
      error: ref(null), isEncrypted: ref(false), mlsIdentity: ref("me"), currentUserName: ref("me"),
      p2pRooms: ref([]), createRoom: vi.fn(async () => null), cancelJoin: vi.fn(), deleteRoom: vi.fn(),
    };
    const ctrl = useP2pRooms(ch as unknown as ChatChannel);
    const w = mount(CreateRoomModal, { props: { open: true, controller: ctrl }, global: { plugins: [i18n], stubs: { teleport: true, RoomShareCard: true } } });
    await flushPromises();
    console.log(w.html());
  });
});
