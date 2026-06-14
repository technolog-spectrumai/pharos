import { describe, it, expect, vi, beforeEach } from "vitest";

// The chat store orchestrates two rakotis channels (relay + p2p). We mock rakotis
// so `relay`/`p2p` are controllable stubs and assert the ticketless "switch to P2P"
// automation: resolve every *other* relay member's gossip NodeId from aster and
// join the mirrored P2P room by node — no ticket.

function makeRelayStub() {
  return {
    currentRoom: { value: { slug: "room-1", name: "General" } },
    currentUserName: { value: "alice" },
    participants: {
      value: [
        { name: "alice", username: "alice" }, // self — skipped
        { name: "Bob", username: "bob" },
        { name: "Carol", username: "carol" },
        { name: "Ghost", username: "" }, // no account — skipped
      ],
    },
    resolveNodes: vi.fn(async (u: string) =>
      u === "bob" ? ["node-bob"] : u === "carol" ? ["node-carol"] : []
    ),
    sendAutoJoin: vi.fn(async () => {}),
    sendInvite: vi.fn(async () => {}),
    createRoom: vi.fn(async () => "tkt"),
    clearUnread: vi.fn(),
    syncRuntimeIdentity: vi.fn(async () => {}),
    applyRuntimeProfile: vi.fn(async () => {}),
    clearLocalChatState: vi.fn(),
    leaveAllChatsOnServer: vi.fn(async () => {}),
  };
}

function makeP2pStub() {
  return {
    ensureNode: vi.fn(async () => "my-node"),
    joinByNode: vi.fn(async () => {}),
    joinByTicket: vi.fn(async () => {}),
    clearUnread: vi.fn(),
    syncRuntimeIdentity: vi.fn(async () => {}),
    applyRuntimeProfile: vi.fn(async () => {}),
    clearLocalChatState: vi.fn(),
  };
}

let relayStub: ReturnType<typeof makeRelayStub>;
let p2pStub: ReturnType<typeof makeP2pStub>;

vi.mock("rakotis", () => ({
  useChatChannel: (kind: string) => (kind === "relay" ? relayStub : p2pStub),
}));
vi.mock("../../src/composables/useFileShare", () => ({ useFileShare: () => ({}) }));
vi.mock("../../src/services/api", () => ({ api: {} }));

async function freshStore() {
  vi.resetModules();
  relayStub = makeRelayStub();
  p2pStub = makeP2pStub();
  const mod = await import("../../src/stores/chat");
  return mod.useChatStore();
}

describe("chat store — ticketless P2P automation", () => {
  beforeEach(() => vi.resetModules());

  it("switchToP2p resolves other members' gossip nodes and joins by node", async () => {
    const store = await freshStore();
    await store.switchToP2p();

    // Resolved only members with a username, excluding self.
    expect(relayStub.resolveNodes).toHaveBeenCalledWith("bob", "gossip");
    expect(relayStub.resolveNodes).toHaveBeenCalledWith("carol", "gossip");
    expect(relayStub.resolveNodes).not.toHaveBeenCalledWith("alice", "gossip");
    expect(relayStub.resolveNodes).toHaveBeenCalledTimes(2);

    // Registered our own node, then joined the relay slug by the resolved NodeIds.
    expect(p2pStub.ensureNode).toHaveBeenCalled();
    expect(p2pStub.joinByNode).toHaveBeenCalledWith("room-1", ["node-bob", "node-carol"]);

    // Posted a ticketless nudge keyed by the relay slug, and jumped to the P2P tab.
    expect(relayStub.sendAutoJoin).toHaveBeenCalledWith("room-1");
    expect(relayStub.createRoom).not.toHaveBeenCalled(); // no ticket path
    expect(store.activeTab.value).toBe("p2p");
  });

  it("acceptP2pAutoJoin joins the named room by aster-resolved nodes", async () => {
    const store = await freshStore();
    await store.acceptP2pAutoJoin("room-1");

    expect(p2pStub.ensureNode).toHaveBeenCalled();
    expect(p2pStub.joinByNode).toHaveBeenCalledWith("room-1", ["node-bob", "node-carol"]);
    expect(store.activeTab.value).toBe("p2p");
  });

  it("switchToP2p with no current relay room just opens the P2P tab", async () => {
    const store = await freshStore();
    relayStub.currentRoom.value = null as any;
    await store.switchToP2p();

    expect(p2pStub.joinByNode).not.toHaveBeenCalled();
    expect(relayStub.sendAutoJoin).not.toHaveBeenCalled();
    expect(store.activeTab.value).toBe("p2p");
  });
});
