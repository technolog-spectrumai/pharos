// What a chat channel puts on the timeline: what it receives, what it sends, and
// what it keeps.
//
// Every inbound human message rides the MLS seam as an `mls_app` frame, and the
// plaintext inside decides what it becomes — a text bubble, a media card, a
// map-share placeholder, or control traffic that must never reach the timeline at
// all. Getting that routing wrong is not cosmetic: a control frame rendered as a
// bubble leaks raw JSON into a room and into its persisted log.
//
// The MLS mock here is TRANSPARENT — "ciphertext" is just the plaintext's bytes —
// so what this client encrypts is exactly what a peer would decrypt, and a test
// can open what was sent. The kv is the real localStorage-backed one, so the
// persisted log the channel writes is the one `loadLog` reads back.

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

import { useChatChannel, downscaleImageToDataUrl } from "../../src/useChatChannel";
import { bytesToBase64, base64ToBytes } from "../../src/crypto";
import { appendMessages, loadLog } from "../../src/services/chatLog";
import type { PersistedMessage } from "../../src/chatHistoryModel";

const ROOM = "room-1";
type Channel = ReturnType<typeof useChatChannel>;
type Frame = Record<string, unknown>;

const seal = (inner: unknown) =>
  bytesToBase64(new TextEncoder().encode(typeof inner === "string" ? inner : JSON.stringify(inner)));
const open = (frame: Frame) => new TextDecoder().decode(base64ToBytes(frame.ciphertext as string));

const flush = () => vi.advanceTimersByTimeAsync(0);

async function deliver(data: Frame, room = ROOM) {
  for (const h of wire.message) h(room, data);
  await flush();
}
async function status(state: string, room = ROOM) {
  for (const h of wire.status) h(room, state);
  await flush();
}

/** A peer's encrypted frame, as the transport would hand it over. */
const fromPeer = (device: string, inner: unknown, extra: Frame = {}): Frame => ({
  type: "mls_app",
  ciphertext: seal(inner),
  device_id: device,
  sender_name: device === "bob" ? "Bob" : device,
  ...extra,
});

const sent = (type?: string) =>
  mockTransport.send.mock.calls
    .map(([, payload]) => payload as Frame)
    .filter((p) => !type || p.type === type);
const bubbles = (ch: Channel) => ch.messages.value.filter((m) => m.participant_type === "human");
const notices = (ch: Channel) => ch.messages.value.map((m) => m.content);

/** An open room whose MLS session is ready — the lone-creator path, end to end:
 *  connected → key package out → nobody else talking → ready after 5 s. */
async function readyRoom(members: string[] = ["alice", "bob"]) {
  mockTransport.createRoom.mockResolvedValue({ room: ROOM, name: "Room One", onion: "" });
  crypto.members.mockResolvedValue(members);
  const ch = useChatChannel();
  ch.mlsIdentity.value = "alice";
  ch.currentUserName.value = "Alice";
  await ch.createRoom("Room One");
  await status("connected");
  await vi.advanceTimersByTimeAsync(5000);
  expect(ch.mlsStatus.value).toBe("ready");
  mockTransport.send.mockClear();
  return ch;
}

/** Connected, key package sent, Welcome not yet here. */
async function negotiatingRoom() {
  mockTransport.createRoom.mockResolvedValue({ room: ROOM, name: "Room One", onion: "" });
  const ch = useChatChannel();
  ch.mlsIdentity.value = "alice";
  ch.currentUserName.value = "Alice";
  await ch.createRoom("Room One");
  await status("connected");
  expect(ch.mlsStatus.value).toBe("key_exchange");
  mockTransport.send.mockClear();
  return ch;
}

beforeEach(() => {
  // setImmediate stays real: jsdom's FileReader schedules on it, and the media
  // tests read real files.
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
  vi.unstubAllGlobals();
});

// ── receiving ───────────────────────────────────────────────────────────────

