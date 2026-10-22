// A room's life on this device: creating, entering, leaving, deleting, being
// told it closed — and, over Tor, keeping a captain to dial.
//
// Most of these paths end in a wipe or a teardown, and the failure that matters
// is the quiet one: a room that is "left" but still on the saved list, a deleted
// room whose log survives, a Tor member still dialling a captain that died. So
// the assertions here are about what is left behind, not only what is shown.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { wire, mockTransport } = vi.hoisted(() => {
  type MessageHandler = (room: string, data: unknown) => void;
  type StatusHandler = (room: string, state: string, peerId?: string, reason?: string) => void;
  const wire = { message: [] as MessageHandler[], status: [] as StatusHandler[] };
  const mockTransport = {
    createRoom: vi.fn(),
    joinRoomByNode: vi.fn(),
    decodeLegacyTicket: vi.fn(async () => null),
    cancelJoin: vi.fn(),
    leaveRoom: vi.fn(),
    forgetTorOnion: vi.fn(),
    setCaptain: vi.fn(),
    nodeInfo: vi.fn(async (): Promise<{ node_id: string } | null> => null),
    send: vi.fn(),
    onMessage: vi.fn((h: MessageHandler) => {
      wire.message.push(h);
      return () => {};
    }),
    onStatus: vi.fn((h: StatusHandler) => {
      wire.status.push(h);
      return () => {};
    }),
    lastStatus: vi.fn((): string | undefined => undefined),
  };
  return { wire, mockTransport };
});
vi.mock("../../src/chatTransport", () => ({ chatTransport: mockTransport }));

const { crypto } = vi.hoisted(() => ({
  crypto: {
    clearState: vi.fn(async () => {}),
    initSession: vi.fn(async () => false),
    keyPackage: vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([1, 2, 3])),
    members: vi.fn(async (): Promise<string[]> => []),
    addMember: vi.fn(async (): Promise<{ welcome: Uint8Array; commit: Uint8Array } | null> => ({
      welcome: new Uint8Array([8]),
      commit: new Uint8Array([9]),
    })),
    removeMember: vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([7])),
    joinFromWelcome: vi.fn(async () => true),
    adoptSession: vi.fn(async () => true),
    processMessage: vi.fn(
      async (_room: string, _id: string, bytes: Uint8Array): Promise<Uint8Array | null> => bytes,
    ),
    encrypt: vi.fn(
      async (_room: string, _id: string, text: string): Promise<Uint8Array | null> =>
        new TextEncoder().encode(text),
    ),
  },
}));
vi.mock("../../src/crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/crypto")>()),
  cryptoService: crypto,
}));

import { useChatChannel, type P2pRoomEntry } from "../../src/useChatChannel";
import { bytesToBase64, base64ToBytes } from "../../src/crypto";
import { kvGet, kvPut } from "../../src/services/localDb";
import { loadLog } from "../../src/services/chatLog";

const ROOM = "room-1";
type Channel = ReturnType<typeof useChatChannel>;
type Frame = Record<string, unknown>;

const seal = (inner: unknown) => bytesToBase64(new TextEncoder().encode(JSON.stringify(inner)));
const openInner = (frame: Frame): Record<string, unknown> | null => {
  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(frame.ciphertext as string)));
  } catch {
    return null;
  }
};

const flush = () => vi.advanceTimersByTimeAsync(0);

async function deliver(data: Frame, room = ROOM) {
  for (const h of wire.message) h(room, data);
  await flush();
}
async function status(state: string, room = ROOM, peerId?: string, reason?: string) {
  for (const h of wire.status) h(room, state, peerId, reason);
  await flush();
}

const fromPeer = (device: string, inner: unknown): Frame => ({
  type: "mls_app", ciphertext: seal(inner), device_id: device, sender_name: device,
});
const presence = (device: string, onion = "", reply = true) =>
  deliver(fromPeer(device, { type: "presence", device_id: device, name: device, avatar: "", onion, reply }));

const sent = (type?: string) =>
  mockTransport.send.mock.calls
    .map(([, payload]) => payload as Frame)
    .filter((p) => !type || p.type === type);
