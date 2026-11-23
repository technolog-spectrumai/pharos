// The MLS envelope state machine: key package → Welcome / commit → application
// traffic, plus the two ways a session starts over (a reset, a mismatch).
//
// The crypto itself is Rust's; what lives here is the choreography — who sends
// which envelope when, and what state the channel lands in when a step fails.
// Each failure must end somewhere a user can see and recover from: a channel left
// "initializing" or "key_exchange" with no notice is indistinguishable from a bug.
//
// The admin split (who adds, who defers) only runs on HEADLESS channels now —
// a normal room refuses gossip key packages outright (inviteOnly.test.ts) — so
// that is where it is pinned.

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

import { useChatChannel, type ChatChannelOptions } from "../../src/useChatChannel";
import { memKv } from "../../src/fakes";

const ROOM = "room-1";
type Channel = ReturnType<typeof useChatChannel>;
type Frame = Record<string, unknown>;

const flush = () => vi.advanceTimersByTimeAsync(0);

async function deliver(data: Frame, room = ROOM) {
  for (const h of wire.message) h(room, data);
  await flush();
}
async function status(state: string, room = ROOM, peerId?: string, linked: string[] = []) {
  for (const h of wire.status) h(room, state, peerId, linked);
  await flush();
}

const sent = (type?: string) =>
  mockTransport.send.mock.calls
    .map(([, payload]) => payload as Frame)
    .filter((p) => !type || p.type === type);
const notices = (ch: Channel) => ch.messages.value.map((m) => m.content);
const count = (ch: Channel, text: string) => notices(ch).filter((n) => n === text).length;

const ENCRYPTED = "🔒 End-to-end encryption active.";

/** A saved room reopened: entered, key package sent, waiting for someone to
 *  answer. No status event is needed — encryption starts on entry. */
async function negotiating(identity = "alice", opts: ChatChannelOptions = {}) {
  mockTransport.joinRoom.mockResolvedValue({ room: ROOM, name: "Room One", onion: `${identity}.onion` });
  const ch = useChatChannel(opts);
  ch.mlsIdentity.value = identity;
  ch.currentUserName.value = identity[0].toUpperCase() + identity.slice(1);
  await ch.openP2pRoom({ room: ROOM, name: "Room One" });
  await flush();
  return ch;
}