describe("an encrypted message from a peer", () => {
  it("renders as an encrypted bubble under the sender's name and counts as unread", async () => {
    const ch = await readyRoom();
    await deliver(fromPeer("bob", "hello there", { msg_id: "m-1" }));
    expect(bubbles(ch)).toHaveLength(1);
    expect(bubbles(ch)[0]).toMatchObject({
      id: "m-1",
      type: "mls_app",
      user: "Bob",
      initials: "B",
      content: "hello there",
      encrypted: true,
      self: false,
    });
    expect(ch.unread.value).toBe(1);
    ch.clearUnread();
    expect(ch.unread.value).toBe(0);
  });

  it("is shown once even when the same sender-minted id arrives twice", async () => {
    // A live echo, a restored log and a replay can all carry the same message;
    // the stable id is what keeps the timeline from doubling it.
    const ch = await readyRoom();
    await deliver(fromPeer("bob", "once", { msg_id: "m-1" }));
    await deliver(fromPeer("bob", "once", { msg_id: "m-1" }));
    expect(bubbles(ch).map((m) => m.content)).toEqual(["once"]);
    expect(ch.unread.value).toBe(1);
  });

  it("counts a message from our own other device as ours, with no unread bump", async () => {
    // "Self" spans the whole user: a linked leaf of our identity renders
    // right-aligned like anything we typed here.
    const ch = await readyRoom();
    await deliver(fromPeer("alice#dev-abcdefgh", "from my laptop", { sender_name: "Alice (laptop)" }));
    expect(bubbles(ch)[0]).toMatchObject({ content: "from my laptop", self: true });
    expect(ch.unread.value).toBe(0);
  });

  it("ignores our own frame echoed back by the topic", async () => {
    const ch = await readyRoom();
    await deliver(fromPeer("alice", "echo"));
    expect(bubbles(ch)).toHaveLength(0);
    expect(crypto.processMessage).not.toHaveBeenCalled();
  });

  it("takes the avatar from the roster when the envelope carries none", async () => {
    const ch = await readyRoom();
    await deliver(fromPeer("bob", { type: "presence", device_id: "bob", name: "Bob", avatar: "data:bob", reply: true }));
    await deliver(fromPeer("bob", "hi", { sender_avatar_url: null }));
    expect(bubbles(ch)[0].avatar_url).toBe("data:bob");
    await deliver(fromPeer("bob", "hi again", { sender_avatar_url: "data:fresh" }));
    expect(bubbles(ch)[1].avatar_url).toBe("data:fresh");
  });

  it("renders image and voice payloads as media cards keyed by their inner id", async () => {
    const ch = await readyRoom();
    await deliver(fromPeer("bob", { type: "image_message", image_data: "data:image/jpeg;base64,AAAA", msg_id: "img-1" }));
    await deliver(fromPeer("bob", { type: "voice_message", audio_data: "data:audio/ogg;base64,BBBB", msg_id: "vox-1" }));
    expect(bubbles(ch)).toMatchObject([
      { id: "img-1", type: "image_message", content: "", image_data: "data:image/jpeg;base64,AAAA" },
      { id: "vox-1", type: "voice_message", content: "", audio_data: "data:audio/ogg;base64,BBBB" },
    ]);
  });

  it("keeps a known map share as a card and drops any other map_* kind", async () => {
    // Maps left the app, but peers on older builds still send them. A known kind
    // says it cannot be shown; an unknown one must not become a raw-JSON bubble.
    const ch = await readyRoom();
    await deliver(fromPeer("bob", { type: "map_pin", lat: 52.2, lon: 21.0, msg_id: "pin-1" }));
    await deliver(fromPeer("bob", { type: "map_route", points: [] }));
    expect(bubbles(ch).map((m) => [m.id, m.type, m.content])).toEqual([["pin-1", "map_pin", ""]]);
  });

  it.each(["sync_pull", "file_offer", "meeting_invite", "vox_offer", "dlink_hello", "plink_hello"])(
    "routes %s to the sync handlers and never to the timeline",
    async (type) => {
      const ch = await readyRoom();
      const seen: Array<[string, Record<string, unknown>, string]> = [];
      const off = ch.onSync((t, payload, sender) => seen.push([t, payload, sender]));
      await deliver(fromPeer("bob", { type, id: "x-1" }));
      expect(seen).toEqual([[type, { type, id: "x-1" }, "Bob"]]);
      expect(bubbles(ch)).toHaveLength(0);

      // Unsubscribing really unsubscribes.
      off();
      await deliver(fromPeer("bob", { type, id: "x-2" }));
      expect(seen).toHaveLength(1);
    },
  );

  it("says so when the group yields no plaintext", async () => {
    const ch = await readyRoom();
    crypto.processMessage.mockResolvedValueOnce(null);
    await deliver(fromPeer("bob", "lost"));
    const last = ch.messages.value.at(-1)!;
    expect(last.type).toBe("system_error");
    expect(last.content).toMatch(/could not decrypt an incoming message/i);
    expect(bubbles(ch)).toHaveLength(0);
  });

  it("puts the session in error, with the reason, when decryption throws", async () => {
    const ch = await readyRoom();
    crypto.processMessage.mockRejectedValueOnce(new Error("epoch too old"));
    await deliver(fromPeer("bob", "late"));
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.mlsError.value).toBe("epoch too old");
    expect(notices(ch).at(-1)).toBe("Could not decrypt incoming message: epoch too old");
  });

  it("answers a group-id mismatch with a fresh key package instead of an error", async () => {
    // The group moved on without us (a reset elsewhere). Saying "error" would
    // strand the user; asking to be re-added is the way back in.
    const ch = await readyRoom();
    crypto.processMessage.mockRejectedValueOnce(new Error("Group ID differs from the current group"));
    await deliver(fromPeer("bob", "after reset"));
    expect(crypto.clearState).toHaveBeenLastCalledWith(ROOM, "alice");
    expect(crypto.initSession).toHaveBeenLastCalledWith(ROOM, "alice");
    expect(sent("mls_key_package")).toEqual([
      { type: "mls_key_package", key_package: "AQID", device_id: "alice" },
    ]);
    expect(ch.mlsStatus.value).toBe("key_exchange");
    expect(ch.mlsError.value).toBe("Group ID differs from the current group");
    expect(notices(ch).at(-1)).toMatch(/MLS group changed/);
  });

  it("recovers once from a burst of mismatched frames, not once per frame", async () => {
    const ch = await readyRoom();
    crypto.clearState.mockClear();
    const mismatch = new Error("group id differs");
    crypto.processMessage.mockRejectedValueOnce(mismatch).mockRejectedValueOnce(mismatch);
    // Both frames land before either recovery has finished.
    for (const h of wire.message) h(ROOM, fromPeer("bob", "one"));
    for (const h of wire.message) h(ROOM, fromPeer("bob", "two"));
    await flush();
    expect(crypto.clearState).toHaveBeenCalledTimes(1);
    expect(sent("mls_key_package")).toHaveLength(1);
    expect(ch.mlsStatus.value).toBe("key_exchange");
  });

  it("reports a recovery that cannot build a key package", async () => {
    const ch = await readyRoom();
    crypto.processMessage.mockRejectedValueOnce(new Error("group id differs"));
    crypto.keyPackage.mockResolvedValueOnce(null);
    await deliver(fromPeer("bob", "x"));
    expect(ch.mlsStatus.value).toBe("error");
    expect(notices(ch).at(-1)).toBe("Could not recover MLS session.");
    expect(sent("mls_key_package")).toHaveLength(0);
  });

  it("reports a recovery that throws, with the reason", async () => {
    const ch = await readyRoom();
    crypto.processMessage.mockRejectedValueOnce(new Error("group id differs"));
    crypto.initSession.mockRejectedValueOnce(new Error("vault locked"));
    await deliver(fromPeer("bob", "x"));
    expect(ch.mlsStatus.value).toBe("error");
    expect(ch.mlsError.value).toBe("vault locked");
    expect(notices(ch).at(-1)).toBe("Could not recover MLS session: vault locked");
  });
});

