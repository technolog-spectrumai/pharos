// A room's life on this device: creating, entering, leaving, deleting, being
// told it closed — and keeping the list of members' onions Rust links to.
//
// Most of these paths end in a wipe or a teardown, and the failure that matters
// is the quiet one: a room that is "left" but still on the saved list, a deleted
// room whose log or onion survives, a member we keep linking to after they left. So
// the assertions here are about what is left behind, not only what is shown.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { wire, mockTransport } = vi.hoisted(() => {
  type MessageHandler = (room: string, data: unknown) => void;
  type StatusHandler = (room: string, state: string, peerId?: string, linked?: string[]) => void;
  const wire = { message: [] as MessageHandler[], status: [] as StatusHandler[] };
  const mockTransport = {
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    setPeers: vi.fn(),
    cancelJoin: vi.fn(),
    leaveRoom: vi.fn(),
    forgetOnion: vi.fn(),
    deviceId: vi.fn(async (): Promise<string | null> => null),
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
async function status(state: string, room = ROOM, peerId?: string, linked: string[] = []) {
  for (const h of wire.status) h(room, state, peerId, linked);
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

async function create(ch: Channel, room = ROOM, onion = "me.onion") {
  mockTransport.createRoom.mockResolvedValueOnce({ room, name: room === ROOM ? "Room One" : "Room Two", onion });
  return ch.createRoom(room === ROOM ? "Room One" : "Room Two");
}

/** A room we created (a group of one at once), with a member linked. */
async function readyRoom(identity = "alice", members: string[] = [], onion = `${identity}.onion`) {
  crypto.members.mockResolvedValue(members);
  const ch = useChatChannel();
  ch.mlsIdentity.value = identity;
  await create(ch, ROOM, onion);
  await flush();
  expect(ch.mlsStatus.value).toBe("ready");
  await status("connected");
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
  it("enters it, saves it as ours with our onion, and hands back only its slug", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    expect(await create(ch)).toBe(ROOM);
    expect(mockTransport.createRoom).toHaveBeenCalledWith("Room One");
    expect(entry(ch)).toEqual({ room: ROOM, name: "Room One", host: true, onion: "me.onion" });
    expect((await storedRooms())[0]).toEqual({ room: ROOM, name: "Room One", host: true, onion: "me.onion" });
    expect(ch.currentRoom.value).toMatchObject({ slug: ROOM, name: "Room One", id: 0 });
    expect(ch.myOnion.value).toBe("me.onion");
    // No profile name yet, so the roster shows our identity; our own row
    // carries no `linked` flag.
    expect(ch.participants.value).toEqual([{ id: "alice", name: "alice", avatar_url: "", type: "human" }]);
    expect(ch.isParticipant.value).toBe(true);
    expect(ch.wsStatus.value).toBe("waiting"); // nobody to link to yet
    expect(notices(ch)[0]).toBe("Created “Room One”. Invite someone to let them in.");
  });

  it("is a group of one at once, without waiting for anyone", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await create(ch);
    await flush();
    expect(ch.mlsStatus.value).toBe("ready");
    expect(notices(ch)).toContain("🔒 End-to-end encryption active.");
  });

  it("updates the record of a room that is already saved, keeping its peers", async () => {
    // Re-hosting a saved room must not duplicate the row or drop the onions a
    // reopen links to.
    await kvPut("p2p:rooms", "default", "", JSON.stringify([
      { room: ROOM, name: "Old name", peers: ["bob.onion"] },
    ]));
    const ch = useChatChannel();
    await ch.loadP2pRooms();
    await create(ch);
    expect(ch.p2pRooms.value).toEqual([
      { room: ROOM, name: "Room One", peers: ["bob.onion"], host: true, onion: "me.onion" },
    ]);
    expect(await storedRooms()).toHaveLength(1);
  });

  it("returns null with the transport's reason when it fails, entering nothing", async () => {
    const ch = useChatChannel();
    mockTransport.createRoom.mockRejectedValueOnce(new Error("Network access is off."));
    expect(await ch.createRoom("Room One")).toBeNull();
    expect(ch.error.value).toBe("Network access is off.");
    expect(ch.currentRoom.value).toBeNull();
    expect(ch.p2pRooms.value).toEqual([]);
  });
});