const sentInner = (type: string) =>
  sent("mls_app").map(openInner).filter((i) => i?.type === type);
const notices = (ch: Channel) => ch.messages.value.map((m) => m.content);
const entry = (ch: Channel, room = ROOM) => ch.p2pRooms.value.find((r) => r.room === room);
const storedRooms = async (): Promise<P2pRoomEntry[]> =>
  JSON.parse((await kvGet("p2p:rooms", "default", "")) ?? "[]");

async function create(ch: Channel, room = ROOM, onion = "") {
  mockTransport.createRoom.mockResolvedValueOnce({ room, name: room === ROOM ? "Room One" : "Room Two", onion });
  return ch.createRoom(room === ROOM ? "Room One" : "Room Two");
}

/** A room we created, connected and with a ready group. */
async function readyRoom(identity = "alice", members: string[] = [], onion = "") {
  crypto.members.mockResolvedValue(members);
  const ch = useChatChannel();
  ch.mlsIdentity.value = identity;
  await create(ch, ROOM, onion);
  await status("connected");
  await vi.advanceTimersByTimeAsync(5000);
  expect(ch.mlsStatus.value).toBe("ready");
  mockTransport.send.mockClear();
  return ch;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
  vi.resetAllMocks();
  wire.message.length = 0;
  wire.status.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── creating and joining ────────────────────────────────────────────────────

describe("creating a room", () => {
  it("enters it, saves it as ours, and hands back only its slug", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    expect(await create(ch)).toBe(ROOM);
    expect(mockTransport.createRoom).toHaveBeenCalledWith("Room One");
    expect(entry(ch)).toEqual({ room: ROOM, name: "Room One", host: true, tor: false, onion: undefined });
    expect((await storedRooms())[0]).toMatchObject({ room: ROOM, host: true, tor: false });
    expect(ch.currentRoom.value).toMatchObject({ slug: ROOM, name: "Room One", id: 0 });
    // No profile name yet, so the roster shows our identity — and the election
    // has already run, so the sole member is the captain before anyone joins.
    expect(ch.participants.value).toEqual([
      { id: "alice", name: "alice", avatar_url: "", type: "human", isCaptain: true },
    ]);
    expect(ch.isParticipant.value).toBe(true);
    expect(ch.wsStatus.value).toBe("connecting");
    expect(notices(ch)).toEqual(["Created “Room One”. Invite someone to let them in."]);
  });

  it("returns null with the transport's reason when it fails, entering nothing", async () => {
    const ch = useChatChannel();
    mockTransport.createRoom.mockRejectedValueOnce(new Error("Network access is off."));
    expect(await ch.createRoom("Room One")).toBeNull();
    expect(ch.error.value).toBe("Network access is off.");
    expect(ch.currentRoom.value).toBeNull();
    expect(ch.p2pRooms.value).toEqual([]);
  });

  it("over Tor, marks the room Tor and makes its creator the captain straight away", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await create(ch, ROOM, "alice.onion");
    await flush();
    expect(ch.currentRoomIsTor.value).toBe(true);
    expect(entry(ch)).toMatchObject({ tor: true, host: true, onion: "alice.onion", captainOnion: "alice.onion" });
    expect(ch.captainId.value).toBe("alice");
    expect(ch.participants.value[0].isCaptain).toBe(true);
    // The re-point is debounced so a burst of joins becomes one dial.
    expect(mockTransport.setCaptain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockTransport.setCaptain).toHaveBeenCalledWith(ROOM, "alice.onion");
  });
});

