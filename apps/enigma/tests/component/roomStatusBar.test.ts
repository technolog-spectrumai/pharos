// The room's status strip and the phone drawer: join / leave, the encryption
// and connection chips, and the reset-encryption control.
//
// Two things are pinned beyond "the button calls the channel". A reset earns the
// room.rekey Privacy HP recovery, and only AFTER the keys were actually
// renegotiated — crediting first would pay for a reset that then failed. And
// join/leave go inert while their call is in flight and come back even when it
// throws, so a failed leave never leaves a dead button behind.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { ChatChannel } from "rakotis";
import "@tauri-apps/api/core";
import { i18n } from "../../src/i18n";
import RoomStatusBar from "../../src/components/chat/RoomStatusBar.vue";
import MobileRoomsDrawer from "../../src/components/chat/MobileRoomsDrawer.vue";
import RoomsSidebar from "../../src/components/chat/RoomsSidebar.vue";
import ParticipantsPanel from "../../src/components/chat/ParticipantsPanel.vue";
import { stopHp } from "../../src/components/hp/useHp";
import type { P2pRoomsController } from "../../src/components/chat/useP2pRooms";

(i18n.global.locale as any).value = "en";

const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "hp_ledger") return [];
  if (cmd === "hp_recover") return { applied: 150, code: args?.recoveryId };
  return null;
});

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

function mountBar(ch: Channel = makeChannel(), compact = false) {
  const w = mount(RoomStatusBar, { props: { channel: ch as unknown as ChatChannel, compact }, global: GLOBAL() });
  return { w, ch };
}

const byText = (w: ReturnType<typeof mount>, text: string) => {
  const b = w.findAll("button").find((x) => x.text().includes(text));
  expect(b, `button "${text}"`).toBeDefined();
  return b!;
};
const resetButton = (w: ReturnType<typeof mount>) =>
  w.get('button[aria-label="Reset encryption session — clears history and renegotiates keys"]');

async function settle() {
  for (let i = 0; i < 10; i++) await flushPromises();
}

beforeEach(() => {
  handled = [];
  invokeMock.mockClear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
  stopHp();
});

// ── status bar ──────────────────────────────────────────────────────────────

describe("RoomStatusBar — an observer", () => {
  it("offers only Join, with no chips and no reset", () => {
    const ch = makeChannel();
    ch.isParticipant.value = false;
    const { w } = mountBar(ch);
    expect(w.text()).toContain("Join");
    expect(w.text()).not.toContain("Encrypted");
    expect(w.find('button[aria-label^="Reset encryption"]').exists()).toBe(false);
  });

  it("joins, going inert until the join settles", async () => {
    const ch = makeChannel();
    ch.isParticipant.value = false;
    const pending = deferred();
    ch.joinParticipant.mockReturnValue(pending.promise);
    const { w } = mountBar(ch);

    await byText(w, "Join").trigger("click");
    expect(ch.joinParticipant).toHaveBeenCalledTimes(1);
    expect(byText(w, "Join").classes()).toContain("pointer-events-none");

    pending.resolve();
    await flushPromises();
    expect(byText(w, "Join").classes()).not.toContain("pointer-events-none");
  });

  it("comes back usable after a join that fails", async () => {
    const ch = makeChannel();
    ch.isParticipant.value = false;
    ch.joinParticipant.mockRejectedValue(new Error("no peers"));
    const { w } = mountBar(ch);
    await byText(w, "Join").trigger("click");
    await flushPromises();
    expect((handled[0] as Error).message).toBe("no peers");
    expect(byText(w, "Join").classes()).not.toContain("pointer-events-none");
  });
});

describe("RoomStatusBar — a participant", () => {
  it("shows the encryption and connection state", () => {
    const { w } = mountBar();
    expect(w.text()).toContain("Encrypted");
    expect(w.text()).toContain("Connected");
  });

  it("follows the live MLS and transport state", async () => {
    const { w, ch } = mountBar();
    ch.mlsStatus.value = "error";
    ch.wsStatus.value = "connecting";
    await flushPromises();
    expect(w.text()).toContain("Enc. error");
    expect(w.text()).toContain("Connecting…");
  });

  it("draws the eye to Reset while keys are stuck or broken, and not otherwise", async () => {
    // The reset is the way out of a failed key exchange, so it is highlighted
    // exactly then; on a healthy session it stays quiet.
    const { w, ch } = mountBar();
    expect(resetButton(w).classes()).not.toContain("text-highlight");
    ch.mlsStatus.value = "key_exchange";
    await flushPromises();
    expect(resetButton(w).classes()).toContain("text-highlight");
    ch.mlsStatus.value = "error";
    await flushPromises();
    expect(resetButton(w).classes()).toContain("text-highlight");
  });

  it("resets the session and only then claims the rekey recovery", async () => {
    const { w, ch } = mountBar();
    await resetButton(w).trigger("click");
    await settle();

    expect(ch.forceResetMls).toHaveBeenCalledTimes(1);
    const recover = invokeMock.mock.calls.filter((c) => c[0] === "hp_recover");
    expect(recover.map((c) => c[1])).toEqual([{ recoveryId: "room.rekey" }]);
    const recoverOrder = invokeMock.mock.invocationCallOrder[invokeMock.mock.calls.findIndex((c) => c[0] === "hp_recover")];
    expect(ch.forceResetMls.mock.invocationCallOrder[0]).toBeLessThan(recoverOrder);
  });

  it("claims nothing when the reset itself fails", async () => {
    const ch = makeChannel();
    ch.forceResetMls.mockRejectedValue(new Error("MLS busy"));
    const { w } = mountBar(ch);
    await resetButton(w).trigger("click");
    await settle();
    expect((handled[0] as Error).message).toBe("MLS busy");
    expect(invokeMock.mock.calls.some((c) => c[0] === "hp_recover")).toBe(false);
  });

  it("leaves from the full-size button", async () => {
    const { w, ch } = mountBar();
    const leave = byText(w, "Leave");
    // The full bar uses the secondary button with its icon.
    expect(leave.find('font-awesome-icon-stub[icon="right-from-bracket"]').exists()).toBe(true);
    await leave.trigger("click");
    expect(ch.leaveParticipant).toHaveBeenCalledTimes(1);
  });

  it("leaves from the compact text link on a phone, inert while in flight", async () => {
    const ch = makeChannel();
    const pending = deferred();
    ch.leaveParticipant.mockReturnValue(pending.promise);
    const { w } = mountBar(ch, true);
    const leave = byText(w, "Leave");
    expect(leave.classes()).toContain("underline");
    await leave.trigger("click");
    expect(ch.leaveParticipant).toHaveBeenCalledTimes(1);
    expect(byText(w, "Leave").classes()).toContain("pointer-events-none");
    pending.reject(new Error("socket closed"));
    await flushPromises();
    expect(byText(w, "Leave").classes()).not.toContain("pointer-events-none");
  });
});

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
