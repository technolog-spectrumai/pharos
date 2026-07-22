import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

// usePeerSync pins the rules that make person-to-person sync different from
// linked-device sync, and every one of them is a security property:
//   • scope enforcement in BOTH directions (a peer cannot widen its own access
//     by simply sending frames it was never granted)
//   • history backfill is AUTHORISED against shared-room membership, not merely
//     validated — a peer must not be able to fabricate a log for any room
//   • a revoked grant refuses admission even though the peer keeps the link key
//   • the link-room proof is domain-separated from devlink's
// The link channel (useChatChannel) is mocked; storage is real localDb.

const { fake } = vi.hoisted(() => ({
  fake: {
    options: null as Record<string, unknown> | null,
    ch: null as Record<string, unknown> | null,
    syncHandlers: [] as Array<(t: string, p: Record<string, unknown>, s: string) => void>,
    sent: [] as Array<{ type: string; payload: Record<string, unknown> }>,
  },
}));

vi.mock("../../src/useChatChannel", async () => {
  const { ref: vref } = await import("vue");
  return {
    useChatChannel: vi.fn((options: Record<string, unknown> = {}) => {
      fake.options = options;
      const ch = {
        mlsIdentity: vref("alice"),
        currentUserName: vref("alice"),
        mlsStatus: vref("ready"),
        isConnected: vref(true),
        currentRoom: vref<{ slug: string } | null>(null),
        joinByNode: vi.fn(async () => {}),
        sendSync: vi.fn(async (type: string, payload: Record<string, unknown>) => {
          fake.sent.push({ type, payload });
        }),
        onSync: vi.fn((h: (t: string, p: Record<string, unknown>, s: string) => void) => {
          fake.syncHandlers.push(h);
          return () => {};
        }),
        clearLocalChatState: vi.fn(),
        removeLeaf: vi.fn(async () => {}),
      };
      fake.ch = ch;
      return ch;
    }),
  };
});

import { usePeerSync, peerKpProof } from "../../src/usePeerSync";
import { kpProof } from "../../src/useDeviceSync";
import { appendMessages, loadLog } from "../../src/services/chatLog";
import { PLINK_VERSION, type PeerGrant, type PeerScope } from "../../src/peerSyncModel";
import type { PersistedMessage } from "../../src/deviceSyncModel";
import type { ChatChannel } from "../../src/useChatChannel";

const LINK_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const PEER = "node-bob";

function fakeMain() {
  return {
    mlsIdentity: ref("alice"),
    currentUserName: ref("alice"),
    p2pRooms: ref<{ room: string; name: string; ticket: string; peers?: string[] }[]>([]),
    loadP2pRooms: vi.fn(async () => {}),
    mergeHistory: vi.fn(),
    removeLeaf: vi.fn(async () => {}),
  } as unknown as ChatChannel;
}

