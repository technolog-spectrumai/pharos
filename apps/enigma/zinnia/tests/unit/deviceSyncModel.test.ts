import { describe, it, expect } from "vitest";
import {
  DEVLINK_SYNC_KV,
  DEVLINK_VERSION,
  DLINK_HISTORY_CHUNK_MAX_MSGS,
  activeDevices,
  canonicalRegistryString,
  deviceSuffixFromBytes,
  devicePartOf,
  isDeviceLeafId,
  isSyncableKv,
  makeLeafId,
  mergeContactLists,
  mergeMessages,
  mergeRoomLists,
  sameUser,
  shouldAcceptRemoteKv,
  toSyncedRoomEntry,
  userPartOf,
  validateDeviceRegistry,
  validateDlinkHello,
  validateDlinkHistory,
  validateDlinkKv,
  validateDlinkRekey,
  validatePersistedMessage,
  validateSyncedRoomEntry,
  type DeviceRegistry,
  type PersistedMessage,
} from "../../src/deviceSyncModel";

// ── Leaf identity ─────────────────────────────────────────────────────────────

describe("leaf identity", () => {
  it("parses the rigid #dev- suffix from the end", () => {
    expect(userPartOf("alice#dev-abcd2345")).toBe("alice");
    expect(devicePartOf("alice#dev-abcd2345")).toBe("abcd2345");
    expect(isDeviceLeafId("alice#dev-abcd2345")).toBe(true);
  });

  it("treats a bare id as its own user part (legacy compat)", () => {
    expect(userPartOf("alice")).toBe("alice");
    expect(devicePartOf("alice")).toBeNull();
    expect(isDeviceLeafId("alice")).toBe(false);
  });

  it("survives user names containing #", () => {
    expect(userPartOf("a#b#dev-abcd2345")).toBe("a#b");
    expect(userPartOf("a#dev-notbase32X")).toBe("a#dev-notbase32X"); // invalid suffix → bare
    expect(userPartOf("alice#dev-short")).toBe("alice#dev-short"); // wrong length → bare
  });

  it("groups linked devices under one user", () => {
    expect(sameUser("alice", "alice#dev-abcd2345")).toBe(true);
    expect(sameUser("alice#dev-abcd2345", "alice#dev-efgh6767")).toBe(true);
    expect(sameUser("alice", "bob")).toBe(false);
  });

  it("builds round-trippable leaf ids", () => {
    const suffix = deviceSuffixFromBytes(new Uint8Array([1, 2, 3, 4, 5]));
    expect(suffix).toHaveLength(8);
    const leaf = makeLeafId("alice", suffix);
    expect(userPartOf(leaf)).toBe("alice");
    expect(devicePartOf(leaf)).toBe(suffix);
  });

  it("derives a deterministic base32 suffix from bytes", () => {
    const a = deviceSuffixFromBytes(new Uint8Array([0, 0, 0, 0, 0]));
    expect(a).toBe("aaaaaaaa");
    expect(() => deviceSuffixFromBytes(new Uint8Array([1, 2]))).toThrow();
  });
});

// ── Device registry ───────────────────────────────────────────────────────────

function registry(overrides: Partial<DeviceRegistry> = {}): DeviceRegistry {
  return {
    v: DEVLINK_VERSION,
    user: "alice",
    rev: 3,
    devices: [
      {
        deviceId: "primary", label: "Desktop", kind: "desktop",
        leafId: "alice", nodeId: "node-a", addedAt: 1000,
      },
      {
        deviceId: "abcd2345", label: "Phone", kind: "mobile",
        leafId: "alice#dev-abcd2345", nodeId: "node-b", addedAt: 2000,
      },
    ],
    mac: "f".repeat(64),
    ...overrides,
  };
}

describe("device registry", () => {
  it("round-trips a valid registry", () => {
    expect(validateDeviceRegistry(registry())).toEqual(registry());
  });

  it("rejects bad shapes", () => {
    expect(validateDeviceRegistry(null)).toBeNull();
    expect(validateDeviceRegistry(registry({ v: 2 as never }))).toBeNull();
    expect(validateDeviceRegistry(registry({ mac: "nope" }))).toBeNull();
    expect(validateDeviceRegistry(registry({ rev: -1 }))).toBeNull();
    const dup = registry();
    dup.devices = [dup.devices[0], dup.devices[0]];
    expect(validateDeviceRegistry(dup)).toBeNull();
  });

  it("canonical string is stable across device order and excludes mac", () => {
    const a = registry();
    const b = registry({ devices: [...a.devices].reverse(), mac: "0".repeat(64) });
    expect(canonicalRegistryString(a)).toBe(canonicalRegistryString(b));
    expect(canonicalRegistryString(a)).not.toContain("mac");
  });

  it("activeDevices filters tombstones", () => {
    const reg = registry();
    reg.devices[1].revokedAt = 3000;
    expect(activeDevices(reg).map((d) => d.deviceId)).toEqual(["primary"]);
  });
});

