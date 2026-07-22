import { describe, it, expect, vi, beforeEach } from "vitest";

// Multi-device (linked devices) pins on the chat channel:
//   1. A message from the user's OTHER leaf ("alice#dev-…") is delivered,
//      renders as self, and bumps no unread — while the exact-leaf echo guard
//      still drops our own envelopes.
//   2. The roster groups leaves by user part (one row, deviceCount, captain ★
//      on the row that contains the captain leaf).
//   3. The primary admits its own second device (lexicographic admin rule).
//   4. A headless channel (the hidden devlink room) never writes the saved-room
//      kv, and its admissionCheck refuses unproven key packages.
//   5. Human messages persist to chat:log and are restored on re-entry.
// Transport + crypto are mocked; storage is the real localDb (jsdom localStorage).

const { statusHandlers, messageHandlers, mockTransport } = vi.hoisted(() => {
  const statusHandlers: Array<(room: string, state: string, peerId?: string, reason?: string) => void> = [];
  const messageHandlers: Array<(room: string, data: unknown) => void> = [];
  const mockTransport = {
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    joinRoomByNode: vi.fn(),
    cancelJoin: vi.fn(),
    leaveRoom: vi.fn(),
    forgetTorOnion: vi.fn(),
    setCaptain: vi.fn(),
    nodeInfo: vi.fn(async () => null),
    send: vi.fn(),
    onMessage: vi.fn((h: (room: string, data: unknown) => void) => {
      messageHandlers.push(h);
      return () => {};
    }),
    onStatus: vi.fn((h: (room: string, state: string, peerId?: string, reason?: string) => void) => {
      statusHandlers.push(h);
      return () => {};
    }),
    lastStatus: vi.fn((_room: string): string | undefined => undefined),
  };
  return { statusHandlers, messageHandlers, mockTransport };
});

const { mockCrypto } = vi.hoisted(() => {
  const mockCrypto = {
    clearState: vi.fn(async () => {}),
    initSession: vi.fn(async () => {}),
    keyPackage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    joinFromWelcome: vi.fn(async () => true),
    // "Ciphertext" IS the plaintext in these tests — processMessage decodes 1:1.
    processMessage: vi.fn(async (_room: string, _id: string, bytes: Uint8Array) => bytes),
    encrypt: vi.fn(async (_room: string, _id: string, text: string) => new TextEncoder().encode(text)),
    members: vi.fn(async (): Promise<string[]> => []),
    addMember: vi.fn(async (): Promise<{ commit: Uint8Array; welcome: Uint8Array } | null> => null),
    removeMember: vi.fn(async () => null),
  };
  return { mockCrypto };
});

vi.mock("../../src/chatTransport", () => ({ chatTransport: mockTransport }));
vi.mock("../../src/crypto", () => ({
  cryptoService: mockCrypto,
  bytesToBase64: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  base64ToBytes: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}));

import { useChatChannel, type ChatChannelOptions } from "../../src/useChatChannel";

const b64 = (s: string) => btoa(s);

async function readyChannel(identity: string, room = "room-1", options?: ChatChannelOptions) {
  const ch = useChatChannel(options);
  ch.mlsIdentity.value = identity;
  ch.currentUserName.value = "Alice";
  mockTransport.joinRoom.mockResolvedValue({ room, name: "Test", onion: "" });
  await ch.joinByTicket("aaaqeay"); // tagless base32 → iroh
  statusHandlers.forEach((h) => h(room, "connected"));
  await vi.waitFor(() => {
    expect(mockTransport.send.mock.calls.some(([, p]) => (p as { type?: string }).type === "mls_key_package")).toBe(true);
  });
  // Welcome → ready (no reliance on the 5 s optimistic timer).
  await dispatch(room, { type: "mls_welcome", welcome: b64("w") });
  await vi.waitFor(() => expect(ch.mlsStatus.value).toBe("ready"));
  return ch;
}

async function dispatch(room: string, data: Record<string, unknown>) {
  messageHandlers.forEach((h) => h(room, data));
  await new Promise((r) => setTimeout(r, 0));
}

