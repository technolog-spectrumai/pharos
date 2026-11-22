// Getting back into a room after a restart, with no ticket anywhere.
//
// Rooms used to be reopened by replaying their permanent ticket, so the ticket was
// not really a share button — it was the persisted room credential. Removing it
// exposed two gaps that had been masked all along:
//
//  1. `joinByInvite` never saved the room at all. An invited member held it only
//     for the life of the process: absent from the saved list, `updateRoomEntry`
//     a no-op, and no peer address book accumulating for reconnect. Nobody noticed
//     because every member also had a ticket.
//  2. A Tor room we JOINED kept the captain's onion only inside the ticket. The
//     record's own `onion` is ours, not theirs — so dropping the field would have
//     stranded those rooms permanently.
//
// These tests pin both, plus the one-time backfill that rescues records written by
// older builds.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTransport } = vi.hoisted(() => ({
  mockTransport: {
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    joinRoomByNode: vi.fn(async () => ({ room: "room-1", name: "Room One", onion: "" })),
    decodeLegacyTicket: vi.fn(async () => null),
    cancelJoin: vi.fn(),
    leaveRoom: vi.fn(),
    forgetTorOnion: vi.fn(),
    setCaptain: vi.fn(),
    nodeInfo: vi.fn(async () => null),
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
  mockTransport.joinRoomByNode.mockResolvedValue({ room: "room-1", name: "Room One", onion: "" });
  mockTransport.decodeLegacyTicket.mockResolvedValue(null);
});

describe("a room entered by invitation is a saved room", () => {
  it("survives the restart that used to lose it", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    await ch.joinByInvite(
      { roomName: "Room One", welcome: btoa("w"), peers: ["peer-a"], onion: "" },
      "invite:scratch",
    );
    await flush();

    // Saved at all — this is the call that was missing.
    expect(ch.p2pRooms.value.map((r) => r.room)).toContain("room-1");
    // …and with the address book a ticketless reconnect needs.
    expect(ch.p2pRooms.value[0].peers).toContain("peer-a");
    // …and persisted, not just held in memory.
    expect(store.rooms).toBeTruthy();
    expect(JSON.parse(store.rooms as string)[0].room).toBe("room-1");
  });

  it("records the captain's onion for a Tor invitation", async () => {
    // The address that gets us back into a room we did not host. It arrives in the
    // grant and used to be dialled and then forgotten.
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    await ch.joinByInvite(
      { roomName: "Room One", welcome: btoa("w"), peers: [], onion: "captain123.onion" },
      "invite:scratch",
    );
    await flush();
    expect(ch.p2pRooms.value[0].captainOnion).toBe("captain123.onion");
  });
});

describe("reopening a saved room reads no ticket", () => {
  it("rejoins iroh rooms by name and peers", async () => {
    const ch = useChatChannel();
    await ch.openP2pRoom({ room: "room-1", name: "Room One", peers: ["peer-a"] });
    await flush();
    expect(mockTransport.joinRoomByNode).toHaveBeenCalledWith("Room One", ["peer-a"]);
    expect(mockTransport.joinRoom).not.toHaveBeenCalled();
  });

  it("takes the transport from the record's own flag", async () => {
    // Not from sniffing a ticket's tag byte, which is what it used to do — the flag
    // was always written at create/join time, it just was not the thing consulted.
    const ch = useChatChannel();
    await ch.openP2pRoom({
      room: "room-1", name: "Room One", tor: true, host: false, captainOnion: "cap.onion",
    });
    await flush();
    expect(ch.currentRoomIsTor.value).toBe(true);
    // A Tor joiner is nowhere without the captain's address.
    expect(mockTransport.setCaptain).toHaveBeenCalledWith("room-1", "cap.onion");
  });

  it("re-hosts a Tor room we own instead of dialling it", async () => {
    mockTransport.createRoom.mockResolvedValue({ room: "room-1", name: "Room One", onion: "mine.onion" });
    const ch = useChatChannel();
    await ch.openP2pRoom({ room: "room-1", name: "Room One", tor: true, host: true });
    await flush();
    expect(mockTransport.createRoom).toHaveBeenCalledWith("Room One");
    expect(mockTransport.joinRoomByNode).not.toHaveBeenCalled();
  });
});

describe("the one-time legacy-ticket backfill", () => {
  it("lifts a Tor captain onion out of an old record, then drops the ticket", async () => {
    store.rooms = JSON.stringify([
      { room: "room-1", name: "Room One", ticket: "tlegacyblob", tor: true },
    ]);
    mockTransport.decodeLegacyTicket.mockResolvedValue({
      tor: true, name: "Room One", peers: [], captain_onion: "cap.onion",
    });

    const ch = useChatChannel();
    await ch.loadP2pRooms();
    await flush();

    expect(ch.p2pRooms.value[0].captainOnion).toBe("cap.onion");
    expect(ch.p2pRooms.value[0].ticket).toBeUndefined();
    // Written back, so the next launch has nothing to decode.
    expect(JSON.parse(store.rooms as string)[0].ticket).toBeUndefined();
  });

  it("unions recovered peers with the live address book rather than replacing it", async () => {
    // The record's peers are fresher than a ticket minted once at room creation.
    store.rooms = JSON.stringify([
      { room: "room-1", name: "Room One", ticket: "ilegacy", peers: ["fresh-peer"] },
    ]);
    mockTransport.decodeLegacyTicket.mockResolvedValue({
      tor: false, name: "Room One", peers: ["old-peer"], captain_onion: "",
    });

    const ch = useChatChannel();
    await ch.loadP2pRooms();
    await flush();

    expect(ch.p2pRooms.value[0].peers).toEqual(expect.arrayContaining(["fresh-peer", "old-peer"]));
  });

  it("drops a ticket it cannot decode instead of keeping it forever", async () => {
    // An undecodable blob could not have been used to join either, so there is
    // nothing to preserve — and keeping it would re-run this pass every launch.
    store.rooms = JSON.stringify([{ room: "room-1", name: "Room One", ticket: "garbage" }]);
    mockTransport.decodeLegacyTicket.mockRejectedValue(new Error("not a ticket"));

    const ch = useChatChannel();
    await ch.loadP2pRooms();
    await flush();

    expect(ch.p2pRooms.value[0].ticket).toBeUndefined();
  });

  it("does not call the decoder when no record carries a ticket", async () => {
    store.rooms = JSON.stringify([{ room: "room-1", name: "Room One", peers: ["p"] }]);
    const ch = useChatChannel();
    await ch.loadP2pRooms();
    await flush();
    expect(mockTransport.decodeLegacyTicket).not.toHaveBeenCalled();
  });
});