// ── Persisted messages + merge ────────────────────────────────────────────────

function msg(id: string, ts: number, overrides: Partial<PersistedMessage> = {}): PersistedMessage {
  return {
    id, type: "mls_app", user: "alice", content: `m-${id}`,
    encrypted: true, ts, ...overrides,
  };
}

describe("persisted messages", () => {
  it("validates and strips presentation-free shape", () => {
    expect(validatePersistedMessage(msg("m1", 1))).toEqual(msg("m1", 1));
    expect(validatePersistedMessage({ ...msg("m1", 1), type: "system_info" })).toBeNull();
    expect(validatePersistedMessage({ ...msg("m1", 1), id: "" })).toBeNull();
    expect(validatePersistedMessage({ ...msg("m1", 1), ts: Number.NaN })).toBeNull();
  });

  it("keeps a valid map share and drops an invalid one", () => {
    const share = { type: "map_pin", v: 1, name: "Spot", lat: 52.4, lng: 16.9 };
    expect(validatePersistedMessage(msg("m1", 1, { map: share as never }))?.map).toEqual(share);
    const bad = { type: "map_pin", v: 1, name: "Spot", lat: 999, lng: 16.9 };
    expect(validatePersistedMessage(msg("m1", 1, { map: bad as never }))?.map).toBeUndefined();
  });

  it("mergeMessages dedupes by id, orders by ts, caps from the tail", () => {
    const local = [msg("a", 100), msg("b", 200)];
    const remote = [msg("b", 999, { content: "remote-b" }), msg("c", 150)];
    const merged = mergeMessages(local, remote, 100);
    expect(merged.map((m) => m.id)).toEqual(["a", "c", "b"]);
    expect(merged.find((m) => m.id === "b")?.content).toBe("m-b"); // local wins
    expect(mergeMessages(local, remote, 2).map((m) => m.id)).toEqual(["c", "b"]);
  });
});

// ── Allow-list ────────────────────────────────────────────────────────────────

describe("sync allow-list", () => {
  it("pins the exact replicated kv set (drift here must be deliberate)", () => {
    expect(DEVLINK_SYNC_KV).toEqual([
      { ns: "contacts", scope: "default", k: "" },
      { ns: "p2p:rooms", scope: "default", k: "" },
      { ns: "meetings", scope: "default", k: "" },
      { ns: "meetings", scope: "default", k: "polls" },
      { ns: "p2p:settings", scope: "default", k: "max_file_size_mb" },
      { ns: "p2p:settings", scope: "default", k: "meeting_reminder_mins" },
      { ns: "p2p:settings", scope: "default", k: "file_key_rotation_days" },
      { ns: "p2p:settings", scope: "default", k: "dht_room_publish_secs" },
    ]);
  });

  it("never syncs device-local or secret namespaces", () => {
    expect(isSyncableKv("p2p:settings", "default", "connect_timeout_secs")).toBe(false);
    expect(isSyncableKv("p2p:settings", "default", "map_storage_limit_mb")).toBe(false);
    expect(isSyncableKv("p2p:settings", "default", "map_active_region")).toBe(false);
    expect(isSyncableKv("map:regions", "default", "")).toBe(false);
    expect(isSyncableKv("cloud:auth", "https://x", "token")).toBe(false);
    expect(isSyncableKv("devices", "default", "link")).toBe(false);
    expect(isSyncableKv("kanban", "default", "room-1")).toBe(false);
    expect(isSyncableKv("chat:log", "room-1", "index")).toBe(false);
    // The mind map is local-only by design: never device-synced.
    expect(isSyncableKv("mind", "default", "")).toBe(false);
    expect(isSyncableKv("mind", "default", "dump")).toBe(false);
  });
});

// ── Room + contact merges ─────────────────────────────────────────────────────