function sendsOf(type: string) {
  return mockTransport.send.mock.calls.filter(([, p]) => (p as { type?: string }).type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  statusHandlers.length = 0;
  messageHandlers.length = 0;
  localStorage.clear();
  mockTransport.lastStatus.mockReturnValue(undefined);
  mockCrypto.members.mockResolvedValue([]);
});

describe("linked-device message delivery", () => {
  it("delivers the other leaf's message as self, without an unread bump", async () => {
    const ch = await readyChannel("alice");
    ch.clearUnread();
    await dispatch("room-1", {
      type: "mls_app", ciphertext: b64("hi from my phone"),
      device_id: "alice#dev-testtest", sender_name: "Alice", msg_id: "mid-1",
    });
    const msg = ch.messages.value.find((m) => m.content === "hi from my phone");
    expect(msg).toBeDefined();
    expect(msg!.self).toBe(true);
    expect(msg!.id).toBe("mid-1");
    expect(ch.unread.value).toBe(0);
  });

  it("still drops the exact-leaf echo, and dedupes a replayed msg_id", async () => {
    const ch = await readyChannel("alice");
    await dispatch("room-1", {
      type: "mls_app", ciphertext: b64("echo"), device_id: "alice", sender_name: "Alice",
    });
    expect(ch.messages.value.some((m) => m.content === "echo")).toBe(false);

    await dispatch("room-1", {
      type: "mls_app", ciphertext: b64("once"), device_id: "bob-node", sender_name: "Bob", msg_id: "dup-1",
    });
    await dispatch("room-1", {
      type: "mls_app", ciphertext: b64("once"), device_id: "bob-node", sender_name: "Bob", msg_id: "dup-1",
    });
    expect(ch.messages.value.filter((m) => m.id === "dup-1")).toHaveLength(1);
  });
});

describe("roster grouping by user part", () => {
  it("groups linked leaves into one row with deviceCount and the captain star", async () => {
    mockCrypto.members.mockResolvedValue(["alice", "alice#dev-testtest", "bob"]);
    const ch = await readyChannel("alice");
    await vi.waitFor(() => expect(ch.participants.value).toHaveLength(2));
    const me = ch.participants.value.find((p) => p.id === "alice")!;
    expect(me.leafIds).toEqual(["alice", "alice#dev-testtest"]);
    expect(me.deviceCount).toBe(2);
    expect(me.isCaptain).toBe(true); // captain = lowest leaf id = "alice"
    const bob = ch.participants.value.find((p) => p.id === "bob")!;
    expect(bob.deviceCount).toBeUndefined();
    expect(ch.currentRoom.value?.participant_count).toBe(2);
  });
});

describe("second-device admission", () => {
  it("the primary admits its own second device's key package", async () => {
    const ch = await readyChannel("alice");
    mockCrypto.addMember.mockResolvedValue({ commit: new Uint8Array([9]), welcome: new Uint8Array([8]) });
    await dispatch("room-1", {
      type: "mls_key_package", key_package: b64("kp"), device_id: "alice#dev-testtest", user: "Alice",
    });
    await vi.waitFor(() => expect(mockCrypto.addMember).toHaveBeenCalledTimes(1));
    expect(sendsOf("mls_commit").length).toBe(1);
    expect(sendsOf("mls_welcome").length).toBe(1);
    expect(ch.mlsStatus.value).toBe("ready");
  });
});

describe("dlink_ sync-seam routing (regression: it was never wired)", () => {
  it("routes a dlink_* inner frame through the REAL handler to onSync", async () => {
    const ch = await readyChannel("alice#dev-testtest", "devlink-x", { headless: true });
    const seen: string[] = [];
    ch.onSync((type) => seen.push(type));
    // A real inner dlink_hello arriving from the peer device (distinct leaf id,
    // so it survives the self-echo guard) must reach syncHandlers.
    await dispatch("devlink-x", {
      type: "mls_app", ciphertext: b64(JSON.stringify({ type: "dlink_hello", v: 1 })),
      device_id: "alice", sender_name: "Alice",
    });
    expect(seen).toContain("dlink_hello");
  });
});

