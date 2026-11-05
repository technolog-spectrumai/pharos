// Room moderation and meta, captain-authoritative (technology.md §9).
//
// The captain — the lowest live MLS id — owns the room's rules, logo, mutes and
// bans. Every change it makes goes out twice: as the specific action (mod_mute,
// mod_kick…) and as a full revisioned `room_meta` snapshot, so a member that
// missed the action still converges. Receivers check the sender against their
// OWN election before applying anything.
//
// Enforcement is cooperative and client-side, which is exactly why the details
// matter: a mute keyed to the wrong id, or a kick whose notice goes out after the
// removal commit, fails silently for the one person it was aimed at.

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
    addMember: vi.fn(async () => ({ welcome: new Uint8Array([8]), commit: new Uint8Array([9]) })),
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

import { useChatChannel } from "../../src/useChatChannel";
import { bytesToBase64, base64ToBytes } from "../../src/crypto";
import { kvGet, kvPut } from "../../src/services/localDb";
import { loadLog } from "../../src/services/chatLog";

const ROOM = "room-1";
const MIN = 60_000;
type Channel = ReturnType<typeof useChatChannel>;
type Frame = Record<string, unknown>;

const NAMES: Record<string, string> = { alice: "Alice", bob: "Bob", carol: "Carol", zed: "Zed" };

const seal = (inner: unknown) =>
  bytesToBase64(new TextEncoder().encode(typeof inner === "string" ? inner : JSON.stringify(inner)));
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
async function status(state: string, room = ROOM) {
  for (const h of wire.status) h(room, state);
  await flush();
}

const fromPeer = (device: string, inner: unknown): Frame => ({
  type: "mls_app", ciphertext: seal(inner), device_id: device, sender_name: NAMES[device] ?? device,
});
/** A peer announcing itself — the only way we learn its display name. */
const presence = (device: string, reply = true) =>
  deliver(fromPeer(device, { type: "presence", device_id: device, name: NAMES[device] ?? device, avatar: "", onion: "", reply }));

const sent = () => mockTransport.send.mock.calls.map(([, payload]) => payload as Frame);
/** What went out over the encrypted seam, opened, in order. */
const sentInner = (type?: string) =>
  sent()
    .filter((p) => p.type === "mls_app")
    .map(openInner)
    .filter((i): i is Record<string, unknown> => !!i && (!type || i.type === type));
const notices = (ch: Channel) => ch.messages.value.map((m) => m.content);
const bubbles = (ch: Channel) => ch.messages.value.filter((m) => m.participant_type === "human");
const savedEntry = (ch: Channel) => ch.p2pRooms.value.find((r) => r.room === ROOM)!;
const row = (ch: Channel, id: string) => ch.participants.value.find((p) => p.id === id);

/** A ready room. `identity` and the member list decide who the captain is. */
async function room(identity: string, members: string[], onion = "") {
  mockTransport.createRoom.mockResolvedValue({ room: ROOM, name: "Room One", onion });
  crypto.members.mockResolvedValue(members);
  const ch = useChatChannel();
  ch.mlsIdentity.value = identity;
  ch.currentUserName.value = NAMES[identity] ?? identity;
  await ch.createRoom("Room One");
  await status("connected");
  await vi.advanceTimersByTimeAsync(5000);
  expect(ch.mlsStatus.value).toBe("ready");
  for (const m of members) if (m !== identity) await presence(m);
  mockTransport.send.mockClear();
  return ch;
}
/** We are the captain: "alice" sorts first. */
const asCaptain = (members = ["alice", "bob", "carol"]) => room("alice", members);
/** We are an ordinary member: "bob" is the captain. */
const asMember = (members = ["bob", "carol", "zed"]) => room("zed", members);

/** The clock when the test began (room setup itself advances it by 5 s). */
let NOW: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
  NOW = Date.now();
  vi.resetAllMocks();
  wire.message.length = 0;
  wire.status.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── who may act ─────────────────────────────────────────────────────────────