describe("joining by node", () => {
  it("surfaces the transport's reason and leaves nothing open when it fails", async () => {
    const ch = useChatChannel();
    mockTransport.joinRoomByNode.mockRejectedValueOnce(new Error("no route to peers"));
    await ch.joinByNode("  Room One  ", ["node-b"]);
    expect(mockTransport.joinRoomByNode).toHaveBeenCalledWith("Room One", ["node-b"]);
    expect(ch.error.value).toBe("no route to peers");
    expect(ch.currentRoom.value).toBeNull();
  });

  it("can be cancelled, which also clears the error the aborted join left", async () => {
    const ch = useChatChannel();
    mockTransport.joinRoomByNode.mockRejectedValueOnce(new Error("aborted"));
    await ch.joinByNode("Room One", []);
    await ch.cancelJoin();
    expect(mockTransport.cancelJoin).toHaveBeenCalledTimes(1);
    expect(ch.error.value).toBeNull();
  });

  it("enters the room and says it is connecting", async () => {
    mockTransport.joinRoomByNode.mockResolvedValueOnce({ room: ROOM, name: "Room One", onion: "" });
    const ch = useChatChannel();
    await ch.joinByNode("Room One", ["node-b"]);
    expect(ch.currentRoom.value?.slug).toBe(ROOM);
    expect(ch.currentRoomIsTor.value).toBe(false);
    expect(notices(ch)).toEqual(["Joined “Room One”. Connecting to peers…"]);
  });
});

describe("reopening a saved room", () => {
  it("does nothing when that room is already on screen", async () => {
    const ch = await readyRoom();
    await ch.openP2pRoom(entry(ch)!);
    expect(mockTransport.joinRoomByNode).not.toHaveBeenCalled();
    expect(ch.mlsStatus.value).toBe("ready");
  });

  it("surfaces a failed reopen as the channel error", async () => {
    const ch = useChatChannel();
    mockTransport.joinRoomByNode.mockRejectedValueOnce(new Error("offline"));
    await ch.openP2pRoom({ room: ROOM, name: "Room One" });
    expect(ch.error.value).toBe("offline");
    expect(ch.currentRoom.value).toBeNull();
  });

  it("loads a corrupt saved list as empty rather than throwing", async () => {
    await kvPut("p2p:rooms", "default", "", "{not json");
    const ch = useChatChannel();
    await ch.loadP2pRooms();
    expect(ch.p2pRooms.value).toEqual([]);
  });
});

describe("a headless channel", () => {
  it("never reads or writes the saved room list", async () => {
    // The hidden device-link room must not show up as a chat the user can open.
    await kvPut("p2p:rooms", "default", "", JSON.stringify([{ room: "saved", name: "Saved" }]));
    const ch = useChatChannel({ headless: true });
    await ch.loadP2pRooms();
    expect(ch.p2pRooms.value).toEqual([]);
    await create(ch);
    expect(ch.p2pRooms.value).toEqual([]);
    expect((await storedRooms()).map((r) => r.room)).toEqual(["saved"]);
  });
});

// ── transport status ────────────────────────────────────────────────────────

describe("transport status", () => {
  it("remembers each neighbour's NodeId for any saved room, once", async () => {
    // Several rooms can be live at once; the address book of one that is not on
    // screen is just as much a reconnect handle.
    const ch = useChatChannel();
    await create(ch, "room-2");
    await create(ch, ROOM);
    await status("connected", "room-2", "node-x");
    await status("connected", "room-2", "node-x");
    await status("connected", ROOM, "node-y");
    await status("connected", "never-saved", "node-z");
    expect(entry(ch, "room-2")?.peers).toEqual(["node-x"]);
    expect(entry(ch, ROOM)?.peers).toEqual(["node-y"]);
    expect((await storedRooms()).find((r) => r.room === "room-2")?.peers).toEqual(["node-x"]);
    // Only the room on screen drives the visible connection state.
    expect(ch.currentRoom.value?.slug).toBe(ROOM);
    expect(ch.wsStatus.value).toBe("connected");
  });

  it("reports a connection error as an error", async () => {
    const ch = useChatChannel();
    await create(ch);
    await status("error");
    expect(ch.wsStatus.value).toBe("error");
    expect(ch.messages.value.at(-1)).toMatchObject({ type: "system_error", content: "Connection error." });
  });

  it("ignores status for a room that is not on screen", async () => {
    const ch = useChatChannel();
    await create(ch);
    await status("error", "room-2");
    expect(ch.wsStatus.value).toBe("connecting");
    expect(notices(ch)).toHaveLength(1);
  });
});

// ── Tor captaincy ───────────────────────────────────────────────────────────

