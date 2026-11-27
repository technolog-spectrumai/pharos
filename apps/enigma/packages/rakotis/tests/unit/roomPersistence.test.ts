// Getting back into a room after a restart: the saved room entry is all there is.
//
// A room is reopened from its saved entry — its name and the other members'
// onions — and nothing else. These tests pin that:
//
//  1. `joinByInvite` saves the room (with the members' onions the grant named,
//     minus our own, and our onion), so an invited member keeps it across a
//     restart.
//  2. `openP2pRoom` reopens a saved room by name and its saved peers, and keeps
//     the entry's onion current.
//  3. Saved entries load as they were written: no ticket, no backfill.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTransport } = vi.hoisted(() => ({
  mockTransport: {
    createRoom: vi.fn(),
    joinRoom: vi.fn(async () => ({ room: "room-1", name: "Room One", onion: "me.onion" })),
    setPeers: vi.fn(),
    cancelJoin: vi.fn(),
    leaveRoom: vi.fn(),
    forgetOnion: vi.fn(),
    deviceId: vi.fn(async () => null),
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    lastStatus: vi.fn((): string | undefined => undefined),
  },
}));
vi.mock("../../src/chatTransport", () => ({ chatTransport: mockTransport }));

vi.mock("../../src/crypto", () => ({
  cryptoService: {
    clearState: vi.fn(async () => {}),
    initSession: vi.fn(async () => {}),
    keyPackage: vi.fn(async () => new Uint8Array([1])),
    members: vi.fn(async () => []),
    addMember: vi.fn(async () => null),
    removeMember: vi.fn(async () => null),
    joinFromWelcome: vi.fn(async () => true),
    processMessage: vi.fn(async () => null),
    adoptSession: vi.fn(async () => true),
  },
  bytesToBase64: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  base64ToBytes: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}));

vi.mock("../../src/services/appStorage", () => ({
  getRuntimeConfig: vi.fn(async () => ({ profile: "t", identity: "me", profile_state_path: "" })),
  getChatHistoryCapMsgs: vi.fn(async () => 500),
  getConnectTimeoutSecs: vi.fn(async () => 60),
}));

const { store } = vi.hoisted(() => ({ store: { rooms: null as string | null } }));
vi.mock("../../src/services/localDb", () => ({
  kvGet: vi.fn(async (ns: string) => (ns === "p2p:rooms" ? store.rooms : null)),
  kvPut: vi.fn(async (ns: string, _s: string, _k: string, v: string) => {
    if (ns === "p2p:rooms") store.rooms = v;
  }),
  kvDelete: vi.fn(async () => {}),
  kvClearNamespace: vi.fn(async () => {}),
}));

import { useChatChannel } from "../../src/useChatChannel";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  store.rooms = null;
  mockTransport.joinRoom.mockResolvedValue({ room: "room-1", name: "Room One", onion: "me.onion" });
});

describe("a room entered by invitation is a saved room", () => {
  it("survives a restart, with the members' onions to link to", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    expect(
      await ch.joinByInvite(
        { roomName: "Room One", welcome: btoa("w"), peers: ["inviter.onion", "carol.onion"] },
        "invite:scratch",
      ),
    ).toBe(true);
    await flush();

    expect(mockTransport.joinRoom).toHaveBeenCalledWith("Room One", ["inviter.onion", "carol.onion"]);
    expect(ch.p2pRooms.value).toEqual([
      { room: "room-1", name: "Room One", peers: ["inviter.onion", "carol.onion"], onion: "me.onion" },
    ]);
    // …and persisted, not just held in memory.
    expect(JSON.parse(store.rooms as string)).toEqual(ch.p2pRooms.value);
  });

  it("never saves our own onion among the peers", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    await ch.joinByInvite(
      { roomName: "Room One", welcome: btoa("w"), peers: ["inviter.onion", "me.onion"] },
      "invite:scratch",
    );
    await flush();
    expect(ch.p2pRooms.value[0].peers).toEqual(["inviter.onion"]);
    expect(ch.p2pRooms.value[0].onion).toBe("me.onion");
    expect(ch.myOnion.value).toBe("me.onion");
  });
});

describe("reopening a saved room", () => {
  it("rejoins by name and the saved peers", async () => {
    const ch = useChatChannel();
    await ch.openP2pRoom({ room: "room-1", name: "Room One", peers: ["peer-a.onion"], onion: "me.onion" });
    await flush();
    expect(mockTransport.joinRoom).toHaveBeenCalledWith("Room One", ["peer-a.onion"]);
    expect(mockTransport.createRoom).not.toHaveBeenCalled();
    expect(ch.currentRoom.value?.slug).toBe("room-1");
    expect(ch.myOnion.value).toBe("me.onion");
  });

  it("opens a room with no saved peers too (alone until someone links)", async () => {
    const ch = useChatChannel();
    await ch.openP2pRoom({ room: "room-1", name: "Room One", host: true });
    await flush();
    expect(mockTransport.joinRoom).toHaveBeenCalledWith("Room One", []);
    expect(ch.currentRoom.value?.slug).toBe("room-1");
  });

  it("re-saves our onion when it changed (e.g. after the onion keys were cleared)", async () => {
    store.rooms = JSON.stringify([{ room: "room-1", name: "Room One", peers: ["p.onion"], onion: "old.onion" }]);
    const ch = useChatChannel();
    await ch.loadP2pRooms();
    await ch.openP2pRoom(ch.p2pRooms.value[0]);
    await flush();
    expect(ch.p2pRooms.value[0].onion).toBe("me.onion");
    expect(JSON.parse(store.rooms as string)[0].onion).toBe("me.onion");
    expect(ch.myOnion.value).toBe("me.onion");
  });

  it("leaves the saved entry alone when the onion is unchanged", async () => {
    store.rooms = JSON.stringify([{ room: "room-1", name: "Room One", onion: "me.onion" }]);
    const ch = useChatChannel();
    await ch.loadP2pRooms();
    const { kvPut } = await import("../../src/services/localDb");
    vi.mocked(kvPut).mockClear();
    await ch.openP2pRoom(ch.p2pRooms.value[0]);
    await flush();
    expect(vi.mocked(kvPut).mock.calls.filter(([ns]) => ns === "p2p:rooms")).toHaveLength(0);
  });

  it("surfaces a failed join as the channel error and enters nothing", async () => {
    mockTransport.joinRoom.mockRejectedValueOnce(new Error("onion not reachable"));
    const ch = useChatChannel();
    await ch.openP2pRoom({ room: "room-1", name: "Room One" });
    expect(ch.error.value).toBe("onion not reachable");
    expect(ch.currentRoom.value).toBeNull();
  });
});

describe("loading the saved rooms", () => {
  it("reads the entries exactly as they were written — no ticket backfill", async () => {
    const saved = [
      { room: "room-1", name: "Room One", peers: ["p.onion"], host: true, onion: "me.onion" },
      { room: "room-2", name: "Room Two" },
    ];
    store.rooms = JSON.stringify(saved);
    const ch = useChatChannel();
    await ch.loadP2pRooms();
    await flush();
    expect(ch.p2pRooms.value).toEqual(saved);
    expect(JSON.parse(store.rooms as string)).toEqual(saved); // nothing rewritten
  });

  it("treats a corrupt saved list as empty", async () => {
    store.rooms = "{oops";
    const ch = useChatChannel();
    await ch.loadP2pRooms();
    expect(ch.p2pRooms.value).toEqual([]);
  });
});