describe("captaincy", () => {
  it("goes to the lowest member id, which is what makes us the captain here", async () => {
    const ch = await asCaptain();
    expect(ch.captainId.value).toBe("alice");
    expect(ch.amCaptain.value).toBe(true);
    expect(ch.participants.value.map((p) => [p.id, p.isCaptain])).toEqual([
      ["alice", true], ["bob", false], ["carol", false],
    ]);
  });

  it("leaves an ordinary member unable to change anything", async () => {
    const ch = await asMember();
    expect(ch.captainId.value).toBe("bob");
    await ch.setRoomRules("my rules now");
    await ch.setRoomLogo(new File(["x"], "logo.png"));
    await ch.muteMember("carol", 5);
    await ch.unmuteMember("carol");
    await ch.kickMember("carol");
    await ch.unbanMember("carol");
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(crypto.removeMember).not.toHaveBeenCalled();
    expect(ch.roomRules.value).toBe("");
    expect(ch.bans.value).toEqual([]);
  });
});

// ── captain actions ─────────────────────────────────────────────────────────

describe("the captain's rules and logo", () => {
  it("trims the rules, saves them with the room, and broadcasts a new revision", async () => {
    const ch = await asCaptain();
    await ch.setRoomRules("  be kind  ");
    expect(ch.roomRules.value).toBe("be kind");
    expect(savedEntry(ch)).toMatchObject({ rules: "be kind", metaRev: 1 });
    // Persisted, not only held: a future captain needs it after a restart.
    const stored = JSON.parse((await kvGet("p2p:rooms", "default", ""))!);
    expect(stored[0]).toMatchObject({ room: ROOM, rules: "be kind", metaRev: 1 });
    expect(sentInner("room_meta")).toEqual([
      { type: "room_meta", device_id: "alice", logo: "", rules: "be kind", mutes: {}, bans: [], rev: 1 },
    ]);

    await ch.setRoomRules("   ");
    expect(ch.roomRules.value).toBe("");
    expect(savedEntry(ch).rules).toBeUndefined();
    expect(sentInner("room_meta").at(-1)).toMatchObject({ rules: "", rev: 2 });
  });

  it("sets a small logo and clears it again", async () => {
    const ch = await asCaptain();
    await ch.setRoomLogo(new File(["logo"], "logo.png", { type: "image/png" }));
    expect(ch.roomLogo.value).toBe("data:image/png;base64,bG9nbw==");
    expect(savedEntry(ch).logo).toBe(ch.roomLogo.value);
    expect(sentInner("room_meta").at(-1)).toMatchObject({ logo: ch.roomLogo.value, rev: 1 });

    await ch.setRoomLogo(null);
    expect(ch.roomLogo.value).toBe("");
    expect(savedEntry(ch).logo).toBeUndefined();
    expect(sentInner("room_meta").at(-1)).toMatchObject({ logo: "", rev: 2 });
  });
});

describe("muting", () => {
  it("keys the mute by user, so it covers every device, and badges the roster", async () => {
    const ch = await asCaptain();
    const until = Date.now() + 5 * MIN;
    await ch.muteMember("bob#dev-abcdefgh", 5);
    // The specific action first, then the snapshot that carries it.
    expect(sentInner()).toEqual([
      { type: "mod_mute", device_id: "alice", target: "bob", until },
      expect.objectContaining({ type: "room_meta", mutes: { bob: until }, rev: 1 }),
    ]);
    expect(savedEntry(ch).mutes).toEqual({ bob: until });
    expect(notices(ch).at(-1)).toBe("🔇 Bob was muted for 5m.");
    await flush();
    expect(row(ch, "bob")?.muteUntil).toBe(until);
    // Keyed by user, it also silences a device of bob's it never named.
    await deliver(fromPeer("bob#dev-zyxwvuts", "from my other device"));
    expect(bubbles(ch)).toHaveLength(0);
  });

  it("refuses to mute ourselves, on this or any other of our devices", async () => {
    const ch = await asCaptain();
    await ch.muteMember("alice", 5);
    await ch.muteMember("alice#dev-abcdefgh", 5);
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(ch.selfMuteUntil.value).toBeNull();
  });

  it("drops a muted member's messages but keeps routing their control traffic", async () => {
    // Muting someone must not also break their file offers or call signalling.
    const ch = await asCaptain();
    const routed: string[] = [];
    ch.onSync((type) => routed.push(type));
    await ch.muteMember("bob", 5);
    await deliver(fromPeer("bob", "can you hear me"));
    await deliver(fromPeer("bob", { type: "file_offer", id: "f1" }));
    expect(bubbles(ch)).toHaveLength(0);
    expect(routed).toEqual(["file_offer"]);
    await deliver(fromPeer("carol", "I am not muted"));
    expect(bubbles(ch).map((m) => m.user)).toEqual(["Carol"]);
  });

  it("lifts by itself when it expires", async () => {
    const ch = await asCaptain();
    const until = Date.now() + MIN;
    await ch.muteMember("bob", 1);
    await flush();
    expect(row(ch, "bob")?.muteUntil).toBe(until);

    await vi.advanceTimersByTimeAsync(75_000); // the mute clock ticks every 15 s
    expect(row(ch, "bob")?.muteUntil).toBeUndefined();
    expect(savedEntry(ch).mutes).toEqual({});
    await deliver(fromPeer("bob", "back again"));
    expect(bubbles(ch).map((m) => m.content)).toEqual(["back again"]);
  });

  it("can be lifted early, and lifting a mute that does not exist sends nothing", async () => {
    const ch = await asCaptain();
    await ch.muteMember("bob", 60);
    mockTransport.send.mockClear();
    await ch.unmuteMember("bob#dev-abcdefgh");
    expect(sentInner()).toEqual([
      { type: "mod_unmute", device_id: "alice", target: "bob" },
      expect.objectContaining({ type: "room_meta", mutes: {}, rev: 2 }),
    ]);
    expect(notices(ch).at(-1)).toBe("🔊 Bob was unmuted.");

    mockTransport.send.mockClear();
    await ch.unmuteMember("carol");
    expect(mockTransport.send).not.toHaveBeenCalled();
  });
});