describe("the Tor captain", () => {
  /** A Tor room where "bob" (lowest id) is captain once we know his onion. */
  async function torRoom() {
    const ch = await readyRoom("zed", ["bob", "zed"], "zed.onion");
    await presence("bob", "bob.onion");
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockTransport.setCaptain).toHaveBeenLastCalledWith(ROOM, "bob.onion");
    mockTransport.setCaptain.mockClear();
    return ch;
  }

  it("is dialled once we learn its onion, and that address is saved for reopening", async () => {
    const ch = await torRoom();
    expect(ch.captainId.value).toBe("bob");
    expect(entry(ch)?.captainOnion).toBe("bob.onion");
    expect((await storedRooms())[0].captainOnion).toBe("bob.onion");
  });

  it("is not re-dialled when nothing about it changed", async () => {
    await torRoom();
    await presence("bob", "bob.onion");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockTransport.setCaptain).not.toHaveBeenCalled();
  });

  it("is replaced by the next member when it becomes unreachable, and then evicted", async () => {
    const ch = await torRoom();
    mockTransport.send.mockClear();
    await status("disconnected", ROOM, "bob.onion", "captain_unreachable");
    expect(notices(ch).at(-1)).toBe("The room host went offline — electing a new host…");
    // Failover is election-driven: the dead onion is not a reconnect peer, and
    // the connection state is left alone.
    expect(entry(ch)?.peers).toBeUndefined();
    expect(ch.wsStatus.value).toBe("connected");
    expect(ch.captainId.value).toBe("zed");

    await vi.advanceTimersByTimeAsync(2000);
    expect(mockTransport.setCaptain).toHaveBeenCalledWith(ROOM, "zed.onion");
    // The eviction waits for the re-point, so its commit rides the NEW captain.
    expect(crypto.removeMember).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(crypto.removeMember).toHaveBeenCalledWith(ROOM, "zed", "bob");
    expect(sent("mls_commit")).toEqual([{ type: "mls_commit", commit: "Bw==" }]);
  });

  it("comes back when a captain we thought dead announces itself again", async () => {
    const ch = await torRoom();
    await status("disconnected", ROOM, "bob.onion", "captain_unreachable");
    await vi.advanceTimersByTimeAsync(2000);
    expect(ch.captainId.value).toBe("zed");
    mockTransport.setCaptain.mockClear();

    await presence("bob", "bob.onion");
    expect(ch.captainId.value).toBe("bob");
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockTransport.setCaptain).toHaveBeenCalledWith(ROOM, "bob.onion");
  });

  it("does not exist on an iroh room, so an unreachable report changes nothing", async () => {
    const ch = await readyRoom("zed", ["bob", "zed"]);
    const before = notices(ch).length;
    await status("disconnected", ROOM, "bob.onion", "captain_unreachable");
    await vi.advanceTimersByTimeAsync(5000);
    expect(notices(ch)).toHaveLength(before);
    expect(mockTransport.setCaptain).not.toHaveBeenCalled();
    expect(crypto.removeMember).not.toHaveBeenCalled();
  });
});

// ── members leaving ─────────────────────────────────────────────────────────

describe("a member leaving", () => {
  const leave = (device: string) => deliver(fromPeer(device, { type: "leave", device_id: device }));

  it("is removed from the group by the lowest remaining member", async () => {
    await readyRoom("alice", ["alice", "bob", "carol"]);
    await leave("carol");
    expect(crypto.removeMember).toHaveBeenCalledWith(ROOM, "alice", "carol");
    expect(sent("mls_commit")).toEqual([{ type: "mls_commit", commit: "Bw==" }]);
  });

  it("is left to the admin when that is someone else", async () => {
    await readyRoom("zed", ["bob", "carol", "zed"]);
    await leave("carol");
    expect(crypto.removeMember).not.toHaveBeenCalled();
  });

  it("removes nothing when the leaver is no longer in the group", async () => {
    await readyRoom("alice", ["alice", "bob"]);
    await leave("dave");
    expect(crypto.removeMember).not.toHaveBeenCalled();
  });
});