describe("cancelling a join", () => {
  it("aborts it and clears the error the aborted join left", async () => {
    const ch = useChatChannel();
    mockTransport.joinRoom.mockRejectedValueOnce(new Error("aborted"));
    await ch.openP2pRoom({ room: ROOM, name: "Room One" });
    expect(ch.error.value).toBe("aborted");
    await ch.cancelJoin();
    expect(mockTransport.cancelJoin).toHaveBeenCalledTimes(1);
    expect(ch.error.value).toBeNull();
  });
});

describe("reopening a saved room", () => {
  it("joins it by name with its saved peers and enters it", async () => {
    mockTransport.joinRoom.mockResolvedValueOnce({ room: ROOM, name: "Room One", onion: "me.onion" });
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await ch.openP2pRoom({ room: ROOM, name: "Room One", peers: ["bob.onion"], onion: "me.onion" });
    expect(mockTransport.joinRoom).toHaveBeenCalledWith("Room One", ["bob.onion"]);
    expect(ch.currentRoom.value?.slug).toBe(ROOM);
    expect(ch.myOnion.value).toBe("me.onion");
    await flush();
    expect(sent("mls_key_package")).toHaveLength(1); // encryption starts on entry
  });

  it("does nothing when that room is already on screen", async () => {
    const ch = await readyRoom();
    await ch.openP2pRoom(entry(ch)!);
    expect(mockTransport.joinRoom).not.toHaveBeenCalled();
    expect(ch.mlsStatus.value).toBe("ready");
  });

  it("surfaces a failed reopen as the channel error", async () => {
    const ch = useChatChannel();
    mockTransport.joinRoom.mockRejectedValueOnce(new Error("offline"));
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
  it("remembers each linked member's onion for any saved room, once", async () => {
    // Several rooms can be live at once; the peers of one that is not on
    // screen are just as much what a reopen links to.
    const ch = useChatChannel();
    await create(ch, "room-2");
    await create(ch, ROOM);
    await status("connected", "room-2", "x.onion");
    await status("connected", "room-2", "x.onion");
    await status("connected", ROOM, "y.onion");
    await status("connected", "never-saved", "z.onion");
    // A link going down is not a new peer.
    await status("waiting", ROOM, "w.onion");
    expect(entry(ch, "room-2")?.peers).toEqual(["x.onion"]);
    expect(entry(ch, ROOM)?.peers).toEqual(["y.onion"]);
    expect((await storedRooms()).find((r) => r.room === "room-2")?.peers).toEqual(["x.onion"]);
    // Only the room on screen drives the visible connection state.
    expect(ch.currentRoom.value?.slug).toBe(ROOM);
    expect(ch.wsStatus.value).toBe("waiting");
  });

  it("says 'Connected' only on the way into connected, not for every link that comes up", async () => {
    const ch = useChatChannel();
    await create(ch);
    await status("connected", ROOM, "bob.onion");
    await status("connected", ROOM, "carol.onion");
    expect(notices(ch).filter((n) => n === "Connected to Room One.")).toHaveLength(1);
    await status("waiting", ROOM, "bob.onion");
    await status("connected", ROOM, "bob.onion");
    expect(notices(ch).filter((n) => n === "Connected to Room One.")).toHaveLength(2);
  });

  it("says nothing while waiting, and 'Disconnected' only when a connection is lost", async () => {
    const ch = useChatChannel();
    await create(ch);
    await flush();
    const before = notices(ch).length;
    await status("waiting");
    await status("disconnected"); // from waiting: nothing was lost
    expect(notices(ch)).toHaveLength(before);
    await status("connected", ROOM, "bob.onion");
    await status("disconnected");
    expect(notices(ch).slice(before)).toEqual(["Connected to Room One.", "Disconnected."]);
    expect(ch.wsStatus.value).toBe("disconnected");
    expect(ch.isConnected.value).toBe(false);
  });

  it("does not start encryption: a status event never sends a key package", async () => {
    mockTransport.joinRoom.mockResolvedValueOnce({ room: ROOM, name: "Room One", onion: "me.onion" });
    crypto.initSession.mockRejectedValueOnce(new Error("vault locked"));
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await ch.openP2pRoom({ room: ROOM, name: "Room One" });
    await flush();
    expect(ch.mlsStatus.value).toBe("error");
    await status("connected", ROOM, "bob.onion");
    expect(sent("mls_key_package")).toEqual([]);
    expect(ch.mlsStatus.value).toBe("error");
  });

  it("reports a connection error as an error", async () => {
    const ch = useChatChannel();
    await create(ch);
    await flush();
    await status("error");
    expect(ch.wsStatus.value).toBe("error");
    expect(ch.messages.value.at(-1)).toMatchObject({ type: "system_error", content: "Connection error." });
  });

  it("ignores status for a room that is not on screen", async () => {
    const ch = useChatChannel();
    await create(ch);
    await flush();
    const before = notices(ch).length;
    await status("error", "room-2");
    expect(ch.wsStatus.value).toBe("waiting");
    expect(notices(ch)).toHaveLength(before);
  });

  it("tracks who is linked, and marks those members linked on the roster", async () => {
    const ch = await readyRoom("alice", ["alice", "bob", "carol"]);
    await presence("bob", "bob.onion");
    await presence("carol", "carol.onion");
    await status("connected", ROOM, "bob.onion", ["bob.onion"]);
    expect(ch.linkedOnions.value).toEqual(["bob.onion"]);
    const row = (id: string) => ch.participants.value.find((p) => p.id === id);
    expect(row("bob")?.linked).toBe(true);
    expect(row("carol")?.linked).toBe(false);
    expect(row("alice")?.linked).toBeUndefined(); // ourselves: unset

    await status("connected", ROOM, "carol.onion", ["carol.onion"]);
    expect(row("bob")?.linked).toBe(false);
    expect(row("carol")?.linked).toBe(true);
    // Another room's links do not touch this one.
    await status("connected", "room-2", "dan.onion", ["dan.onion"]);
    expect(ch.linkedOnions.value).toEqual(["carol.onion"]);
  });

  it("starts each room with nobody linked", async () => {
    const ch = await readyRoom("alice", ["alice", "bob"]);
    await status("connected", ROOM, "bob.onion", ["bob.onion"]);
    expect(ch.linkedOnions.value).toEqual(["bob.onion"]);
    await ch.leaveParticipant();
    mockTransport.joinRoom.mockResolvedValueOnce({ room: "room-2", name: "Room Two", onion: "me.onion" });
    await ch.openP2pRoom({ room: "room-2", name: "Room Two" });
    expect(ch.linkedOnions.value).toEqual([]);
  });
});

// ── the members' onions ─────────────────────────────────────────────────────

describe("the members' onions", () => {
  it("are learned from presence and handed to Rust once, debounced, without our own", async () => {
    const ch = await readyRoom("alice", ["alice", "bob", "carol"], "alice.onion");
    await vi.advanceTimersByTimeAsync(1000);
    mockTransport.setPeers.mockClear();
    await presence("bob", "bob.onion");
    await presence("carol", "carol.onion");
    await presence("mallory-echo", "alice.onion"); // our own onion is never a peer
    expect(mockTransport.setPeers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockTransport.setPeers).toHaveBeenCalledTimes(1);
    expect(mockTransport.setPeers).toHaveBeenCalledWith(ROOM, ["bob.onion", "carol.onion"]);
    expect(entry(ch)?.peers).toEqual(["bob.onion", "carol.onion"]);
    expect((await storedRooms())[0].peers).toEqual(["bob.onion", "carol.onion"]);
  });

  it("keep the saved peers whose presence has not arrived yet", async () => {
    await kvPut("p2p:rooms", "default", "", JSON.stringify([
      { room: ROOM, name: "Room One", peers: ["dan.onion"], onion: "me.onion" },
    ]));
    mockTransport.joinRoom.mockResolvedValueOnce({ room: ROOM, name: "Room One", onion: "me.onion" });
    crypto.members.mockResolvedValue(["alice", "bob"]);
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await ch.loadP2pRooms();
    await ch.openP2pRoom(entry(ch)!);
    await vi.advanceTimersByTimeAsync(5000); // nobody answered: a group of one
    expect(ch.mlsStatus.value).toBe("ready");
    mockTransport.setPeers.mockClear();
    await presence("bob", "bob.onion");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockTransport.setPeers).toHaveBeenLastCalledWith(ROOM, ["dan.onion", "bob.onion"]);
  });

  it("drop a member who leaves, so we stop linking to them", async () => {
    const ch = await readyRoom("alice", ["alice", "bob", "carol"]);
    await presence("bob", "bob.onion");
    await presence("carol", "carol.onion");
    await vi.advanceTimersByTimeAsync(1000);
    expect(entry(ch)?.peers).toEqual(["bob.onion", "carol.onion"]);

    await deliver(fromPeer("carol", { type: "leave", device_id: "carol" }));
    expect(entry(ch)?.peers).toEqual(["bob.onion"]);
    expect((await storedRooms())[0].peers).toEqual(["bob.onion"]);
    mockTransport.setPeers.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockTransport.setPeers).toHaveBeenLastCalledWith(ROOM, ["bob.onion"]);
  });

  it("ride our own presence, so the others can link to us", async () => {
    const ch = await readyRoom("alice", ["alice", "bob"], "alice.onion");
    mockTransport.send.mockClear();
    await presence("bob", "bob.onion", false); // not a reply: we answer
    expect(sentInner("presence")).toEqual([
      expect.objectContaining({ device_id: "alice", onion: "alice.onion", reply: true }),
    ]);
    expect(ch.myOnion.value).toBe("alice.onion");
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
    expect(mockTransport.forgetOnion).toHaveBeenCalledWith("Room One");
    expect(ch.p2pRooms.value).toEqual([]);
    expect(await storedRooms()).toEqual([]);
    expect(ch.currentRoom.value).toBeNull();
    expect(notices(ch)).toEqual(["This room was deleted by the host."]);
    await vi.waitFor(async () => expect(await loadLog(ROOM)).toEqual([]));
  });
});

