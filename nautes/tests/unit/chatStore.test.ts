import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

// The chat store orchestrates the single rakotis P2P channel. We mock rakotis so
// the channel is a controllable stub and assert the serverless bootstrap: on
// init() the store loads the saved room list and auto-reopens the most recent
// room (whose persisted peer NodeIds make the reconnect work without a fresh QR).

function makeP2pStub() {
  return {
    p2pRooms: ref<Array<{ room: string; name: string; ticket: string; peers?: string[] }>>([]),
    currentUserName: ref("You"),
    mlsIdentity: ref("You"),
    currentRoom: ref(null),
    participants: ref([]),
    mlsStatus: ref("idle"),
    // Captain election (room moderation authority).
    amCaptain: ref(false),
    captainId: ref<string | null>(null),
    // Data-sync seam (consumed by the store's fileShare + meetings singletons).
    onSync: vi.fn(() => () => {}),
    sendSync: vi.fn(async () => {}),
    postSystemNotice: vi.fn(),
    loadP2pRooms: vi.fn(async () => {}),
    openP2pRoom: vi.fn(async () => {}),
    ensureNode: vi.fn(async () => "my-node"),
    joinByTicket: vi.fn(async () => {}),
    clearUnread: vi.fn(),
    syncRuntimeIdentity: vi.fn(async () => {}),
    applyRuntimeProfile: vi.fn(async () => {}),
    clearLocalChatState: vi.fn(),
  };
}

let p2pStub: ReturnType<typeof makeP2pStub>;

// Per-test build-config overrides, layered over the real fallback config so a
// test can simulate a build's feature set (technology.md §20) without a rebuild. The store
// reads getBuildConfig() at creation, hence the freshStore() argument.
let buildFlags: Partial<Record<string, unknown>> = {};

// Partial mock: only the channel is stubbed — the store's singletons also pull
// real rakotis helpers (createAppI18n via src/i18n, kv storage, settings).
vi.mock("rakotis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rakotis")>();
  return {
    ...actual,
    useChatChannel: () => p2pStub,
    getBuildConfig: () => ({ ...actual.getBuildConfig(), ...buildFlags }),
  };
});

async function freshStore(flags: Partial<Record<string, unknown>> = {}) {
  vi.resetModules();
  buildFlags = flags;
  p2pStub = makeP2pStub();
  const mod = await import("../../src/stores/chat");
  return mod.useChatStore();
}

describe("chat store — serverless P2P bootstrap", () => {
  beforeEach(() => vi.resetModules());

  it("init loads saved rooms and auto-reopens the most recent one", async () => {
    const store = await freshStore();
    const entry = { room: "topic-1", name: "duo", ticket: "tkt", peers: ["node-bob"] };
    p2pStub.loadP2pRooms.mockImplementation(async () => {
      p2pStub.p2pRooms.value = [entry];
    });

    await store.init();

    expect(p2pStub.loadP2pRooms).toHaveBeenCalled();
    // The full entry is passed through — openP2pRoom seeds the rejoin with entry.peers.
    expect(p2pStub.openP2pRoom).toHaveBeenCalledWith(entry);
  });

  it("init with no saved rooms opens nothing", async () => {
    const store = await freshStore();
    await store.init();

    expect(p2pStub.loadP2pRooms).toHaveBeenCalled();
    expect(p2pStub.openP2pRoom).not.toHaveBeenCalled();
  });

  it("init is idempotent — a second call does not reopen the room", async () => {
    const store = await freshStore();
    p2pStub.p2pRooms.value = [{ room: "topic-1", name: "duo", ticket: "tkt" }];

    await store.init();
    await store.init();

    expect(p2pStub.loadP2pRooms).toHaveBeenCalledTimes(1);
    expect(p2pStub.openP2pRoom).toHaveBeenCalledTimes(1);
  });

  it("identity fan-out delegates to the channel", async () => {
    const store = await freshStore();

    await store.syncRuntimeIdentity();
    expect(p2pStub.syncRuntimeIdentity).toHaveBeenCalled();

    const runtime = { profile: "alice", identity: "alice", profile_state_path: "" };
    await store.applyRuntimeProfile(runtime);
    expect(p2pStub.applyRuntimeProfile).toHaveBeenCalledWith(runtime);

    store.clearLocalChatState("bye");
    expect(p2pStub.clearLocalChatState).toHaveBeenCalledWith("bye");
  });
});
