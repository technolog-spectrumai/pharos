// The one menu (☰): rooms and the app's pages in one drawer, which takes you to
// the chat when you open a room or a room dialog from another page.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { createRouter, createMemoryHistory } from "vue-router";

const currentRoom = ref<{ slug: string; name: string } | null>(null);
const createOpen = ref(false);
const chat = {
  p2p: { currentRoom, participants: ref([{ name: "Me" }]), p2pRooms: ref([]), openP2pRoom: vi.fn() },
  fileShare: { state: ref("idle") },
  rooms: {
    createOpen, joinOpen: ref(false), infoOpen: ref(false), deleteOpen: ref(false),
    openCreate: vi.fn(() => (createOpen.value = true)), openJoin: vi.fn(), openInfo: vi.fn(), openDeleteConfirm: vi.fn(),
  },
};
vi.mock("../../src/stores/chat", () => ({ useChatStore: () => chat }));

import { i18n } from "../../src/i18n";
import AppDrawer from "../../src/components/AppDrawer.vue";
import { drawerOpen } from "../../src/stores/ui";

(i18n.global.locale as any).value = "en";

async function mountIt(at = "/friends") {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:any(.*)*", component: { render: () => null } }] });
  await router.push(at);
  const w = mount(AppDrawer, {
    props: { darkMode: true },
    global: { plugins: [i18n, router], stubs: { "font-awesome-icon": true, SavedRoomsList: true } },
  });
  return { w, router };
}

beforeEach(() => {
  drawerOpen.value = false;
  createOpen.value = false;
  currentRoom.value = null;
});

describe("AppDrawer", () => {
  it("is empty until opened, then holds the rooms and the pages", async () => {
    const { w } = await mountIt();
    expect(w.find("[data-testid=app-drawer]").exists()).toBe(false);
    drawerOpen.value = true;
    await flushPromises();
    expect(w.text()).toContain("New chat");
    const nav = w.get("[data-testid=drawer-nav]").text();
    for (const page of ["Chat", "Files", "Friends", "Settings"]) expect(nav).toContain(page);
  });

  it("goes to the chat and closes when a room dialog is opened from another page", async () => {
    const { w, router } = await mountIt("/friends");
    drawerOpen.value = true;
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("New chat"))!.trigger("click");
    await flushPromises();
    expect(drawerOpen.value).toBe(false);
    expect(router.currentRoute.value.path).toBe("/chat");
  });

  it("closes on navigation", async () => {
    const { router } = await mountIt("/chat");
    drawerOpen.value = true;
    await router.push("/config");
    await flushPromises();
    expect(drawerOpen.value).toBe(false);
  });
});