/** …and then nobody else turned up, so the lone member's group is ready. */
async function ready(identity = "alice", opts: ChatChannelOptions = {}) {
  const ch = await negotiating(identity, opts);
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

// ── starting a session ──────────────────────────────────────────────────────

describe("starting the session", () => {
  it("announces a key package with everything a peer needs to answer it", async () => {
    const ch = await negotiating();
    // The session is kept: never wiped before it is opened.
    expect(crypto.clearState).not.toHaveBeenCalled();
    expect(crypto.initSession).toHaveBeenCalledWith(ROOM, "alice");
    expect(sent("mls_key_package")).toEqual([
      { type: "mls_key_package", key_package: "AQID", package: "AQID", device_id: "alice", user: "Alice" },
    ]);
    expect(ch.mlsStatus.value).toBe("key_exchange");
    expect(notices(ch)).toContain("🔑 Setting up encryption…");
  });

  it("starts on entry, before and without any link coming up", async () => {
    const ch = await negotiating();
    expect(ch.wsStatus.value).toBe("waiting");
    expect(sent("mls_key_package")).toHaveLength(1);
    expect(ch.mlsStatus.value).toBe("key_exchange");
  });

  it("makes a room we just created a group of one at once", async () => {
    mockTransport.createRoom.mockResolvedValue({ room: ROOM, name: "Room One", onion: "alice.onion" });
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await ch.createRoom("Room One");
    await flush();
    expect(sent("mls_key_package")).toHaveLength(1);
    expect(ch.mlsStatus.value).toBe("ready");
    expect(count(ch, ENCRYPTED)).toBe(1);
  });

  it("waits 5 s before a reopened room with nobody answering becomes a group of one", async () => {
    const ch = await negotiating();
    await vi.advanceTimersByTimeAsync(4999);
    expect(ch.mlsStatus.value).toBe("key_exchange");
    await vi.advanceTimersByTimeAsync(1);
    expect(ch.mlsStatus.value).toBe("ready");
  });

  it("comes straight back, with no key package, in a room this device was let into", async () => {
    const storage = memKv();
    await storage.put("chat:admitted", ROOM, "v", "1");
    crypto.initSession.mockResolvedValueOnce(true); // the session was restored
    const ch = await negotiating("alice", { storage });
    expect(ch.mlsStatus.value).toBe("ready");
    expect(sent("mls_key_package")).toHaveLength(0);
    expect(count(ch, ENCRYPTED)).toBe(1);
  });

  it("starts a fresh handshake when a restored session was never let in", async () => {
    crypto.initSession.mockResolvedValueOnce(true);
    const ch = await negotiating("alice", { storage: memKv() });
    expect(ch.mlsStatus.value).toBe("key_exchange");
    expect(sent("mls_key_package")).toHaveLength(1);
  });

  it("marks the room admitted once its group is ready, whatever keepSession says", async () => {
    const storage = memKv();
    await ready("alice", { storage, keepSession: false });
    expect(await storage.get("chat:admitted", ROOM, "v")).toBe("1");
  });

  it("reports an init failure, which a status event does not retry but reopening does", async () => {
    // "error" is a state startMls may restart from — unlike "initializing" — so
    // reopening the room is a retry rather than a dead end. A link coming up is
    // not: encryption is started by entering a room, never by a status.
    crypto.initSession.mockRejectedValueOnce(new Error("vault locked"));
    const ch = await negotiating();
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.mlsError.value).toBe("vault locked");
    expect(ch.messages.value.at(-1)).toMatchObject({
      type: "system_error", content: "Encryption init failed: vault locked",
    });

    await status("connected", ROOM, "bob.onion", ["bob.onion"]);
    expect(ch.mlsStatus.value).toBe("error");
    expect(sent("mls_key_package")).toHaveLength(0);

    await ch.leaveParticipant();
    await ch.openP2pRoom({ room: ROOM, name: "Room One" });
    await flush();
    expect(ch.mlsStatus.value).toBe("key_exchange");
    expect(ch.mlsError.value).toBeNull();
    expect(sent("mls_key_package")).toHaveLength(1);
  });

  it("does not restart a session that is already negotiating", async () => {
    const ch = await negotiating();
    await status("connected", ROOM, "bob.onion", ["bob.onion"]);
    expect(sent("mls_key_package")).toHaveLength(1);
    expect(ch.mlsStatus.value).toBe("key_exchange");
  });

  it("stops a start that was still in flight when the room was left", async () => {
    // Encryption starts on entry, so leaving straight away races it: the late
    // half must neither speak in the empty view nor claim a group.
    let release!: (v: boolean) => void;
    crypto.initSession.mockReturnValueOnce(new Promise<boolean>((r) => { release = r; }));
    mockTransport.joinRoom.mockResolvedValue({ room: ROOM, name: "Room One", onion: "alice.onion" });
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await ch.openP2pRoom({ room: ROOM, name: "Room One" });
    await ch.leaveParticipant();
    release(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent("mls_key_package")).toEqual([]);
    expect(ch.messages.value).toEqual([]);
    expect(ch.mlsStatus.value).toBe("idle");
  });

  it("never sends a key package built for one room into the next one opened", async () => {
    let release!: (v: boolean) => void;
    crypto.initSession.mockReturnValueOnce(new Promise<boolean>((r) => { release = r; }));
    mockTransport.joinRoom
      .mockResolvedValueOnce({ room: ROOM, name: "Room One", onion: "alice.onion" })
      .mockResolvedValueOnce({ room: "room-2", name: "Room Two", onion: "alice2.onion" });
    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    await ch.openP2pRoom({ room: ROOM, name: "Room One" });
    await ch.openP2pRoom({ room: "room-2", name: "Room Two" }); // before room one's start finished
    await flush();
    release(false); // room one's initSession comes back late
    await flush();
    const kpRooms = mockTransport.send.mock.calls
      .filter(([, p]) => (p as Frame).type === "mls_key_package")
      .map(([room]) => room);
    expect(kpRooms).toEqual(["room-2"]);
    expect(crypto.keyPackage.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["room-2"]);
    expect(ch.mlsStatus.value).toBe("key_exchange");
    expect(count(ch, "🔑 Setting up encryption…")).toBe(1);
  });

  it("declares no lone group for a room that was left while negotiating", async () => {
    // Leaving does not cancel the creator timer. When it fires it has to find
    // the negotiation over and say nothing, or a closed room comes back as
    // "ready" with an encryption notice over an empty view.
    const ch = await negotiating();
    await ch.leaveParticipant();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ch.mlsStatus.value).toBe("idle");
    expect(count(ch, ENCRYPTED)).toBe(0);
  });
});

// ── the Welcome ─────────────────────────────────────────────────────────────