describe("removeLeaf", () => {
  it("removes exactly one device and leaves the user's others in place", async () => {
    // Unlinking a laptop must not also kick the phone.
    const ch = await readyRoom("alice", ["alice", "bob", "bob#dev-abcdefgh"]);
    await ch.removeLeaf("bob#dev-abcdefgh");
    expect(crypto.removeMember.mock.calls).toEqual([[ROOM, "alice", "bob#dev-abcdefgh"]]);
    expect(sent("mls_commit")).toEqual([{ type: "mls_commit", commit: "Bw==" }]);
  });

  it("refuses our own leaf and anything the group does not list", async () => {
    const ch = await readyRoom("alice", ["alice", "bob"]);
    await ch.removeLeaf("alice");
    await ch.removeLeaf("carol");
    expect(crypto.removeMember).not.toHaveBeenCalled();
    expect(mockTransport.send).not.toHaveBeenCalled();
  });
});

// ── leaving, closing, deleting ──────────────────────────────────────────────

describe("leaving the room", () => {
  it("tells the group over the encrypted seam, then resets the view", async () => {
    const ch = await readyRoom("alice", ["alice", "bob"]);
    await ch.leaveParticipant();
    expect(sentInner("leave")).toEqual([{ type: "leave", device_id: "alice" }]);
    expect(mockTransport.leaveRoom).toHaveBeenCalledWith(ROOM);
    expect(ch.currentRoom.value).toBeNull();
    expect(ch.messages.value).toEqual([]);
    expect(ch.participants.value).toEqual([]);
    expect(ch.isParticipant.value).toBe(false);
    expect(ch.mlsStatus.value).toBe("idle");
    // Leaving is not forgetting: the room stays on the saved list.
    expect(entry(ch)).toBeDefined();
  });

  it("sends nothing when there is no group to tell yet", async () => {
    const ch = useChatChannel();
    await create(ch);
    await ch.leaveParticipant();
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(mockTransport.leaveRoom).toHaveBeenCalledWith(ROOM);
  });

  it("is a no-op, like joining, with no room open", async () => {
    const ch = useChatChannel();
    await ch.joinParticipant();
    await ch.leaveParticipant();
    expect(ch.isParticipant.value).toBe(false);
    expect(mockTransport.leaveRoom).not.toHaveBeenCalled();

    await create(ch);
    ch.isParticipant.value = false;
    await ch.joinParticipant();
    expect(ch.isParticipant.value).toBe(true);
  });
});

describe("the host closing the room", () => {
  it("wipes it on our side too and leaves one notice", async () => {
    const ch = await readyRoom("zed", ["bob", "zed"], "zed.onion");
    await ch.sendMessage("soon gone");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => expect(await loadLog(ROOM)).toHaveLength(1));

    await deliver(fromPeer("bob", { type: "room_closed", device_id: "bob" }));
    expect(crypto.clearState).toHaveBeenLastCalledWith(ROOM, "zed");
    expect(mockTransport.forgetTorOnion).toHaveBeenCalledWith("Room One");
    expect(ch.p2pRooms.value).toEqual([]);
    expect(await storedRooms()).toEqual([]);
    expect(ch.currentRoom.value).toBeNull();
    expect(notices(ch)).toEqual(["This room was deleted by the host."]);
    await vi.waitFor(async () => expect(await loadLog(ROOM)).toEqual([]));
  });
});

describe("deleting a room", () => {
  it("closes an open room we host for everyone, wipes it, and reports the bytes freed", async () => {
    const ch = await readyRoom("alice", ["alice", "bob"]);
    await ch.sendMessage("history worth a credit");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => expect(await loadLog(ROOM)).toHaveLength(1));
    const storedBytes = (await kvGet("chat:log", ROOM, "seg-0"))!.length;
    mockTransport.send.mockClear();

    const freed = await ch.deleteRoom(entry(ch)!);
    expect(sentInner("room_closed")).toEqual([{ type: "room_closed", device_id: "alice" }]);
    expect(crypto.clearState).toHaveBeenLastCalledWith(ROOM, "alice");
    expect(freed).toBe(storedBytes);
    expect(await loadLog(ROOM)).toEqual([]);
    expect(ch.p2pRooms.value).toEqual([]);
    expect(ch.currentRoom.value).toBeNull();
    expect(notices(ch)).toEqual(["Room deleted."]);
  });

  it("sends an ordinary leave for a room we only joined", async () => {
    const ch = await readyRoom("alice", ["alice", "bob"]);
    expect(await ch.deleteRoom({ ...entry(ch)!, host: false })).toBe(0);
    expect(sentInner("leave")).toEqual([{ type: "leave", device_id: "alice" }]);
    expect(sentInner("room_closed")).toEqual([]);
  });

  it("only stops the connection of a room that is not open, and forgets its onion", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await create(ch, "room-2", "two.onion");
    await create(ch, ROOM);
    const other = entry(ch, "room-2")!;

    expect(await ch.deleteRoom(other)).toBe(0);
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(crypto.clearState).toHaveBeenCalledWith("room-2", "alice");
    expect(mockTransport.forgetTorOnion).toHaveBeenCalledWith("Room Two");
    expect(mockTransport.leaveRoom).toHaveBeenCalledWith("room-2");
    expect(ch.p2pRooms.value.map((r) => r.room)).toEqual([ROOM]);
    expect(ch.currentRoom.value?.slug).toBe(ROOM);
  });
});