describe("room-list merge", () => {
  it("strips per-device fields on the way out", () => {
    const synced = toSyncedRoomEntry({
      room: "r1", name: "Room", ticket: "t", onion: "abc.onion", host: true, peers: ["n1"],
    });
    expect(synced).toEqual({ room: "r1", name: "Room", ticket: "t", peers: ["n1"] });
  });

  it("unions rooms, prefers higher metaRev, unions peers, keeps local-only fields", () => {
    const local = [
      { room: "r1", name: "Old", ticket: "t1", metaRev: 1, peers: ["n1"], onion: "me.onion", host: true },
    ];
    const remote = [
      { room: "r1", name: "New", ticket: "", metaRev: 2, peers: ["n2"], rules: "be kind" },
      { room: "r2", name: "Fresh", ticket: "t2" },
    ];
    const { merged, changed } = mergeRoomLists(local, remote.map((r) => validateSyncedRoomEntry(r)!));
    expect(changed).toBe(true);
    const r1 = merged.find((r) => r.room === "r1") as (typeof local)[0] & { rules?: string };
    expect(r1.name).toBe("New");
    expect(r1.metaRev).toBe(2);
    expect(r1.rules).toBe("be kind");
    expect(r1.ticket).toBe("t1"); // non-empty local ticket kept
    expect([...(r1.peers ?? [])].sort()).toEqual(["n1", "n2"]);
    expect(r1.onion).toBe("me.onion"); // device-local survives merges
    expect(r1.host).toBe(true);
    expect(merged.some((r) => r.room === "r2")).toBe(true);
  });

  it("is idempotent", () => {
    const local = [{ room: "r1", name: "Room", ticket: "t1", peers: ["n1"] }];
    const first = mergeRoomLists(local, [{ room: "r1", name: "Room", ticket: "t1", peers: ["n1"] }]);
    expect(first.changed).toBe(false);
  });
});

describe("contact merge", () => {
  it("unions by nodeId; local name wins; earliest addedAt, latest lastSeen", () => {
    const local = [{ nodeId: "n1", name: "Ala", addedAt: 500, lastSeen: 900 }];
    const remote = [
      { nodeId: "n1", name: "Alicja", addedAt: 300, lastSeen: 1200 },
      { nodeId: "n2", name: "Bob", addedAt: 400 },
    ];
    const { merged, changed } = mergeContactLists(local, remote);
    expect(changed).toBe(true);
    const n1 = merged.find((c) => c.nodeId === "n1")!;
    expect(n1.name).toBe("Ala");
    expect(n1.addedAt).toBe(300);
    expect(n1.lastSeen).toBe(1200);
    expect(merged).toHaveLength(2);
  });

  it("LWW settings acceptance", () => {
    expect(shouldAcceptRemoteKv(undefined, 1)).toBe(true);
    expect(shouldAcceptRemoteKv(5, 5)).toBe(false);
    expect(shouldAcceptRemoteKv(5, 6)).toBe(true);
  });
});

// ── Wire payload validation ───────────────────────────────────────────────────

describe("dlink wire payloads", () => {
  it("validates hello", () => {
    const hello = {
      type: "dlink_hello", v: 1, registryRev: 2,
      rooms: [{ slug: "r1", latestTs: 100, count: 5 }],
      settingsMtime: { max_file_size_mb: 123 },
    };
    expect(validateDlinkHello(hello)).toEqual(hello);
    expect(validateDlinkHello({ ...hello, v: 2 })).toBeNull();
    expect(validateDlinkHello({ ...hello, rooms: [{ slug: "" }] })).toBeNull();
  });

  it("dlink_kv enforces the allow-list at the wire boundary", () => {
    const ok = { type: "dlink_kv", v: 1, ns: "contacts", scope: "default", k: "", val: "[]", mtime: 1 };
    expect(validateDlinkKv(ok)).toEqual(ok);
    expect(
      validateDlinkKv({ ...ok, ns: "p2p:settings", k: "connect_timeout_secs" }),
    ).toBeNull();
    expect(validateDlinkKv({ ...ok, ns: "mls" })).toBeNull();
  });

  it("dlink_history validates every message and the chunk arithmetic", () => {
    const h = {
      type: "dlink_history", v: 1, room: "r1",
      msgs: [msg("m1", 1)], chunk: 1, of: 2,
    };
    expect(validateDlinkHistory(h)).toEqual(h);
    expect(validateDlinkHistory({ ...h, chunk: 3 })).toBeNull();
    expect(validateDlinkHistory({ ...h, msgs: [{ nope: true }] })).toBeNull();
    const tooMany = { ...h, msgs: Array.from({ length: DLINK_HISTORY_CHUNK_MAX_MSGS + 1 }, (_, i) => msg(`m${i}`, i)) };
    expect(validateDlinkHistory(tooMany)).toBeNull();
  });

  it("dlink_rekey requires a b64 32-byte key and a room name", () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32)));
    const rk = { type: "dlink_rekey", v: 1, linkKey: key, roomName: "devlink-abc" };
    expect(validateDlinkRekey(rk)).toEqual(rk);
    expect(validateDlinkRekey({ ...rk, linkKey: "short" })).toBeNull();
    expect(validateDlinkRekey({ ...rk, roomName: "" })).toBeNull();
  });
});