describe("deleting a room", () => {
  it("closes an open room we host for everyone and wipes it", async () => {
    const ch = await readyRoom("alice", ["alice", "bob"]);
    await ch.sendMessage("history to wipe");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => expect(await loadLog(ROOM)).toHaveLength(1));
    mockTransport.send.mockClear();

    await ch.deleteRoom(entry(ch)!);
    expect(sentInner("room_closed")).toEqual([{ type: "room_closed", device_id: "alice" }]);
    expect(crypto.clearState).toHaveBeenLastCalledWith(ROOM, "alice");
    expect(await loadLog(ROOM)).toEqual([]);
    expect(ch.p2pRooms.value).toEqual([]);
    expect(mockTransport.forgetOnion).toHaveBeenCalledWith("Room One");
    expect(ch.currentRoom.value).toBeNull();
    expect(notices(ch)).toEqual(["Room deleted."]);
  });

  it("sends an ordinary leave for a room we only joined", async () => {
    const ch = await readyRoom("alice", ["alice", "bob"]);
    await ch.deleteRoom({ ...entry(ch)!, host: false });
    expect(sentInner("leave")).toEqual([{ type: "leave", device_id: "alice" }]);
    expect(sentInner("room_closed")).toEqual([]);
  });

  it("only stops the connection of a room that is not open, and forgets its onion", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await create(ch, "room-2", "two.onion");
    await create(ch, ROOM);
    await flush();
    const other = entry(ch, "room-2")!;
    mockTransport.send.mockClear();

    await ch.deleteRoom(other);
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(crypto.clearState).toHaveBeenCalledWith("room-2", "alice");
    expect(mockTransport.forgetOnion).toHaveBeenCalledWith("Room Two");
    expect(mockTransport.leaveRoom).toHaveBeenCalledWith("room-2");
    expect(ch.p2pRooms.value.map((r) => r.room)).toEqual([ROOM]);
    expect(ch.currentRoom.value?.slug).toBe(ROOM);
  });
});