// ── invitations ─────────────────────────────────────────────────────────────

describe("admitting an invitee", () => {
  it("adds them, commits to the room first, and grants our NodeId as the peer to dial", async () => {
    const ch = await readyRoom("alice", ["alice"]);
    mockTransport.nodeInfo.mockResolvedValueOnce({ node_id: "node-alice" });
    const grant = await ch.admitInvited(ROOM, "AQID");
    expect(crypto.addMember).toHaveBeenCalledWith(ROOM, "alice", new Uint8Array([1, 2, 3]));
    expect(sent()).toEqual([{ type: "mls_commit", commit: "CQ==" }]);
    expect(grant).toEqual({ welcome: "CA==", roomName: "Room One", peers: ["node-alice"], onion: "" });
  });

  it("over Tor, grants our onion and no iroh peers", async () => {
    const ch = await readyRoom("alice", ["alice"], "alice.onion");
    const grant = await ch.admitInvited(ROOM, "AQID");
    expect(grant).toMatchObject({ peers: [], onion: "alice.onion" });
    expect(mockTransport.nodeInfo).not.toHaveBeenCalled();
  });

  it("grants no peers rather than failing when our node will not start", async () => {
    const ch = await readyRoom("alice", ["alice"]);
    mockTransport.nodeInfo.mockRejectedValueOnce(new Error("bind failed"));
    expect((await ch.admitInvited(ROOM, "AQID"))?.peers).toEqual([]);
  });

  it("refuses a room that is not open, or not ready, without touching the group", async () => {
    // null tells Rust to release the invitation's lease rather than burn it.
    const ch = await readyRoom("alice", ["alice"]);
    expect(await ch.admitInvited("room-2", "AQID")).toBeNull();
    ch.mlsStatus.value = "key_exchange";
    expect(await ch.admitInvited(ROOM, "AQID")).toBeNull();
    expect(crypto.addMember).not.toHaveBeenCalled();
  });

  it("returns null when the group will not take the key package", async () => {
    const ch = await readyRoom("alice", ["alice"]);
    crypto.addMember.mockResolvedValueOnce(null);
    expect(await ch.admitInvited(ROOM, "AQID")).toBeNull();
    crypto.addMember.mockRejectedValueOnce(new Error("malformed key package"));
    expect(await ch.admitInvited(ROOM, "AQID")).toBeNull();
    expect(mockTransport.send).not.toHaveBeenCalled();
  });
});