function grantOf(myScopes: PeerScope[], theirScopes: PeerScope[], revokedAt?: number): PeerGrant {
  return {
    v: PLINK_VERSION,
    peerNodeId: PEER,
    peerName: "bob",
    linkKey: LINK_KEY,
    roomName: "plink-room",
    safetyNumber: "1111222233334444",
    myScopes, theirScopes,
    initiator: true,
    createdAt: 1,
    rev: 1,
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function seedGrant(grant: PeerGrant) {
  localStorage.setItem("enigma:db:peers:index:", JSON.stringify([grant.peerNodeId]));
  localStorage.setItem(`enigma:db:peers:${grant.peerNodeId}:`, JSON.stringify(grant));
}

function msg(id: string, ts: number): PersistedMessage {
  return { id, type: "mls_app", user: "bob", content: id, encrypted: true, ts };
}

/** Drive a frame in through the composable's real handler, as the channel would. */
async function deliver(type: string, payload: Record<string, unknown>) {
  for (const h of fake.syncHandlers) h(type, payload, "bob");
  await new Promise((r) => setTimeout(r, 0));
}

async function startedSync(grant: PeerGrant, sources: Record<string, unknown> = {}) {
  seedGrant(grant);
  const sync = usePeerSync(fakeMain(), {
    myNodeId: () => "node-alice",
    ...sources,
  } as never);
  await sync.refresh();
  await sync.start();
  fake.sent.length = 0;
  return sync;
}

beforeEach(() => {
  localStorage.clear();
  fake.options = null;
  fake.ch = null;
  fake.syncHandlers.length = 0;
  fake.sent.length = 0;
});

describe("usePeerSync — admission", () => {
  it("accepts a key package proving the link key, rejects a forged one", async () => {
    await startedSync(grantOf(["calendar"], ["calendar"]));
    const check = fake.options!.admissionCheck as (d: Record<string, unknown>) => Promise<boolean>;
    const kp = "a-key-package";
    expect(await check({ key_package: kp, link_proof: await peerKpProof(LINK_KEY, kp) })).toBe(true);
    expect(await check({ key_package: kp, link_proof: "deadbeef" })).toBe(false);
    expect(await check({ key_package: kp })).toBe(false);
  });

  it("a devlink proof does NOT open a peer link (domain separation)", async () => {
    await startedSync(grantOf(["calendar"], ["calendar"]));
    const check = fake.options!.admissionCheck as (d: Record<string, unknown>) => Promise<boolean>;
    const kp = "a-key-package";
    // Same key, same key package — only the label differs.
    expect(await check({ key_package: kp, link_proof: await kpProof(LINK_KEY, kp) })).toBe(false);
  });

  it("a REVOKED grant refuses admission even though the peer still holds the key", async () => {
    const sync = await startedSync(grantOf(["calendar"], ["calendar"]));
    const check = fake.options!.admissionCheck as (d: Record<string, unknown>) => Promise<boolean>;
    const kp = "a-key-package";
    const validProof = await peerKpProof(LINK_KEY, kp);
    expect(await check({ key_package: kp, link_proof: validProof })).toBe(true);
    await sync.revoke(PEER, false);
    // The key is unchanged and the proof still verifies — the tombstone is what
    // cuts them off (peer.md P6: revocation cannot rely on rotating a secret
    // the peer already knows).
    expect(await check({ key_package: kp, link_proof: validProof })).toBe(false);
  });

  it("attaches our own proof to outbound key packages", async () => {
    await startedSync(grantOf(["calendar"], ["calendar"]));
    const extra = fake.options!.keyPackageExtra as (kp: string) => Promise<Record<string, unknown>>;
    expect(await extra("kp")).toEqual({ link_proof: await peerKpProof(LINK_KEY, "kp") });
  });
});

describe("usePeerSync — receive-side scope enforcement", () => {
  it("drops a calendar frame for a scope the peer never granted", async () => {
    // They granted us "board" only; a calendar frame is out of scope.
    await startedSync(grantOf(["calendar"], ["board"]));
    await deliver("plink_cal", {
      type: "plink_cal", v: PLINK_VERSION, full: true,
      meetings: [{
        id: "m1", title: "sneaky", start: 1, end: 2, location: "", notes: "",
        status: "scheduled", organizer: "bob", clock: { c: 1, by: PEER },
      }],
    });
    expect(localStorage.getItem(`enigma:db:peer:cal:${PEER}:`)).toBeNull();
  });

  it("accepts the same frame once that scope IS granted", async () => {
    await startedSync(grantOf(["calendar"], ["calendar"]));
    await deliver("plink_cal", {
      type: "plink_cal", v: PLINK_VERSION, full: true,
      meetings: [{
        id: "m1", title: "standup", start: 1, end: 2, location: "", notes: "",
        status: "scheduled", organizer: "bob", clock: { c: 1, by: PEER },
      }],
    });
    const stored = localStorage.getItem(`enigma:db:peer:cal:${PEER}:`);
    expect(stored).toContain("standup");
  });

  it("drops a card frame outside the grant", async () => {
    await startedSync(grantOf(["card"], ["calendar"]));
    await deliver("plink_card", {
      type: "plink_card", v: PLINK_VERSION,
      card: { name: "bob", avatar: "", about: "hi", clock: { c: 1, by: PEER } },
    });
    expect(localStorage.getItem(`enigma:db:peer:card:${PEER}:`)).toBeNull();
  });
});

describe("usePeerSync — history backfill authorisation", () => {
  const ROOM = "room-shared";

  it("refuses history for a room we do not both belong to", async () => {
    // sharedRooms says nothing is shared, so the peer's log must not land.
    await startedSync(grantOf([], ["history"]), { sharedRooms: async () => [] });
    await deliver("plink_hist", {
      type: "plink_hist", v: PLINK_VERSION, room: ROOM, chunk: 1, of: 1,
      msgs: [msg("x1", 100)],
    });
    expect(await loadLog(ROOM)).toHaveLength(0);
  });

  it("merges history for a genuinely shared room", async () => {
    await startedSync(grantOf([], ["history"]), { sharedRooms: async () => [ROOM] });
    await deliver("plink_hist", {
      type: "plink_hist", v: PLINK_VERSION, room: ROOM, chunk: 1, of: 1,
      msgs: [msg("x1", 100), msg("x2", 200)],
    });
    expect((await loadLog(ROOM)).map((m) => m.id)).toEqual(["x1", "x2"]);
  });

  it("refuses history when the scope itself was not granted", async () => {
    await startedSync(grantOf([], []), { sharedRooms: async () => [ROOM] });
    await deliver("plink_hist", {
      type: "plink_hist", v: PLINK_VERSION, room: ROOM, chunk: 1, of: 1,
      msgs: [msg("x1", 100)],
    });
    expect(await loadLog(ROOM)).toHaveLength(0);
  });

  it("answers a history request only for a shared room, and only what is newer", async () => {
    await appendMessages(ROOM, [msg("old", 100), msg("new", 300)], 500);
    const sync = await startedSync(grantOf(["history"], []), {
      sharedRooms: async () => [ROOM],
    });
    await sync._internal.sendHistory(PEER, ROOM, 200);
    const hist = fake.sent.filter((f) => f.type === "plink_hist");
    expect(hist).toHaveLength(1);
    expect((hist[0].payload.msgs as PersistedMessage[]).map((m) => m.id)).toEqual(["new"]);

    // …and nothing at all for a room that is not shared.
    fake.sent.length = 0;
    await sync._internal.sendHistory(PEER, "some-other-room", 0);
    expect(fake.sent).toHaveLength(0);
  });
});

describe("usePeerSync — send-side scope enforcement", () => {
  it("pushes only the scopes I granted", async () => {
    const sync = await startedSync(grantOf(["card"], ["calendar", "board", "card"]), {
      myMeetings: async () => [{
        id: "m1", title: "mine", start: 1, end: 2, location: "", notes: "",
        status: "scheduled" as const, organizer: "alice", clock: { c: 1, by: "node-alice" },
      }],
      myCard: async () => ({ name: "alice", avatar: "", about: "", clock: { c: 1, by: "node-alice" } }),
    });
    await sync._internal.pushScopes(PEER);
    const types = fake.sent.map((f) => f.type);
    expect(types).toContain("plink_card");
    // I did NOT grant calendar, so my meetings must not go out even though a
    // source exists and they granted me theirs.
    expect(types).not.toContain("plink_cal");
  });

  it("sends nothing at all once the link is revoked", async () => {
    const sync = await startedSync(grantOf(["card"], ["card"]), {
      myCard: async () => ({ name: "alice", avatar: "", about: "", clock: { c: 1, by: "node-alice" } }),
    });
    await sync.revoke(PEER, false);
    fake.sent.length = 0;
    await sync._internal.pushScopes(PEER);
    expect(fake.sent).toHaveLength(0);
  });
});

describe("usePeerSync — grants", () => {
  it("loads grants from the index and exposes only live ones", async () => {
    const live = grantOf(["card"], ["card"]);
    seedGrant(live);
    localStorage.setItem("enigma:db:peers:index:", JSON.stringify([PEER, "node-gone"]));
    localStorage.setItem(
      "enigma:db:peers:node-gone:",
      JSON.stringify({ ...grantOf([], [], 99), peerNodeId: "node-gone" }),
    );
    const sync = usePeerSync(fakeMain(), { myNodeId: () => "node-alice" });
    await sync.refresh();
    expect(sync.grants.value).toHaveLength(2);
    expect(sync.liveGrants.value.map((g) => g.peerNodeId)).toEqual([PEER]);
  });

  it("narrowing my scopes bumps the revision so the peer can tell it is behind", async () => {
    const sync = await startedSync(grantOf(["calendar", "card"], ["card"]));
    await sync.setMyScopes(PEER, ["card"]);
    const g = sync.grantFor(PEER)!;
    expect(g.myScopes).toEqual(["card"]);
    expect(g.rev).toBe(2);
  });

  it("revoking tombstones the grant and empties both scope sets", async () => {
    const sync = await startedSync(grantOf(["calendar"], ["board"]));
    await sync.revoke(PEER);
    const g = sync.grantFor(PEER)!;
    expect(g.revokedAt).toBeGreaterThan(0);
    expect(g.myScopes).toEqual([]);
    expect(g.theirScopes).toEqual([]);
    expect(sync.liveGrants.value).toHaveLength(0);
  });

  it("a peer's revoke frame cuts the link on our side too", async () => {
    const sync = await startedSync(grantOf(["calendar"], ["board"]));
    await deliver("plink_revoke", { type: "plink_revoke", v: PLINK_VERSION });
    expect(sync.grantFor(PEER)?.revokedAt).toBeGreaterThan(0);
  });
});