describe("plink_ sync-seam routing (the same regression, for peer links)", () => {
  it("routes a plink_* inner frame through the REAL handler to onSync", async () => {
    // Dispatching through the real handler is the whole point: calling the sync
    // handler directly is what MASKED the missing dlink_ prefix in 2026-07-20.
    // A prefix absent from the gate does not merely fail to route — the frame
    // renders as a raw-JSON chat bubble and gets persisted to chat:log.
    const ch = await readyChannel("alice", "plink-x", { headless: true });
    const seen: string[] = [];
    ch.onSync((type) => seen.push(type));
    await dispatch("plink-x", {
      type: "mls_app", ciphertext: b64(JSON.stringify({ type: "plink_hello", v: 1 })),
      device_id: "bob", sender_name: "Bob",
    });
    expect(seen).toContain("plink_hello");
  });

  it("does not render a plink_ frame as a chat bubble", async () => {
    const ch = await readyChannel("alice", "plink-y", { headless: true });
    const before = ch.messages.value.length;
    await dispatch("plink-y", {
      type: "mls_app", ciphertext: b64(JSON.stringify({ type: "plink_board", v: 1 })),
      device_id: "bob", sender_name: "Bob",
    });
    expect(ch.messages.value.length).toBe(before);
  });
});

describe("headless devlink channel", () => {
  it("never persists a saved-room entry", async () => {
    const ch = useChatChannel({ headless: true });
    ch.mlsIdentity.value = "alice#dev-testtest";
    mockTransport.createRoom.mockResolvedValue({ room: "devlink-x", name: "devlink-x", ticket: "aaaqeay", onion: "" });
    await ch.createRoom("devlink-x");
    expect(localStorage.getItem("enigma:db:p2p:rooms:default:")).toBeNull();
  });

  it("admissionCheck refuses an unproven key package (no add, no defer)", async () => {
    const check = vi.fn(() => false);
    const ch = await readyChannel("alice#dev-testtest", "devlink-x", { headless: true, admissionCheck: check });
    mockTransport.send.mockClear();
    await dispatch("devlink-x", {
      type: "mls_key_package", key_package: b64("kp"), device_id: "intruder",
    });
    expect(check).toHaveBeenCalled();
    expect(mockCrypto.addMember).not.toHaveBeenCalled();
    expect(sendsOf("mls_key_package")).toHaveLength(0);
    expect(ch.mlsStatus.value).toBe("ready");
  });

  it("keyPackageExtra decorates outbound key packages (the linkKey proof hook)", async () => {
    const extra = vi.fn(async () => ({ link_proof: "proof123" }));
    await readyChannel("alice#dev-testtest", "devlink-y", { headless: true, keyPackageExtra: extra });
    const kp = sendsOf("mls_key_package")[0][1] as Record<string, unknown>;
    expect(extra).toHaveBeenCalled();
    expect(kp.link_proof).toBe("proof123");
  });
});

describe("timeline persistence", () => {
  it("persists received messages and restores them on re-entry", async () => {
    const ch = await readyChannel("alice");
    await dispatch("room-1", {
      type: "mls_app", ciphertext: b64("persist me"),
      device_id: "bob-node", sender_name: "Bob", msg_id: "keep-1",
    });
    expect(ch.messages.value.some((m) => m.id === "keep-1")).toBe(true);
    await ch.leaveParticipant(); // teardown → appender flush
    await vi.waitFor(() => {
      expect(localStorage.getItem("enigma:db:chat:log:room-1:seg-0")).toContain("keep-1");
    });

    // Re-enter: the stored log comes back, marked not-self, correct sender.
    mockCrypto.members.mockResolvedValue([]);
    await ch.joinByTicket("aaaqeay");
    await vi.waitFor(() => {
      const restored = ch.messages.value.find((m) => m.id === "keep-1");
      expect(restored).toBeDefined();
      expect(restored!.content).toBe("persist me");
      expect(restored!.self).toBe(false);
      expect(restored!.user).toBe("Bob");
    });
  });
});