describe("joining by invitation", () => {
  const grant = (onion = "") => ({ roomName: "Room One", welcome: "CAk=", peers: onion ? [] : ["node-a"], onion });

  beforeEach(() => {
    mockTransport.joinRoomByNode.mockResolvedValue({ room: ROOM, name: "Room One", onion: "" });
  });

  it("moves the scratch session onto the room, opens the Welcome, and comes up encrypted", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    expect(await ch.joinByInvite(grant(), "invite:scratch")).toBe(true);
    expect(crypto.adoptSession).toHaveBeenCalledWith("invite:scratch", ROOM, "me");
    expect(crypto.joinFromWelcome).toHaveBeenCalledWith(ROOM, "me", new Uint8Array([8, 9]));
    expect(ch.mlsStatus.value).toBe("ready");
    expect(notices(ch).at(-1)).toBe("🔒 End-to-end encryption active.");
  });

  it("points a Tor joiner at the captain's onion straight away", async () => {
    const ch = useChatChannel();
    await ch.joinByInvite(grant("captain.onion"), "invite:scratch");
    expect(mockTransport.setCaptain).toHaveBeenCalledWith(ROOM, "captain.onion");
  });

  it("fails, without opening the Welcome, when the scratch session cannot move", async () => {
    const ch = useChatChannel();
    crypto.adoptSession.mockResolvedValueOnce(false);
    expect(await ch.joinByInvite(grant(), "invite:scratch")).toBe(false);
    expect(crypto.joinFromWelcome).not.toHaveBeenCalled();
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.mlsError.value).toBe("Could not take up the invitation's encrypted session.");
  });

  it("fails when the Welcome will not open", async () => {
    const ch = useChatChannel();
    crypto.joinFromWelcome.mockResolvedValueOnce(false);
    expect(await ch.joinByInvite(grant(), "invite:scratch")).toBe(false);
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.mlsError.value).toBe("Failed to join encrypted group.");
  });

  it("fails with the transport's reason when the room cannot be joined", async () => {
    const ch = useChatChannel();
    mockTransport.joinRoomByNode.mockRejectedValueOnce(new Error("Network access is off."));
    expect(await ch.joinByInvite(grant(), "invite:scratch")).toBe(false);
    expect(ch.error.value).toBe("Network access is off.");
    expect(crypto.adoptSession).not.toHaveBeenCalled();
    expect(ch.p2pRooms.value).toEqual([]);
  });

  it("fails with the reason when anything after the join throws", async () => {
    const ch = useChatChannel();
    crypto.adoptSession.mockRejectedValueOnce(new Error("session store unreadable"));
    expect(await ch.joinByInvite(grant(), "invite:scratch")).toBe(false);
    expect(ch.error.value).toBe("session store unreadable");
  });
});

describe("ensureNode", () => {
  it("returns our NodeId, or null when the endpoint cannot start", async () => {
    const ch = useChatChannel();
    mockTransport.nodeInfo.mockResolvedValueOnce({ node_id: "node-me" });
    expect(await ch.ensureNode()).toBe("node-me");
    mockTransport.nodeInfo.mockResolvedValueOnce(null);
    expect(await ch.ensureNode()).toBeNull();
    mockTransport.nodeInfo.mockRejectedValueOnce(new Error("bind failed"));
    expect(await ch.ensureNode()).toBeNull();
  });
});

// ── identity ────────────────────────────────────────────────────────────────

describe("the runtime identity", () => {
  it("is taken from the runtime config, which also names us until the profile does", async () => {
    // In the browser the runtime degrades to a fixed "browser" identity.
    const ch = useChatChannel();
    await ch.syncRuntimeIdentity();
    expect(ch.mlsIdentity.value).toBe("browser");
    expect(ch.currentUserName.value).toBe("browser");

    const named = useChatChannel();
    named.currentUserName.value = "Alice";
    await named.syncRuntimeIdentity();
    expect(named.currentUserName.value).toBe("Alice");
  });

  it("switching profile leaves every chat and says why", async () => {
    const ch = await readyRoom("alice", ["alice"]);
    await ch.applyRuntimeProfile({ profile: "work", identity: "work-id", profile_state_path: "" });
    expect(ch.mlsIdentity.value).toBe("work-id");
    expect(mockTransport.leaveRoom).toHaveBeenCalledWith(ROOM);
    expect(ch.currentRoom.value).toBeNull();
    expect(ch.mlsStatus.value).toBe("idle");
    expect(notices(ch)).toEqual(["Runtime profile switched to work. Left all chats and reset MLS."]);
  });

  it("clearing local chat state leaves the default notice", async () => {
    const ch = await readyRoom("alice", ["alice"]);
    ch.clearLocalChatState();
    expect(notices(ch)).toEqual(["Left all chats and reset MLS."]);
    expect(ch.participants.value).toEqual([]);
    expect(ch.isParticipant.value).toBe(false);
  });
});