describe("a message that arrives before the session is ready", () => {
  it("shows a transient placeholder that is never written to the log", async () => {
    // Persisting it would replay "encrypted — session not ready" forever, on
    // every device, long after the session came up.
    const ch = await negotiatingRoom();
    await deliver(fromPeer("bob", "too early", { msg_id: "early-1" }));
    expect(ch.messages.value.at(-1)).toMatchObject({
      type: "mls_app",
      user: "Bob",
      content: "🔒 [encrypted — session not ready]",
      encrypted: true,
      self: false,
    });
    expect(crypto.processMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await loadLog(ROOM)).toEqual([]);
  });
});

describe("plaintext frames", () => {
  it("renders the pre-MLS plaintext fallback as an unencrypted bubble at its own time", async () => {
    const ch = await negotiatingRoom();
    await deliver({
      type: "chat_message", message: "hi", user: "Bob", id: "p-1",
      created_at: "2026-01-02T03:04:05.000Z",
    });
    expect(bubbles(ch)[0]).toMatchObject({ id: "p-1", user: "Bob", content: "hi", encrypted: false, self: false });
    expect(bubbles(ch)[0].timestamp.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("relays a transport error frame as an error notice", async () => {
    const ch = await negotiatingRoom();
    await deliver({ type: "system_error", message: "relay refused the frame" });
    expect(ch.messages.value.at(-1)).toMatchObject({ type: "system_error", content: "relay refused the frame" });
  });

  it("ignores frames for a room that is not on screen", async () => {
    const ch = await readyRoom();
    const before = ch.messages.value.length;
    await deliver(fromPeer("bob", "elsewhere"), "room-2");
    await deliver({ type: "chat_message", message: "elsewhere", user: "Bob" }, "room-2");
    expect(ch.messages.value).toHaveLength(before);
  });
});

// ── sending ─────────────────────────────────────────────────────────────────

describe("sending text", () => {
  it("encrypts the trimmed text, puts its stable id on the envelope, and shows it as ours", async () => {
    const ch = await readyRoom();
    await ch.sendMessage("  hi there  ");
    expect(crypto.encrypt).toHaveBeenCalledWith(ROOM, "alice", "hi there");
    const [frame] = sent("mls_app");
    expect(frame).toMatchObject({
      device_id: "alice", user: "Alice", sender_name: "Alice", sender_avatar_url: null,
    });
    // Text stays raw inside the ciphertext, so old builds render it as-is.
    expect(open(frame)).toBe("hi there");
    expect(bubbles(ch).at(-1)).toMatchObject({
      id: frame.msg_id, content: "hi there", self: true, encrypted: true,
    });
    expect(ch.unread.value).toBe(0);
  });

  it("carries our avatar on the envelope once one is set", async () => {
    const ch = await readyRoom();
    ch.myAvatar.value = "data:me";
    await flush();
    mockTransport.send.mockClear();
    await ch.sendMessage("with face");
    expect(sent("mls_app")[0].sender_avatar_url).toBe("data:me");
  });

  it("sends nothing for blank text or while disconnected", async () => {
    const ch = await readyRoom();
    await ch.sendMessage("   ");
    await status("disconnected");
    expect(notices(ch).at(-1)).toBe("Disconnected.");
    await ch.sendMessage("into the void");
    expect(mockTransport.send).not.toHaveBeenCalled();
  });

  it("refuses to send, and says so, when encryption fails", async () => {
    const ch = await readyRoom();
    crypto.encrypt.mockResolvedValueOnce(null);
    await ch.sendMessage("secret");
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(ch.messages.value.at(-1)).toMatchObject({
      type: "system_error", content: "Encryption failed — message not sent.",
    });
  });

  it("falls back to a plaintext frame before the session is ready", async () => {
    const ch = await negotiatingRoom();
    await ch.sendMessage("early words");
    expect(crypto.encrypt).not.toHaveBeenCalled();
    expect(sent()).toEqual([{ type: "chat_message", message: "early words", id: expect.any(String) }]);
  });
});

describe("sending media", () => {
  const png = () => new File(["png-bytes"], "a.png", { type: "image/png" });

  it("sends an image inside the ciphertext and shows it as ours", async () => {
    // jsdom has no createImageBitmap, so the downscale falls back to the file's
    // own data URL — still a complete, sendable image.
    const ch = await readyRoom();
    const progress = vi.fn();
    await ch.sendImage(png(), progress);
    const inner = JSON.parse(open(sent("mls_app")[0]));
    expect(inner).toEqual({
      type: "image_message",
      msg_id: expect.any(String),
      image_data: "data:image/png;base64,cG5nLWJ5dGVz",
    });
    expect(bubbles(ch).at(-1)).toMatchObject({
      id: inner.msg_id, type: "image_message", image_data: inner.image_data, self: true,
    });
    expect(progress).toHaveBeenCalledWith(100);
  });

  it("sends a voice clip inside the ciphertext and shows it as ours", async () => {
    const ch = await readyRoom();
    await ch.sendAudio(new Blob(["ogg"], { type: "audio/ogg" }));
    const inner = JSON.parse(open(sent("mls_app")[0]));
    expect(inner).toMatchObject({ type: "voice_message", audio_data: "data:audio/ogg;base64,b2dn" });
    expect(bubbles(ch).at(-1)).toMatchObject({ id: inner.msg_id, type: "voice_message", self: true });
  });

  it("refuses media before the session is ready, with a notice instead of plaintext", async () => {
    // Unlike text there is no plaintext lane for media at all.
    const ch = await negotiatingRoom();
    await ch.sendImage(png());
    await ch.sendAudio(new Blob(["ogg"]));
    expect(mockTransport.send).not.toHaveBeenCalled();
    expect(notices(ch).slice(-2)).toEqual([
      "Encryption not ready yet — try again in a moment.",
      "Encryption not ready yet — try again in a moment.",
    ]);
  });

  it("surfaces an encryption failure as the channel error", async () => {
    const ch = await readyRoom();
    crypto.encrypt.mockResolvedValue(null);
    await ch.sendImage(png());
    expect(ch.error.value).toBe("Encryption failed");
    ch.error.value = null;
    await ch.sendAudio(new Blob(["ogg"]));
    expect(ch.error.value).toBe("Encryption failed");
    expect(bubbles(ch)).toHaveLength(0);
  });

  it("does nothing without a room or after leaving the conversation", async () => {
    const idle = useChatChannel();
    await idle.sendImage(png());
    await idle.sendAudio(new Blob(["ogg"]));
    expect(idle.messages.value).toEqual([]);

    const ch = await readyRoom();
    ch.isParticipant.value = false;
    await ch.sendImage(png());
    expect(mockTransport.send).not.toHaveBeenCalled();
  });
});

describe("downscaleImageToDataUrl", () => {
  const bitmap = (width: number, height: number) =>
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width, height })));

  function fakeCanvas() {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as never);
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(function (this: HTMLCanvasElement) {
        return `data:${this.width}x${this.height}`;
      });
    return { drawImage, toDataURL };
  }

  it("fits the longest side to the limit and re-encodes as JPEG", async () => {
    bitmap(3200, 1600);
    const { drawImage, toDataURL } = fakeCanvas();
    expect(await downscaleImageToDataUrl(new File(["x"], "big.png"))).toBe("data:1600x800");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 800);
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
  });

  it("never upscales an image that already fits", async () => {
    bitmap(400, 300);
    fakeCanvas();
    expect(await downscaleImageToDataUrl(new File(["x"], "small.png"), 256, 0.8)).toBe("data:256x192");
    bitmap(200, 100);
    expect(await downscaleImageToDataUrl(new File(["x"], "tiny.png"))).toBe("data:200x100");
  });

  it("falls back to the original file when there is no 2D context", async () => {
    bitmap(400, 300);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const out = await downscaleImageToDataUrl(new File(["raw"], "a.png", { type: "image/png" }));
    expect(out).toBe("data:image/png;base64,cmF3");
  });
});

