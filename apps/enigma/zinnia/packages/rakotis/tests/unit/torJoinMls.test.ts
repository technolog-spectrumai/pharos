import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: over Tor the transport emits `connected` DURING the join invoke —
// before the channel has set the current room — so the status handler's
// startMls() kick used to be dropped: the joiner never sent its MLS key package
// and sat at "Connected / Not encrypted" forever (only a manual reset recovered).
// enterP2pRoom now kicks startMls() itself when the transport's cached lastStatus
// is already "connected". These tests pin both paths:
//   A. Tor-like: status cached before entry, no event after  → kp still sent.
//   B. iroh-like: no cached status, event arrives after entry → kp sent (unchanged).
//
// Written against join-by-ticket originally; re-pointed at `joinByNode`, which is
// the only way into a room now. The race is a property of the TRANSPORT's timing,
// not of which credential got us here, so removing tickets did not remove it.

// vi.mock factories are hoisted above ordinary const initializers — vi.hoisted
// makes the shared mock state available to them.
const { statusHandlers, mockTransport } = vi.hoisted(() => {
  const statusHandlers: Array<(room: string, state: string, peerId?: string, reason?: string) => void> = [];
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
    onMessage: vi.fn(() => () => {}),
    onStatus: vi.fn((h: (room: string, state: string, peerId?: string, reason?: string) => void) => {
      statusHandlers.push(h);
      return () => {};
    }),
    lastStatus: vi.fn((_room: string): string | undefined => undefined),
  };
  return { statusHandlers, mockTransport };
});

vi.mock("../../src/chatTransport", () => ({
  chatTransport: mockTransport,
}));

vi.mock("../../src/crypto", () => ({
  cryptoService: {
    clearState: vi.fn(async () => {}),
    initSession: vi.fn(async () => {}),
    keyPackage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    members: vi.fn(async () => []),
    addMember: vi.fn(async () => null),
    removeMember: vi.fn(async () => null),
  },
  bytesToBase64: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  base64ToBytes: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}));

vi.mock("../../src/services/appStorage", () => ({
  getRuntimeConfig: vi.fn(async () => ({ profile: "t", identity: "me-device", profile_state_path: "" })),
  getChatHistoryCapMsgs: vi.fn(async () => 500),
}));

vi.mock("../../src/services/localDb", () => ({
  kvGet: vi.fn(async () => null),
  kvPut: vi.fn(async () => {}),
  kvDelete: vi.fn(async () => {}),
  kvClearNamespace: vi.fn(async () => {}),
}));

import { useChatChannel } from "../../src/useChatChannel";

function keyPackageSends() {
  return mockTransport.send.mock.calls.filter(
    ([, payload]) => (payload as { type?: string }).type === "mls_key_package",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  statusHandlers.length = 0;
  mockTransport.lastStatus.mockReturnValue(undefined);
});

describe("Tor join — MLS key exchange must start even when 'connected' precedes room entry", () => {
  it("A: cached 'connected' (Tor emits during the invoke) → key package is sent without any status event", async () => {
    // The Tor backend emits realtime://status "connected" while realtime_join_room
    // is still in flight; by the time the channel enters the room the event is
    // long gone and only the cache remembers it.
    mockTransport.lastStatus.mockReturnValue("connected");
    mockTransport.joinRoomByNode.mockResolvedValue({ room: "room-1", name: "aaaa", onion: "abc.onion" });

    const ch = useChatChannel();
    ch.mlsIdentity.value = "me-device";

    await ch.joinByNode("aaaa", ["node-peer"]); // a non-empty onion ⇒ Tor

    // startMls() is kicked (not awaited) from enterP2pRoom — flush it.
    await vi.waitFor(() => {
      expect(keyPackageSends().length).toBeGreaterThan(0);
    });
    const [room, payload] = keyPackageSends()[0];
    expect(room).toBe("room-1");
    expect(payload).toMatchObject({ type: "mls_key_package", device_id: "me-device" });
    expect(ch.wsStatus.value).toBe("connected");
  });

  it("B: iroh-like flow (status event arrives after entry) still triggers exactly one key exchange", async () => {
    mockTransport.joinRoomByNode.mockResolvedValue({ room: "room-2", name: "bbbb", onion: "" });

    const ch = useChatChannel();
    ch.mlsIdentity.value = "me-device";

    await ch.joinByNode("bbbb", ["node-peer"]); // no onion ⇒ iroh
    expect(ch.wsStatus.value).toBe("connecting"); // nothing cached yet
    expect(keyPackageSends()).toHaveLength(0); // no premature MLS init

    // The gossip neighbor connects after the invoke — the classic path.
    statusHandlers.forEach((h) => h("room-2", "connected", "node-peer"));

    await vi.waitFor(() => {
      expect(keyPackageSends().length).toBeGreaterThan(0);
    });
    // startMls guards on mlsStatus, so the (cache-kick + event) pair can't double-init:
    // here only the event fired; exactly one key package went out.
    expect(keyPackageSends()).toHaveLength(1);
  });

  it("A+B: cache-kick followed by a late duplicate 'connected' event does not restart the key exchange", async () => {
    mockTransport.lastStatus.mockReturnValue("connected");
    mockTransport.joinRoomByNode.mockResolvedValue({ room: "room-3", name: "cccc", onion: "abc.onion" });

    const ch = useChatChannel();
    ch.mlsIdentity.value = "me-device";
    await ch.joinByNode("cccc", ["node-peer"]);

    await vi.waitFor(() => expect(keyPackageSends()).toHaveLength(1));

    // The transport may still deliver the buffered/duplicate status event later.
    statusHandlers.forEach((h) => h("room-3", "connected", "node-peer"));
    await new Promise((r) => setTimeout(r, 20));
    expect(keyPackageSends()).toHaveLength(1); // guarded — no double init
  });
});