describe("a Welcome", () => {
  it("joins the group while negotiating, and the creator timer does not announce twice", async () => {
    const ch = await negotiating();
    await deliver({ type: "mls_welcome", welcome: "CAk=" });
    expect(crypto.joinFromWelcome).toHaveBeenCalledWith(ROOM, "alice", new Uint8Array([8, 9]));
    expect(ch.mlsStatus.value).toBe("ready");
    expect(notices(ch)).toContain("🔑 Received group invitation — joining encrypted group…");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count(ch, ENCRYPTED)).toBe(1);
  });

  it("that will not open is an error rather than a silent hang", async () => {
    crypto.joinFromWelcome.mockResolvedValueOnce(false);
    const ch = await negotiating();
    await deliver({ type: "mls_welcome", welcome: "CAk=" });
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.mlsError.value).toBe("Failed to join encrypted group.");
    expect(ch.messages.value.at(-1)).toMatchObject({ type: "system_error", content: "Failed to join encrypted group." });
  });

  it("is ignored once the group is ready", async () => {
    const ch = await ready();
    await deliver({ type: "mls_welcome", welcome: "CAk=" });
    expect(crypto.joinFromWelcome).not.toHaveBeenCalled();
    expect(ch.mlsStatus.value).toBe("ready");
  });
});

// ── commits ─────────────────────────────────────────────────────────────────

describe("a commit", () => {
  it("is applied to a ready group, and the roster follows the new membership", async () => {
    const ch = await ready();
    crypto.members.mockResolvedValue(["alice", "bob", "carol"]);
    await deliver({ type: "mls_commit", commit: "CQ==" });
    expect(crypto.processMessage).toHaveBeenCalledWith(ROOM, "alice", new Uint8Array([9]));
    expect(ch.participants.value.map((p) => p.id)).toEqual(["alice", "bob", "carol"]);
    expect(ch.currentRoom.value?.participant_count).toBe(3);
  });

  it("from another group sends a fresh key package", async () => {
    const ch = await ready();
    crypto.processMessage.mockRejectedValueOnce(new Error("Group ID differs"));
    await deliver({ type: "mls_commit", commit: "CQ==" });
    expect(sent("mls_key_package")).toHaveLength(1);
    expect(ch.mlsStatus.value).toBe("key_exchange");
  });

  it("that fails for any other reason puts the session in error with the reason", async () => {
    const ch = await ready();
    crypto.processMessage.mockRejectedValueOnce(new Error("wrong epoch"));
    await deliver({ type: "mls_commit", commit: "CQ==" });
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.mlsError.value).toBe("wrong epoch");
    expect(notices(ch).at(-1)).toBe("Could not process MLS commit: wrong epoch");
  });

  it("is not processed before the group exists", async () => {
    await negotiating();
    await deliver({ type: "mls_commit", commit: "CQ==" });
    expect(crypto.processMessage).not.toHaveBeenCalled();
  });
});

// ── resets ──────────────────────────────────────────────────────────────────

describe("a reset requested by a peer", () => {
  const reset = (resetId: string, device = "bob") => ({ type: "mls_reset_request", device_id: device, reset_id: resetId });

  it("clears our history and starts a new group without broadcasting another reset", async () => {
    const ch = await ready();
    await deliver(reset("r-1"));
    expect(notices(ch)).toEqual(["🔄 Session reset — history cleared.", "🔑 Fresh key package sent."]);
    expect(sent("mls_reset_request")).toHaveLength(0);
    expect(sent("mls_key_package")).toEqual([
      { type: "mls_key_package", key_package: "AQID", package: "AQID", device_id: "alice", user: "Alice" },
    ]);
    expect(ch.mlsStatus.value).toBe("key_exchange");

    await vi.advanceTimersByTimeAsync(5000);
    expect(ch.mlsStatus.value).toBe("ready");
    expect(notices(ch).at(-1)).toBe("🔒 New encryption group created.");
  });

  it("is honoured once per reset id, and again after the dedupe window", async () => {
    // Relayed copies of one request must not reset the session over and over.
    const ch = await ready();
    crypto.clearState.mockClear();
    await deliver(reset("r-1"));
    await deliver(reset("r-1"));
    expect(crypto.clearState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await deliver(reset("r-1"));
    expect(crypto.clearState).toHaveBeenCalledTimes(2);
    expect(ch.mlsStatus.value).toBe("key_exchange");
  });

  it("is ignored when it is our own request echoed back", async () => {
    const ch = await ready();
    crypto.clearState.mockClear();
    await deliver(reset("r-9", "alice"));
    expect(crypto.clearState).not.toHaveBeenCalled();
    expect(ch.mlsStatus.value).toBe("ready");
  });
});

describe("forceResetMls", () => {
  it("broadcasts a reset request and does not act on its own request relayed back", async () => {
    const ch = await ready();
    await ch.forceResetMls();
    const [request] = sent("mls_reset_request");
    expect(request).toEqual({ type: "mls_reset_request", device_id: "alice", reset_id: expect.any(String) });
    expect(ch.mlsStatus.value).toBe("key_exchange");

    crypto.clearState.mockClear();
    await deliver({ ...request, device_id: "bob" });
    expect(crypto.clearState).not.toHaveBeenCalled();
  });

  it("says so when no key package can be built", async () => {
    const ch = await ready();
    crypto.keyPackage.mockResolvedValueOnce(null);
    await ch.forceResetMls();
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.messages.value.at(-1)).toMatchObject({ type: "system_error", content: "Failed to generate key package." });
  });

  it("reports why a reset failed", async () => {
    const ch = await ready();
    crypto.clearState.mockRejectedValueOnce(new Error("disk full"));
    await ch.forceResetMls();
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.mlsError.value).toBe("disk full");
    expect(notices(ch).at(-1)).toBe("Reset failed: disk full");
  });

  it("does nothing with no room open", async () => {
    const ch = useChatChannel();
    await ch.forceResetMls();
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(ch.mlsStatus.value).toBe("idle");
  });
});

