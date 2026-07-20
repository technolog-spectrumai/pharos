import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

// useDeviceSync pins: linkKey proof round-trip (admissionCheck ⇄ keyPackageExtra),
// hello-driven history push/pull, history merge into log + live timeline,
// contact/room kv merges (devlink room never leaks into the saved list),
// registry MAC + rev acceptance, self-revocation teardown, and unlink flows.
// The dev channel (useChatChannel) is mocked; storage is real localDb/localStorage.

const { fake } = vi.hoisted(() => ({
  fake: {
    options: null as Record<string, unknown> | null,
    dev: null as Record<string, unknown> | null,
    syncHandlers: [] as Array<(t: string, p: Record<string, unknown>, s: string) => void>,
  },
}));

vi.mock("../../src/useChatChannel", async () => {
  const { ref: vref } = await import("vue");
  return {
    useChatChannel: vi.fn((options: Record<string, unknown> = {}) => {
      fake.options = options;
      const dev = {
        mlsIdentity: vref("unset"),
        currentUserName: vref("unset"),
        mlsStatus: vref("ready"),
        isConnected: vref(false),
        currentRoom: vref<{ slug: string } | null>(null),
        joinByNode: vi.fn(async () => {}),
        sendSync: vi.fn(async () => {}),
        onSync: vi.fn((h: (t: string, p: Record<string, unknown>, s: string) => void) => {
          fake.syncHandlers.push(h);
          return () => {};
        }),
        clearLocalChatState: vi.fn(),
        removeLeaf: vi.fn(async () => {}),
      };
      fake.dev = dev;
      return dev;
    }),
  };
});

import { useDeviceSync, registryMac, kpProof } from "../../src/useDeviceSync";
import { appendMessages, loadLog } from "../../src/services/chatLog";
import { DEVLINK_VERSION, type DeviceRegistry, type PersistedMessage } from "../../src/deviceSyncModel";
import type { ChatChannel } from "../../src/useChatChannel";

const LINK_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function fakeMain() {
  return {
    p2pRooms: ref<{ room: string; name: string; ticket: string }[]>([]),
    loadP2pRooms: vi.fn(async () => {}),
    mergeHistory: vi.fn(),
    removeLeaf: vi.fn(async () => {}),
  } as unknown as ChatChannel;
}

async function seedLink(devices?: DeviceRegistry["devices"]) {
  const linkInfo = {
    v: 1, linkKey: LINK_KEY, roomName: "devlink-room", myDeviceId: "primary", myLeafId: "alice",
  };
  localStorage.setItem("enigma:db:devices:default:link", JSON.stringify(linkInfo));
  const reg: DeviceRegistry = {
    v: DEVLINK_VERSION, user: "alice", rev: 1,
    devices: devices ?? [
      { deviceId: "primary", label: "Desktop", kind: "desktop", leafId: "alice", nodeId: "node-a", addedAt: 1 },
      { deviceId: "abcd2345", label: "Phone", kind: "mobile", leafId: "alice#dev-abcd2345", nodeId: "node-b", addedAt: 2 },
    ],
    mac: "",
  };
  // Rust writes mac:"" — loadRegistry finalizes it on first touch.
  localStorage.setItem("enigma:db:devices:default:", JSON.stringify(reg));
  return reg;
}

function msg(id: string, ts: number): PersistedMessage {
  return { id, type: "mls_app", user: "Bob", deviceId: "bob", content: `m-${id}`, encrypted: true, ts };
}

function devSyncSends(type: string) {
  const sendSync = (fake.dev as { sendSync: ReturnType<typeof vi.fn> }).sendSync;
  return sendSync.mock.calls.filter(([t]) => t === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.options = null;
  fake.dev = null;
  fake.syncHandlers.length = 0;
  localStorage.clear();
});