describe("kicking", () => {
  it("warns the target before cutting it off, then removes every one of its devices", async () => {
    // The notice and snapshot must go out while the target can still decrypt
    // them; after the removal commit it cannot read anything at all.
    const ch = await asCaptain(["alice", "bob", "bob#dev-abcdefgh", "carol"]);
    crypto.removeMember.mockResolvedValueOnce(new Uint8Array([1])).mockResolvedValueOnce(new Uint8Array([2]));
    await ch.kickMember("bob");

    expect(sent().map((p) => (p.type === "mls_app" ? openInner(p)?.type : p.type))).toEqual([
      "mod_kick", "room_meta", "mls_commit", "mls_commit",
    ]);
    expect(sentInner("mod_kick")).toEqual([{ type: "mod_kick", device_id: "alice", target: "bob" }]);
    expect(sent().filter((p) => p.type === "mls_commit")).toEqual([
      { type: "mls_commit", commit: "AQ==" },
      { type: "mls_commit", commit: "Ag==" },
    ]);
    expect(crypto.removeMember.mock.calls).toEqual([
      [ROOM, "alice", "bob"],
      [ROOM, "alice", "bob#dev-abcdefgh"],
    ]);
    expect(ch.bans.value).toEqual(["bob"]);
    expect(savedEntry(ch).bans).toEqual(["bob"]);
    expect(notices(ch).at(-1)).toMatch(/^🚫 \S+ was removed from the room\.$/);
  });

  it("still removes the id it was given when the group no longer lists that user", async () => {
    const ch = await asCaptain(["alice", "carol"]);
    await ch.kickMember("dave");
    expect(crypto.removeMember).toHaveBeenCalledWith(ROOM, "alice", "dave");
    expect(ch.bans.value).toEqual(["dave"]);
  });

  it("can be undone with an unban, which the room hears about", async () => {
    const ch = await asCaptain();
    await ch.kickMember("bob");
    mockTransport.send.mockClear();
    await ch.unbanMember("bob");
    expect(ch.bans.value).toEqual([]);
    expect(sentInner()).toEqual([expect.objectContaining({ type: "room_meta", bans: [], rev: 2 })]);

    mockTransport.send.mockClear();
    await ch.unbanMember("nobody");
    expect(mockTransport.send).not.toHaveBeenCalled();
  });
});

// ── what a member receives ──────────────────────────────────────────────────