// ── the admin split (headless channels) ─────────────────────────────────────

describe("a key package on a headless channel", () => {
  const kp = (device: string, extra: Frame = {}) => ({
    type: "mls_key_package", key_package: "AQID", device_id: device, sender_channel: `chan-${device}`, ...extra,
  });

  it("is added by the lower identity, which commits first and addresses the Welcome", async () => {
    // Existing members must see the commit before the newcomer starts talking.
    const ch = await ready("alice", { headless: true });
    await deliver(kp("bob"));
    expect(crypto.addMember).toHaveBeenCalledWith(ROOM, "alice", new Uint8Array([1, 2, 3]));
    expect(sent()).toEqual([
      { type: "mls_commit", commit: "CQ==" },
      { type: "mls_welcome", welcome: "CA==", target_channel: "chan-bob" },
    ]);
    expect(notices(ch).at(-1)).toBe(ENCRYPTED);
  });

  it("is answered by the higher identity with its own key package, addressed to the sender", async () => {
    const ch = await ready("zed", { headless: true });
    await deliver(kp("bob"));
    expect(crypto.addMember).not.toHaveBeenCalled();
    expect(sent()).toEqual([{
      type: "mls_key_package", key_package: "AQID", package: "AQID",
      device_id: "zed", user: "Zed", target_channel: "chan-bob",
    }]);
    expect(ch.mlsStatus.value).toBe("key_exchange");
  });

  it("adds a device once even when its key package arrives twice", async () => {
    await ready("alice", { headless: true });
    await deliver(kp("bob"));
    await deliver(kp("bob"));
    expect(crypto.addMember).toHaveBeenCalledTimes(1);
  });

  it("lets a device try again after an add that failed", async () => {
    await ready("alice", { headless: true });
    crypto.addMember.mockResolvedValueOnce(null);
    await deliver(kp("bob"));
    expect(sent("mls_welcome")).toHaveLength(0);
    await deliver(kp("bob"));
    expect(crypto.addMember).toHaveBeenCalledTimes(2);
    expect(sent("mls_welcome")).toHaveLength(1);
  });

  it("must pass the admission check before anything else happens", async () => {
    const admissionCheck = vi.fn(async (data: Record<string, unknown>) => data.proof === "ok");
    await ready("alice", { headless: true, admissionCheck });
    await deliver(kp("bob"));
    expect(admissionCheck).toHaveBeenCalledWith(expect.objectContaining({ device_id: "bob" }));
    expect(crypto.addMember).not.toHaveBeenCalled();
    expect(mockTransport.send).not.toHaveBeenCalled();

    await deliver(kp("bob", { proof: "ok" }));
    expect(crypto.addMember).toHaveBeenCalledTimes(1);
  });
});

describe("keyPackageExtra", () => {
  it("decorates every key package this channel sends", async () => {
    const keyPackageExtra = vi.fn(async (b64: string) => ({ proof: `hmac(${b64})` }));
    const ch = await negotiating("zed", { headless: true, keyPackageExtra });
    expect(sent("mls_key_package")[0]).toMatchObject({ device_id: "zed", proof: "hmac(AQID)" });

    // The deferring answer carries it too, or the other side's check refuses it.
    await vi.advanceTimersByTimeAsync(5000);
    mockTransport.send.mockClear();
    await deliver({ type: "mls_key_package", key_package: "AQID", device_id: "bob" });
    expect(sent("mls_key_package")[0]).toMatchObject({ device_id: "zed", proof: "hmac(AQID)" });
    expect(ch.mlsStatus.value).toBe("key_exchange");
  });

  it("degrades to a bare envelope when the decorator throws", async () => {
    const keyPackageExtra = vi.fn(async () => {
      throw new Error("no link key");
    });
    await negotiating("alice", { headless: true, keyPackageExtra });
    const [frame] = sent("mls_key_package");
    expect(frame).toEqual({
      type: "mls_key_package", key_package: "AQID", package: "AQID", device_id: "alice", user: "Alice",
    });
  });
});