// ── invitations ─────────────────────────────────────────────────────────────

describe("admitting an invitee", () => {
  it("adds them, commits to the room first, and grants our onion as the member to link to", async () => {
    const ch = await readyRoom("alice", ["alice"]);
    const grant = await ch.admitInvited(ROOM, "AQID");
    expect(crypto.addMember).toHaveBeenCalledWith(ROOM, "alice", new Uint8Array([1, 2, 3]));
    expect(sent()).toEqual([{ type: "mls_commit", commit: "CQ==" }]);
    expect(grant).toEqual({ welcome: "CA==", roomName: "Room One", peers: ["alice.onion"] });
  });

  it("grants every member's onion we know, ours first, each once", async () => {
    const ch = await readyRoom("alice", ["alice", "bob", "carol", "dave"]);
    await presence("bob", "bob.onion");
    await presence("carol", "carol.onion");
    await presence("dave", ""); // no onion learned yet: nothing to grant
    await presence("echo", "alice.onion");
    mockTransport.send.mockClear();
    const grant = await ch.admitInvited(ROOM, "AQID");
    expect(grant?.peers).toEqual(["alice.onion", "bob.onion", "carol.onion"]);
    expect(grant).not.toHaveProperty("onion");
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
  const grant = () => ({ roomName: "  Room One ", welcome: "CAk=", peers: ["inviter.onion", "carol.onion"] });

  beforeEach(() => {
    mockTransport.joinRoom.mockResolvedValue({ room: ROOM, name: "Room One", onion: "me.onion" });
  });

  it("links to the granted members, moves the scratch session onto the room, and comes up encrypted", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    expect(await ch.joinByInvite(grant(), "invite:scratch")).toBe(true);
    expect(mockTransport.joinRoom).toHaveBeenCalledWith("Room One", ["inviter.onion", "carol.onion"]);
    expect(crypto.adoptSession).toHaveBeenCalledWith("invite:scratch", ROOM, "me");
    expect(crypto.joinFromWelcome).toHaveBeenCalledWith(ROOM, "me", new Uint8Array([8, 9]));
    expect(ch.mlsStatus.value).toBe("ready");
    expect(ch.myOnion.value).toBe("me.onion");
    expect(entry(ch)).toEqual({ room: ROOM, name: "Room One", peers: ["inviter.onion", "carol.onion"], onion: "me.onion" });
    expect(notices(ch)).toEqual([
      "Joined “Room One”. Connecting to the others…",
      "🔒 End-to-end encryption active.",
    ]);
  });

  it("does not start a fresh handshake: the Welcome is the way in", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    await ch.joinByInvite(grant(), "invite:scratch");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(crypto.initSession).not.toHaveBeenCalled();
    expect(crypto.clearState).not.toHaveBeenCalled();
    expect(sent("mls_key_package")).toEqual([]);
    expect(ch.mlsStatus.value).toBe("ready");
    expect(notices(ch).filter((n) => n === "🔒 End-to-end encryption active.")).toHaveLength(1);
  });

  it("is still initializing while the scratch session moves over", async () => {
    let release!: (ok: boolean) => void;
    crypto.adoptSession.mockReturnValueOnce(new Promise<boolean>((r) => { release = r; }));
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    const joining = ch.joinByInvite(grant(), "invite:scratch");
    await flush();
    expect(ch.currentRoom.value?.slug).toBe(ROOM);
    expect(ch.mlsStatus.value).toBe("initializing");
    release(true);
    expect(await joining).toBe(true);
  });

  it("tells Rust the members to link to once it is in", async () => {
    const ch = useChatChannel();
    ch.mlsIdentity.value = "me";
    await ch.joinByInvite(grant(), "invite:scratch");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockTransport.setPeers).toHaveBeenCalledWith(ROOM, ["inviter.onion", "carol.onion"]);
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
    mockTransport.joinRoom.mockRejectedValueOnce(new Error("Network access is off."));
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

describe("deviceId", () => {
  it("returns this device's id, or null when Rust cannot say", async () => {
    const ch = useChatChannel();
    mockTransport.deviceId.mockResolvedValueOnce("device-me");
    expect(await ch.deviceId()).toBe("device-me");
    mockTransport.deviceId.mockResolvedValueOnce(null);
    expect(await ch.deviceId()).toBeNull();
    mockTransport.deviceId.mockRejectedValueOnce(new Error("vault locked"));
    expect(await ch.deviceId()).toBeNull();
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
