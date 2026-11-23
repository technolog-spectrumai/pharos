import { describe, it, expect, vi, beforeEach } from "vitest";

// Encryption starts on ENTERING a room, not on a link coming up. Opening a room
// sends its key package straight away — before, and without, any status event —
// and a later "connected" (or one the transport cached during the join invoke)
// never starts a second key exchange. (This replaces the old Tor regression in
// which a `connected` emitted during the invoke was dropped and MLS never began:
// with MLS no longer tied to status, that race cannot exist.)

// vi.mock factories are hoisted above ordinary const initializers — vi.hoisted
// makes the shared mock state available to them.
const { statusHandlers, mockTransport } = vi.hoisted(() => {
  const statusHandlers: Array<(room: string, state: string, peerId?: string) => void> = [];
  const mockTransport = {
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    setPeers: vi.fn(),
    cancelJoin: vi.fn(),
    leaveRoom: vi.fn(),
    forgetOnion: vi.fn(),
    deviceId: vi.fn(async () => null),
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onStatus: vi.fn((h: (room: string, state: string, peerId?: string) => void) => {
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

const { crypto } = vi.hoisted(() => ({
  crypto: {
    clearState: vi.fn(async () => {}),
    initSession: vi.fn(async () => false),
    keyPackage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    members: vi.fn(async () => []),
    addMember: vi.fn(async () => null),
    removeMember: vi.fn(async () => null),
  },
}));

vi.mock("../../src/crypto", () => ({
  cryptoService: crypto,
  bytesToBase64: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  base64ToBytes: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}));

vi.mock("../../src/services/appStorage", () => ({
  getRuntimeConfig: vi.fn(async () => ({ profile: "t", identity: "me-device", profile_state_path: "" })),
  getChatHistoryCapMsgs: vi.fn(async () => 500),
  getConnectTimeoutSecs: vi.fn(async () => 60),
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

describe("opening a room starts its encryption on entry", () => {
  it("sends the key package without any status event, while nobody is linked yet", async () => {
    mockTransport.lastStatus.mockReturnValue("waiting");
    mockTransport.joinRoom.mockResolvedValue({ room: "room-1", name: "aaaa", onion: "me.onion" });

    const ch = useChatChannel();
    ch.mlsIdentity.value = "me-device";

    await ch.openP2pRoom({ room: "room-1", name: "aaaa", peers: ["bob.onion"] });
    expect(mockTransport.joinRoom).toHaveBeenCalledWith("aaaa", ["bob.onion"]);
    expect(ch.wsStatus.value).toBe("waiting");
    expect(ch.myOnion.value).toBe("me.onion");

    // startMls() is kicked (not awaited) from enterP2pRoom — flush it.
    await vi.waitFor(() => expect(keyPackageSends()).toHaveLength(1));
    const [room, payload] = keyPackageSends()[0];
    expect(room).toBe("room-1");
    expect(payload).toMatchObject({ type: "mls_key_package", device_id: "me-device" });
    expect(statusHandlers.length).toBeGreaterThan(0);
    expect(ch.mlsStatus.value).toBe("key_exchange");
    // The session is kept, never wiped first.
    expect(crypto.initSession).toHaveBeenCalledWith("room-1", "me-device");
    expect(crypto.clearState).not.toHaveBeenCalled();
  });

  it("a member's link coming up later does not start a second key exchange", async () => {
    mockTransport.joinRoom.mockResolvedValue({ room: "room-2", name: "bbbb", onion: "me.onion" });

    const ch = useChatChannel();
    ch.mlsIdentity.value = "me-device";
    await ch.openP2pRoom({ room: "room-2", name: "bbbb", peers: ["bob.onion"] });
    expect(ch.wsStatus.value).toBe("waiting"); // nothing cached: nobody linked
    await vi.waitFor(() => expect(keyPackageSends()).toHaveLength(1));

    statusHandlers.forEach((h) => h("room-2", "connected", "bob.onion"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ch.wsStatus.value).toBe("connected");
    expect(keyPackageSends()).toHaveLength(1);
  });

  it("a 'connected' cached during the join invoke, then repeated, still means one key exchange", async () => {
    mockTransport.lastStatus.mockReturnValue("connected");
    mockTransport.joinRoom.mockResolvedValue({ room: "room-3", name: "cccc", onion: "me.onion" });

    const ch = useChatChannel();
    ch.mlsIdentity.value = "me-device";
    await ch.openP2pRoom({ room: "room-3", name: "cccc", peers: ["bob.onion"] });
    expect(ch.wsStatus.value).toBe("connected");

    await vi.waitFor(() => expect(keyPackageSends()).toHaveLength(1));
    statusHandlers.forEach((h) => h("room-3", "connected", "bob.onion"));
    await new Promise((r) => setTimeout(r, 20));
    expect(keyPackageSends()).toHaveLength(1); // guarded — no double init
  });
});