// ── what is kept ────────────────────────────────────────────────────────────

describe("the persisted timeline", () => {
  it("writes human messages to the room's log and never system notices", async () => {
    const ch = await readyRoom();
    await deliver(fromPeer("bob", "keep me", { msg_id: "m-1" }));
    await ch.sendMessage("and me");
    ch.postSystemNotice("Bob invited you to a meeting");
    await vi.advanceTimersByTimeAsync(1000); // the appender's batch window
    await vi.waitFor(async () => expect(await loadLog(ROOM)).toHaveLength(2));
    const log = await loadLog(ROOM);
    expect(log[0]).toMatchObject({ id: "m-1", user: "Bob", deviceId: "bob", content: "keep me", encrypted: true });
    expect(log[1]).toMatchObject({ user: "Alice", deviceId: "alice", content: "and me" });
    expect(ch.messages.value.at(-1)).toMatchObject({ type: "system_info", content: "Bob invited you to a meeting" });
  });

  it("brings a reopened room's log back, recomputing which lines are ours", async () => {
    const T = Date.parse("2026-02-01T10:00:00Z");
    const stored: PersistedMessage[] = [
      { id: "s-1", type: "mls_app", user: "Alice", deviceId: "alice", content: "mine", encrypted: true, ts: T },
      { id: "s-2", type: "image_message", user: "Bob", deviceId: "bob", content: "", image_data: "data:img", encrypted: true, ts: T + 1 },
      // Written by an old build: no device id, so the display name decides.
      { id: "s-3", type: "chat_message", user: "Alice", content: "legacy", encrypted: false, ts: T + 2 },
    ];
    await appendMessages(ROOM, stored, 500);
    mockTransport.joinRoomByNode.mockResolvedValue({ room: ROOM, name: "Room One", onion: "" });

    const ch = useChatChannel();
    ch.mlsIdentity.value = "alice";
    ch.currentUserName.value = "Alice";
    await ch.openP2pRoom({ room: ROOM, name: "Room One", peers: ["node-b"] });
    await vi.waitFor(() => expect(bubbles(ch)).toHaveLength(3));

    expect(bubbles(ch).map((m) => [m.id, m.self, m.initials])).toEqual([
      ["s-1", true, "A"],
      ["s-2", false, "B"],
      ["s-3", true, "A"],
    ]);
    expect(bubbles(ch)[1].image_data).toBe("data:img");
    expect(bubbles(ch)[0].timestamp.getTime()).toBe(T);
  });

  it("does not splice a log into the view when we left before it loaded", async () => {
    await appendMessages(ROOM, [
      { id: "s-1", type: "mls_app", user: "Bob", content: "old", encrypted: true, ts: 1 },
    ], 500);
    mockTransport.joinRoomByNode.mockResolvedValue({ room: ROOM, name: "Room One", onion: "" });
    const ch = useChatChannel();
    await ch.openP2pRoom({ room: ROOM, name: "Room One" });
    await ch.leaveParticipant();
    await vi.advanceTimersByTimeAsync(100);
    expect(ch.currentRoom.value).toBeNull();
    expect(ch.messages.value).toEqual([]);
  });
});