describe("moderation from the captain", () => {
  it("locks our composer while we are muted, with the time left", async () => {
    const ch = await asMember();
    await deliver(fromPeer("bob", { type: "mod_mute", device_id: "bob", target: "zed", until: NOW + 10 * MIN }));
    expect(notices(ch).at(-1)).toBe("🔇 You were muted for 10m.");
    expect(ch.selfMuteUntil.value).toBe(NOW + 10 * MIN);

    mockTransport.send.mockClear();
    await ch.sendMessage("let me speak");
    await ch.sendImage(new File(["x"], "a.png"));
    await ch.sendAudio(new Blob(["x"]));
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(ch.messages.value.at(-1)).toMatchObject({
      type: "system_error", content: "🔇 You are muted for another 10m.",
    });
  });

  it("names another muted member and lifts the mute on an unmute", async () => {
    const ch = await asMember();
    await deliver(fromPeer("bob", { type: "mod_mute", device_id: "bob", target: "carol", until: NOW + 90 * MIN }));
    expect(notices(ch).at(-1)).toBe("🔇 Carol was muted for 1h 30m.");
    await flush();
    expect(row(ch, "carol")?.muteUntil).toBe(NOW + 90 * MIN);

    await deliver(fromPeer("bob", { type: "mod_unmute", device_id: "bob", target: "carol" }));
    expect(notices(ch).at(-1)).toBe("🔊 Carol was unmuted.");
    await flush();
    expect(row(ch, "carol")?.muteUntil).toBeUndefined();
  });

  it("is ignored when it comes from anyone but the elected captain", async () => {
    const ch = await asMember();
    const before = notices(ch).length;
    await deliver(fromPeer("carol", { type: "mod_mute", device_id: "carol", target: "zed", until: NOW + MIN }));
    await deliver(fromPeer("carol", { type: "mod_kick", device_id: "carol", target: "zed" }));
    expect(ch.selfMuteUntil.value).toBeNull();
    expect(ch.currentRoom.value?.slug).toBe(ROOM);
    expect(notices(ch)).toHaveLength(before);
  });

  it("ignores a mute that has already expired, and an unmute for nobody muted", async () => {
    const ch = await asMember();
    const before = notices(ch).length;
    await deliver(fromPeer("bob", { type: "mod_mute", device_id: "bob", target: "zed", until: NOW - 1 }));
    await deliver(fromPeer("bob", { type: "mod_unmute", device_id: "bob", target: "carol" }));
    expect(ch.selfMuteUntil.value).toBeNull();
    expect(notices(ch)).toHaveLength(before);
  });

  it("bans a kicked member and forgets their presence", async () => {
    const ch = await asMember();
    await deliver(fromPeer("bob", { type: "mod_kick", device_id: "bob", target: "carol" }));
    expect(ch.bans.value).toEqual(["carol"]);
    expect(savedEntry(ch).bans).toEqual(["carol"]);
    expect(notices(ch).at(-1)).toMatch(/^🚫 \S+ was removed from the room\.$/);
    // With the presence gone, the roster falls back to the bare id.
    await flush();
    expect(row(ch, "carol")?.name).toBe("carol");
  });

  it("wipes the room on our side when we are the one kicked", async () => {
    const ch = await room("zed", ["bob", "zed"], "zed.onion");
    await ch.sendMessage("last words");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => expect(await loadLog(ROOM)).toHaveLength(1));

    await deliver(fromPeer("bob", { type: "mod_kick", device_id: "bob", target: "zed" }));
    expect(crypto.clearState).toHaveBeenLastCalledWith(ROOM, "zed");
    expect(mockTransport.forgetTorOnion).toHaveBeenCalledWith("Room One");
    expect(mockTransport.leaveRoom).toHaveBeenCalledWith(ROOM);
    expect(ch.p2pRooms.value).toEqual([]);
    expect(ch.currentRoom.value).toBeNull();
    expect(notices(ch)).toEqual(["🚫 You were removed from this room by the host."]);
    await vi.waitFor(async () => expect(await loadLog(ROOM)).toEqual([]));
  });
});

// ── snapshots ───────────────────────────────────────────────────────────────

