// The phone drawer: the rooms list and the roster of the same channel, and join /
// leave for the open room.
//
// Pinned beyond "the button calls the channel": join/leave go inert while their
// call is in flight and come back even when it throws, so a failed leave never
// leaves a dead button behind.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { ChatChannel } from "rakotis";
import { i18n } from "../../src/i18n";
import MobileRoomsDrawer from "../../src/components/chat/MobileRoomsDrawer.vue";
import RoomsSidebar from "../../src/components/chat/RoomsSidebar.vue";
import ParticipantsPanel from "../../src/components/chat/ParticipantsPanel.vue";
import type { P2pRoomsController } from "../../src/components/chat/useP2pRooms";

(i18n.global.locale as any).value = "en";
const tr = i18n.global.t as unknown as (key: string, params?: Record<string, unknown>, plural?: number) => string;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function makeChannel() {
  return {
    currentRoom: ref<{ slug: string; name: string } | null>({ slug: "room-1", name: "Room" }),
    isParticipant: ref(true),
    participants: ref([{ id: "a", name: "Ann" }, { id: "b", name: "Ben" }]),
    mlsStatus: ref("ready"),
    mlsError: ref<string | null>(null),
    wsStatus: ref("connected"),
    linkedOnions: ref<string[]>(["ann.onion", "ben.onion"]),
    isEncrypted: ref(true),
    forceResetMls: vi.fn(async () => {}),
    joinParticipant: vi.fn(async () => {}),
    leaveParticipant: vi.fn(async () => {}),
  };
}
type Channel = ReturnType<typeof makeChannel>;

// Join/leave rejections surface through Vue's error handler (the click handler
// is async); collecting them keeps the test in charge of what counts as failure.
let handled: unknown[] = [];
const GLOBAL = () => ({
  plugins: [i18n],
  config: { errorHandler: (e: unknown) => void handled.push(e) },
});

const byText = (w: ReturnType<typeof mount>, text: string) => {
  const b = w.findAll("button").find((x) => x.text().includes(text));
  expect(b, `button "${text}"`).toBeDefined();
  return b!;
};

async function settle() {
  for (let i = 0; i < 10; i++) await flushPromises();
}

beforeEach(() => {
  handled = [];
});

// ── status bar ──────────────────────────────────────────────────────────────



// ── connection chip ─────────────────────────────────────────────────────────


// ── mobile drawer ───────────────────────────────────────────────────────────

const controller = { openCreate: vi.fn(), openJoin: vi.fn() } as unknown as P2pRoomsController;

function mountDrawer(ch: Channel = makeChannel(), open = true) {
  const w = mount(MobileRoomsDrawer, {
    props: { open, channel: ch as unknown as ChatChannel, controller },
    global: { ...GLOBAL(), stubs: { RoomsSidebar: true, ParticipantsPanel: true } },
  });
  return { w, ch };
}

describe("MobileRoomsDrawer", () => {
  it("renders nothing while closed", () => {
    const { w } = mountDrawer(makeChannel(), false);
    expect(w.find("aside").exists()).toBe(false);
  });

  it("carries the rooms list and the roster of the same channel", () => {
    const { w, ch } = mountDrawer();
    expect(w.get("aside").text()).toContain("Rooms");
    expect(w.findComponent(RoomsSidebar).props()).toMatchObject({ channel: ch, controller });
    expect(w.findComponent(ParticipantsPanel).props()).toMatchObject({ channel: ch, compact: true });
    // The participant count reads the live roster.
    expect(w.text()).toContain("Participants");
    expect(w.text()).toMatch(/Participants\s*2/);
  });

  it("closes from the backdrop and from its close button", async () => {
    const { w } = mountDrawer();
    await w.get(".bg-black\\/40").trigger("click");
    await w.get('button[aria-label="Close rooms"]').trigger("click");
    expect(w.emitted("update:open")).toEqual([[false], [false]]);
  });

  it("offers no join or leave when no room is open", () => {
    const ch = makeChannel();
    ch.currentRoom.value = null;
    const { w } = mountDrawer(ch);
    expect(w.text()).not.toContain("Join Room");
    expect(w.text()).not.toContain("Leave Room");
  });

  it("lets an observer join the open room, inert while joining", async () => {
    const ch = makeChannel();
    ch.isParticipant.value = false;
    const pending = deferred();
    ch.joinParticipant.mockReturnValue(pending.promise);
    const { w } = mountDrawer(ch);
    await byText(w, "Join Room").trigger("click");
    expect(ch.joinParticipant).toHaveBeenCalledTimes(1);
    expect(byText(w, "Join Room").classes()).toContain("pointer-events-none");
    pending.resolve();
    await flushPromises();
    expect(byText(w, "Join Room").classes()).not.toContain("pointer-events-none");
  });

  it("lets a participant leave, and recovers from a leave that fails", async () => {
    const ch = makeChannel();
    ch.leaveParticipant.mockRejectedValue(new Error("gone"));
    const { w } = mountDrawer(ch);
    expect(w.text()).not.toContain("Join Room");
    await byText(w, "Leave Room").trigger("click");
    await flushPromises();
    expect(ch.leaveParticipant).toHaveBeenCalledTimes(1);
    expect((handled[0] as Error).message).toBe("gone");
    expect(byText(w, "Leave Room").classes()).not.toContain("pointer-events-none");
  });

  it("swaps Join for Leave once the join lands", async () => {
    const ch = makeChannel();
    ch.isParticipant.value = false;
    ch.joinParticipant.mockImplementation(async () => {
      ch.isParticipant.value = true;
    });
    const { w } = mountDrawer(ch);
    await byText(w, "Join Room").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Leave Room");
    expect(w.text()).not.toContain("Join Room");
  });
});