describe("mergeHistory", () => {
  const pm = (id: string, ts: number, user = "Bob"): PersistedMessage => ({
    id, type: "mls_app", user, content: `c-${id}`, encrypted: true, ts,
  });

  it("splices replayed history into the open room in time order, skipping what is shown", async () => {
    const ch = await readyRoom();
    await deliver(fromPeer("bob", "live", { msg_id: "live-1" }));
    const liveTs = bubbles(ch)[0].timestamp.getTime();
    ch.mergeHistory(ROOM, [pm("old-1", liveTs - 60_000), pm("live-1", liveTs), pm("new-1", liveTs + 60_000)]);
    expect(bubbles(ch).map((m) => m.id)).toEqual(["old-1", "live-1", "new-1"]);
  });

  it("ignores history for a room that is not open", async () => {
    const ch = await readyRoom();
    const before = ch.messages.value.length;
    ch.mergeHistory("room-2", [pm("x", 1)]);
    ch.mergeHistory(ROOM, []);
    expect(ch.messages.value).toHaveLength(before);
  });

  it("never merges into a headless channel's view", async () => {
    mockTransport.createRoom.mockResolvedValue({ room: ROOM, name: "Room One", onion: "" });
    const ch = useChatChannel({ headless: true });
    await ch.createRoom("Room One");
    const before = ch.messages.value.length;
    ch.mergeHistory(ROOM, [pm("x", 1)]);
    expect(ch.messages.value).toHaveLength(before);
  });
});