describe("a meta snapshot", () => {
  it("is sanitised before it applies, and announces rules only when they change", async () => {
    const ch = await asMember();
    const snapshot = {
      type: "room_meta", device_id: "bob", rev: 3,
      logo: 42, // not a string: no logo rather than "42"
      rules: "  rules  ",
      mutes: { carol: NOW + MIN, stale: NOW - 1, junk: "soon" },
      bans: ["dave", 7, null],
    };
    await deliver(fromPeer("bob", snapshot));
    expect(ch.roomLogo.value).toBe("");
    expect(ch.roomRules.value).toBe("rules");
    expect(ch.bans.value).toEqual(["dave"]);
    expect(savedEntry(ch).mutes).toEqual({ carol: NOW + MIN });
    expect(notices(ch).at(-1)).toBe("📜 Room rules:\nrules");

    // Re-applying the same snapshot is idempotent — no second announcement.
    await deliver(fromPeer("bob", snapshot));
    expect(notices(ch).filter((n) => n.startsWith("📜"))).toHaveLength(1);
  });

  it("is shared by any holder when a member first announces itself", async () => {
    // The joiner converges even if the captain just changed or is offline;
    // receivers dedupe by revision, so the redundant copies are harmless.
    const ch = await asMember();
    await deliver(fromPeer("bob", { type: "room_meta", device_id: "bob", rev: 3, rules: "r" }));
    expect(ch.roomRules.value).toBe("r");
    mockTransport.send.mockClear();

    await presence("carol", false);
    expect(sentInner("room_meta")).toEqual([expect.objectContaining({ device_id: "zed", rules: "r", rev: 3 })]);
    expect(sentInner("presence")).toEqual([expect.objectContaining({ device_id: "zed", name: "Zed", reply: true })]);

    // A reply is not an announcement: answering it would start an echo storm.
    mockTransport.send.mockClear();
    await presence("carol", true);
    expect(mockTransport.send).not.toHaveBeenCalled();
  });

  it("is taken from anyone but the captain only when it is strictly newer", async () => {
    // The captain's copy re-applies at an equal revision. Anyone else's copy
    // at that revision is a rival version of the same state, not a handover.
    const ch = await asMember();
    await deliver(fromPeer("bob", { type: "room_meta", device_id: "bob", rev: 3, rules: "from the captain" }));
    await deliver(fromPeer("carol", { type: "room_meta", device_id: "carol", rev: 3, rules: "rival" }));
    expect(ch.roomRules.value).toBe("from the captain");

    await deliver(fromPeer("carol", { type: "room_meta", device_id: "carol", rev: 4, rules: "handed over" }));
    expect(ch.roomRules.value).toBe("handed over");
  });

  it("handed over by the previous holder is re-broadcast by the new captain as its own", async () => {
    const ch = await asCaptain();
    await deliver(fromPeer("bob", { type: "room_meta", device_id: "bob", rev: 5, rules: "handed over" }));
    expect(ch.roomRules.value).toBe("handed over");
    expect(sentInner("room_meta")).toEqual([
      expect.objectContaining({ device_id: "alice", rules: "handed over", rev: 5 }),
    ]);
  });
});

describe("moderation saved with the room", () => {
  it("comes back when the room is reopened, and outranks an older snapshot", async () => {
    await kvPut("p2p:rooms", "default", "", JSON.stringify([{
      room: ROOM, name: "Room One", peers: ["node-b"],
      rules: "saved rules", logo: "data:logo", metaRev: 4, bans: ["dave"],
      mutes: { bob: NOW + MIN, carol: NOW - 1 },
    }]));
    mockTransport.joinRoomByNode.mockResolvedValue({ room: ROOM, name: "Room One", onion: "" });
    crypto.members.mockResolvedValue(["bob", "zed"]);
    const ch = useChatChannel();
    ch.mlsIdentity.value = "zed";
    await ch.loadP2pRooms();
    await ch.openP2pRoom(ch.p2pRooms.value[0]);
    expect(ch.roomRules.value).toBe("saved rules");
    expect(ch.roomLogo.value).toBe("data:logo");
    expect(ch.bans.value).toEqual(["dave"]);

    // Get the session ready, then replay an older captain snapshot.
    await status("connected");
    await vi.advanceTimersByTimeAsync(5000);
    await deliver(fromPeer("bob", { type: "room_meta", device_id: "bob", rev: 3, rules: "older" }));
    expect(ch.roomRules.value).toBe("saved rules");
    // The saved mute still holds for bob; carol's had expired before we arrived.
    await deliver(fromPeer("bob", "muted words"));
    expect(bubbles(ch)).toHaveLength(0);
    expect(row(ch, "bob")?.muteUntil).toBe(NOW + MIN);
  });
});
