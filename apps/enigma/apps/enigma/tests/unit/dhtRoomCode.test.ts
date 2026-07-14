import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, nextTick } from "vue";
import type { ChatChannel } from "rakotis";

// The create-room modal shows the DHT room code (ticketless join) next to the
// QR when discovery is on. The controller doesn't get the code from createRoom's
// return value (that stays the ticket) — it reads it off the room entry the
// channel remembered. These tests pin that contract.

const { mockGetConnectTimeoutSecs } = vi.hoisted(() => ({
  mockGetConnectTimeoutSecs: vi.fn(async () => 5),
}));

vi.mock("rakotis", () => ({
  isTorTicket: () => false,
  getConnectTimeoutSecs: mockGetConnectTimeoutSecs,
}));

import { useP2pRooms } from "../../src/components/chat/useP2pRooms";

type RoomEntry = { room: string; name: string; ticket: string; code?: string };

function makeChannel() {
  return {
    error: ref<string | null>(null),
    isEncrypted: ref(false),
    p2pRooms: ref<RoomEntry[]>([]),
    createRoom: vi.fn<(name: string) => Promise<string | null>>(),
    joinByTicket: vi.fn<(t: string) => Promise<void>>(),
    cancelJoin: vi.fn(async () => {}),
    deleteRoom: vi.fn(async () => {}),
  };
}
type Channel = ReturnType<typeof makeChannel>;

function makeController(channel: Channel) {
  return useP2pRooms(channel as unknown as ChatChannel);
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockGetConnectTimeoutSecs.mockImplementation(async () => 5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useP2pRooms — DHT room code on create", () => {
  it("picks the code off the remembered room entry (DHT discovery on)", async () => {
    const ch = makeChannel();
    // Simulate the channel: createRoom resolves the ticket AND remembers the
    // entry (rememberP2pRoom) with the code the backend minted.
    ch.createRoom.mockImplementation(async (name: string) => {
      ch.p2pRooms.value.unshift({ room: "r1", name, ticket: "ticket-1", code: "iqaa-code" });
      return "ticket-1";
    });
    const ctrl = makeController(ch);
    ctrl.openCreate();
    ctrl.name.value = "general";
    void ctrl.createRoom();
    await flush();
    expect(ctrl.createdTicket.value).toBe("ticket-1");
    expect(ctrl.createdCode.value).toBe("iqaa-code");
  });

  it("stays empty when the entry has no code (DHT discovery off)", async () => {
    const ch = makeChannel();
    ch.createRoom.mockImplementation(async (name: string) => {
      ch.p2pRooms.value.unshift({ room: "r1", name, ticket: "ticket-1" });
      return "ticket-1";
    });
    const ctrl = makeController(ch);
    ctrl.openCreate();
    ctrl.name.value = "general";
    void ctrl.createRoom();
    await flush();
    expect(ctrl.createdTicket.value).toBe("ticket-1");
    expect(ctrl.createdCode.value).toBe("");
  });

  it("openCreate resets a previous code so a stale one never shows", async () => {
    const ch = makeChannel();
    ch.createRoom.mockImplementation(async (name: string) => {
      ch.p2pRooms.value.unshift({ room: "r1", name, ticket: "ticket-1", code: "iqaa-code" });
      return "ticket-1";
    });
    const ctrl = makeController(ch);
    ctrl.openCreate();
    ctrl.name.value = "general";
    void ctrl.createRoom();
    await flush();
    expect(ctrl.createdCode.value).toBe("iqaa-code");

    ctrl.openCreate();
    expect(ctrl.createdCode.value).toBe("");
    expect(ctrl.createdTicket.value).toBe("");
  });
});