describe("link proof round-trip", () => {
  it("admissionCheck accepts exactly what keyPackageExtra attaches", async () => {
    await seedLink();
    const sync = useDeviceSync(fakeMain());
    await sync.start();
    expect(sync.linked.value).toBe(true);

    const extra = await (fake.options!.keyPackageExtra as (kp: string) => Promise<Record<string, string>>)("kp-b64");
    expect(extra.link_proof).toMatch(/^[0-9a-f]{64}$/);

    const check = fake.options!.admissionCheck as (d: Record<string, unknown>) => Promise<boolean>;
    expect(await check({ key_package: "kp-b64", link_proof: extra.link_proof })).toBe(true);
    expect(await check({ key_package: "kp-b64", link_proof: "0".repeat(64) })).toBe(false);
    expect(await check({ key_package: "kp-b64" })).toBe(false);
  });

  it("finalizes a Rust-written mac:\"\" registry on load", async () => {
    await seedLink();
    const sync = useDeviceSync(fakeMain());
    await sync.start();
    const stored = JSON.parse(localStorage.getItem("enigma:db:devices:default:")!);
    expect(stored.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(await registryMac(LINK_KEY, stored)).toBe(stored.mac);
  });
});

describe("hello-driven convergence", () => {
  it("pushes history the peer misses and requests what we miss", async () => {
    await seedLink();
    const main = fakeMain();
    (main.p2pRooms.value as unknown[]).push({ room: "r1", name: "Room", ticket: "t" });
    await appendMessages("r1", [msg("a", 100), msg("b", 200)], 500);

    const sync = useDeviceSync(main);
    await sync.start();
    await sync._internal.onHello({
      type: "dlink_hello", v: 1, registryRev: 1,
      rooms: [
        { slug: "r1", latestTs: 100, count: 1 },   // they miss "b"
        { slug: "r2", latestTs: 999, count: 3 },   // we miss r2 entirely
      ],
      settingsMtime: {},
    });

    const history = devSyncSends("dlink_history");
    expect(history).toHaveLength(1);
    const payload = history[0][1] as { room: string; msgs: PersistedMessage[] };
    expect(payload.room).toBe("r1");
    expect(payload.msgs.map((m) => m.id)).toEqual(["b"]);

    const reqs = devSyncSends("dlink_history_req");
    expect(reqs.map(([, p]) => (p as { room: string }).room)).toContain("r2");
  });

  it("merges received history into the log and the live timeline", async () => {
    await seedLink();
    const main = fakeMain();
    const sync = useDeviceSync(main);
    await sync.start();
    await sync._internal.onHistory({
      type: "dlink_history", v: 1, room: "r1",
      msgs: [msg("x", 10), msg("y", 20)], chunk: 1, of: 1,
    });
    expect((await loadLog("r1")).map((m) => m.id)).toEqual(["x", "y"]);
    expect(main.mergeHistory).toHaveBeenCalledWith("r1", expect.arrayContaining([
      expect.objectContaining({ id: "x" }),
    ]));
    // Idempotent: replay adds nothing and skips the live merge.
    (main.mergeHistory as ReturnType<typeof vi.fn>).mockClear();
    await sync._internal.onHistory({
      type: "dlink_history", v: 1, room: "r1", msgs: [msg("x", 10)], chunk: 1, of: 1,
    });
    expect(main.mergeHistory).not.toHaveBeenCalled();
  });
});

describe("kv merges", () => {
  it("merges contacts by nodeId", async () => {
    await seedLink();
    localStorage.setItem(
      "enigma:db:contacts:default:",
      JSON.stringify([{ nodeId: "n1", name: "Ala", addedAt: 500 }]),
    );
    const sync = useDeviceSync(fakeMain());
    await sync.start();
    await sync._internal.onKv({
      type: "dlink_kv", v: 1, ns: "contacts", scope: "default", k: "",
      val: JSON.stringify([
        { nodeId: "n1", name: "Alicja", addedAt: 300 },
        { nodeId: "n2", name: "Bob", addedAt: 400 },
      ]),
      mtime: Date.now(),
    });
    const merged = JSON.parse(localStorage.getItem("enigma:db:contacts:default:")!);
    expect(merged).toHaveLength(2);
    expect(merged.find((c: { nodeId: string }) => c.nodeId === "n1").name).toBe("Ala");
    expect(merged.find((c: { nodeId: string }) => c.nodeId === "n1").addedAt).toBe(300);
  });

  it("merges rooms but never lets a devlink room into the saved list", async () => {
    await seedLink();
    const main = fakeMain();
    (main.p2pRooms.value as unknown[]).push({ room: "r1", name: "Mine", ticket: "t1" });
    const sync = useDeviceSync(main);
    await sync.start();
    await sync._internal.onKv({
      type: "dlink_kv", v: 1, ns: "p2p:rooms", scope: "default", k: "",
      val: JSON.stringify([
        { room: "r2", name: "New", ticket: "t2" },
        { room: "devlink-abc", name: "devlink-abc", ticket: "" },
      ]),
      mtime: Date.now(),
    });
    const saved = JSON.parse(localStorage.getItem("enigma:db:p2p:rooms:default:")!);
    expect(saved.map((r: { room: string }) => r.room).sort()).toEqual(["r1", "r2"]);
    expect(main.loadP2pRooms).toHaveBeenCalled();
  });
});

describe("registry handling", () => {
  it("accepts a higher-rev registry with a valid MAC, rejects a bad MAC", async () => {
    await seedLink();
    const sync = useDeviceSync(fakeMain());
    await sync.start();
    const base = sync.registry.value!;

    const next: Omit<DeviceRegistry, "mac"> = { ...base, rev: base.rev + 1 };
    const good: DeviceRegistry = { ...next, mac: await registryMac(LINK_KEY, next) };
    await sync._internal.onRegistry({ type: "dlink_registry", v: 1, registry: good });
    expect(sync.registry.value?.rev).toBe(base.rev + 1);

    const forged: DeviceRegistry = { ...next, rev: next.rev + 5, mac: "f".repeat(64) };
    await sync._internal.onRegistry({ type: "dlink_registry", v: 1, registry: forged });
    expect(sync.registry.value?.rev).toBe(base.rev + 1); // unchanged
  });

  it("tears the link down when WE are revoked", async () => {
    await seedLink();
    const sync = useDeviceSync(fakeMain());
    await sync.start();
    const base = sync.registry.value!;
    const next: Omit<DeviceRegistry, "mac"> = {
      ...base, rev: base.rev + 1,
      devices: base.devices.map((d) =>
        d.deviceId === "primary" ? { ...d, revokedAt: 123 } : d,
      ),
    };
    const signed: DeviceRegistry = { ...next, mac: await registryMac(LINK_KEY, next) };
    await sync._internal.onRegistry({ type: "dlink_registry", v: 1, registry: signed });
    expect(sync.linked.value).toBe(false);
    expect(localStorage.getItem("enigma:db:devices:default:link")).toBeNull();
  });
});

describe("unlink", () => {
  it("2-device unlink tears the whole link down", async () => {
    await seedLink();
    const sync = useDeviceSync(fakeMain());
    await sync.start();
    await sync.unlinkDevice("abcd2345");
    expect(sync.linked.value).toBe(false);
    expect(localStorage.getItem("enigma:db:devices:default:")).toBeNull();
  });

  it("N>2 unlink tombstones, evicts the leaf, and broadcasts the registry", async () => {
    await seedLink([
      { deviceId: "primary", label: "Desktop", kind: "desktop", leafId: "alice", nodeId: "node-a", addedAt: 1 },
      { deviceId: "abcd2345", label: "Phone", kind: "mobile", leafId: "alice#dev-abcd2345", nodeId: "node-b", addedAt: 2 },
      { deviceId: "efgh6767", label: "Tablet", kind: "mobile", leafId: "alice#dev-efgh6767", nodeId: "node-c", addedAt: 3 },
    ]);
    const sync = useDeviceSync(fakeMain());
    await sync.start();
    await sync.unlinkDevice("abcd2345");

    expect(sync.linked.value).toBe(true);
    const reg = sync.registry.value!;
    expect(reg.devices.find((d) => d.deviceId === "abcd2345")?.revokedAt).toBeTruthy();
    const dev = fake.dev as { removeLeaf: ReturnType<typeof vi.fn> };
    expect(dev.removeLeaf).toHaveBeenCalledWith("alice#dev-abcd2345");
    expect(devSyncSends("dlink_registry").length).toBeGreaterThan(0);
  });

  it("enforceRevocations removes revoked leaves from the open room", async () => {
    await seedLink([
      { deviceId: "primary", label: "Desktop", kind: "desktop", leafId: "alice", nodeId: "node-a", addedAt: 1 },
      { deviceId: "abcd2345", label: "Phone", kind: "mobile", leafId: "alice#dev-abcd2345", nodeId: "node-b", addedAt: 2, revokedAt: 5 },
    ]);
    const main = fakeMain();
    const sync = useDeviceSync(main);
    await sync.start();
    await sync.enforceRevocations();
    expect(main.removeLeaf).toHaveBeenCalledWith("alice#dev-abcd2345");
  });
});

describe("kpProof determinism", () => {
  it("is stable and key-bound", async () => {
    const a = await kpProof(LINK_KEY, "kp");
    expect(a).toBe(await kpProof(LINK_KEY, "kp"));
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    expect(a).not.toBe(await kpProof(other, "kp"));
  });
});
