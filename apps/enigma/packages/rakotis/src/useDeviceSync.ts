// Linked-device ongoing sync — the runtime half of multi-device (pairing is
// Rust: src-tauri/device_link.rs). Owns a HEADLESS second chat channel joined
// to the hidden device room ("devlink-…", name derived Rust-side from the link
// key), and converges state with the user's other devices over `dlink_*` inner
// messages through the stock MLS seam:
//
//   • hello        — per-room log summary + registry rev + settings mtimes
//   • registry     — HMAC(linkKey)-authenticated device list (rev wins)
//   • kv           — allow-listed namespaces, semantic merges (contacts/rooms
//                    union, meetings + settings LWW by recorded mtime)
//   • history_req / history — chunked replay of the persisted chat log,
//                    deduped by sender-minted msg ids
//   • rekey        — fresh link key after an unlink (N>2), sent through the
//                    post-removal MLS epoch so the removed device is out
//
// Admission to the hidden room is double-gated: the topic is unguessable AND
// every key package must carry `link_proof` = HMAC(linkKey, kp) — checked by
// the channel's admissionCheck, attached by its keyPackageExtra.
//
// Live traffic needs none of this: both devices are independent members of
// every room, so messages arrive on each directly. This channel only carries
// catch-up + registry/kv convergence while both devices are online together.

import { ref, computed, watch } from "vue";
import { useChatChannel, type ChatChannel } from "./useChatChannel";
import { kvGet, kvPut, kvDelete, kvClearNamespace } from "./services/localDb";
import { getDevlinkResyncSecs, getChatHistoryCapMsgs } from "./services/appStorage";
import { logMeta, mergeIntoLog, messagesSince } from "./services/chatLog";
import {
  DEVLINK_SYNC_KV, DEVLINK_VERSION, DLINK_HISTORY_CHUNK_MAX_MSGS,
  LINK_HMAC_LABEL_KP, LINK_HMAC_LABEL_REGISTRY,
  activeDevices, canonicalRegistryString,
  mergeContactLists, mergeRoomLists, shouldAcceptRemoteKv,
  validateDeviceRegistry, validateDlinkHello, validateDlinkHistory,
  validateDlinkHistoryReq, validateDlinkKv,
  validateSyncedContact, validateSyncedRoomEntry,
  type DeviceLinkInfo, type DeviceRegistry, type DlinkHello,
} from "./deviceSyncModel";

const NS = "devices";
const SCOPE = "default";
const KEY_REGISTRY = "";
const KEY_LINK = "link";
const KEY_REVS = "revs";

const SETTINGS_KEYS = DEVLINK_SYNC_KV
  .filter((e) => e.ns === "p2p:settings")
  .map((e) => e.k);
// Semantic-merge namespaces (contacts, rooms): union/field merges, no clock.
const SEMANTIC_KEYS = DEVLINK_SYNC_KV.filter((e) => e.ns === "contacts" || e.ns === "p2p:rooms");
// LWW-by-value namespaces (meetings + polls): a recorded mtime that bumps only
// when the LOCAL value changes — never send-time (that would always win).
const LWW_KEYS = DEVLINK_SYNC_KV.filter((e) => e.ns === "meetings");

/** Locally recorded per-key sync clocks (never leaves the device). */
interface SyncRevs {
  settings: Record<string, { val: string; mtime: number }>;
  lww: Record<string, { val: string; mtime: number }>; // "<ns>|<k>" LWW clock
}

// ── WebCrypto HMAC-SHA256 (the one MAC implementation — Rust defers to it) ────

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(linkKeyB64: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", b64ToBytes(linkKeyB64).slice().buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

export async function registryMac(linkKeyB64: string, reg: Omit<DeviceRegistry, "mac">): Promise<string> {
  return hmacHex(linkKeyB64, `${LINK_HMAC_LABEL_REGISTRY}\0${canonicalRegistryString(reg)}`);
}

export async function kpProof(linkKeyB64: string, kpB64: string): Promise<string> {
  return hmacHex(linkKeyB64, `${LINK_HMAC_LABEL_KP}\0${kpB64}`);
}

// ── composable ────────────────────────────────────────────────────────────────

export function useDeviceSync(main: ChatChannel) {
  const linked = ref(false);
  const registry = ref<DeviceRegistry | null>(null);
  const link = ref<DeviceLinkInfo | null>(null);
  const lastSyncAt = ref(0);
  const syncing = ref(false);

  const dev = useChatChannel({
    headless: true,
    admissionCheck: async (data) => {
      const info = link.value;
      if (!info) return false;
      // A revoked device is refused re-admission even with a valid proof: MLS
      // removal cuts its current membership, and this closes the re-request
      // hole (it may still hold the shared linkKey). Enforced as soon as this
      // device holds the tombstoned registry rev.
      const senderLeaf = (data.device_id as string) || "";
      const reg = registry.value;
      if (reg && reg.devices.some((d) => d.leafId === senderLeaf && d.revokedAt)) return false;
      const kp = (data.key_package ?? data.package) as string | undefined;
      const proof = data.link_proof as string | undefined;
      if (!kp || !proof) return false;
      try {
        return proof === (await kpProof(info.linkKey, kp));
      } catch {
        return false;
      }
    },
    keyPackageExtra: async (kpB64) => {
      const info = link.value;
      if (!info) return {};
      return { link_proof: await kpProof(info.linkKey, kpB64) };
    },
  });

  const devOnline = computed(() => dev.isConnected.value && dev.mlsStatus.value === "ready");

  let tick: ReturnType<typeof setInterval> | null = null;
  let started = false;

  // ── stored state helpers ────────────────────────────────────────────────────

  async function loadRevs(): Promise<SyncRevs> {
    try {
      const raw = await kvGet(NS, SCOPE, KEY_REVS);
      const parsed = raw ? (JSON.parse(raw) as SyncRevs) : null;
      return { settings: parsed?.settings ?? {}, lww: parsed?.lww ?? {} };
    } catch {
      return { settings: {}, lww: {} };
    }
  }

  async function saveRevs(revs: SyncRevs): Promise<void> {
    await kvPut(NS, SCOPE, KEY_REVS, JSON.stringify(revs)).catch(() => {});
  }

  /** Bump the recorded LWW clock for each meetings key whose LOCAL value has
   *  changed since we last looked (mirrors refreshSettingsRevs). The recorded
   *  mtime — NOT send-time — is what rides dlink_kv, so a routine hello push
   *  never out-clocks a peer's newer edit. */
  async function refreshLwwRevs(revs: SyncRevs): Promise<SyncRevs> {
    let changed = false;
    for (const e of LWW_KEYS) {
      const key = `${e.ns}|${e.k}`;
      const val = (await kvGet(e.ns, e.scope, e.k).catch(() => null)) ?? "";
      const rec = revs.lww[key];
      if (!rec || rec.val !== val) {
        revs.lww[key] = { val, mtime: Date.now() };
        changed = true;
      }
    }
    if (changed) await saveRevs(revs);
    return revs;
  }

  async function loadLink(): Promise<DeviceLinkInfo | null> {
    try {
      const raw = await kvGet(NS, SCOPE, KEY_LINK);
      const parsed = raw ? (JSON.parse(raw) as DeviceLinkInfo) : null;
      return parsed?.linkKey && parsed.roomName ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Load the stored registry; finalize a Rust-written `mac:""` on first touch
   *  (pairing writes it unMACed — the MAC implementation lives here only). */
  async function loadRegistry(info: DeviceLinkInfo): Promise<DeviceRegistry | null> {
    try {
      const raw = await kvGet(NS, SCOPE, KEY_REGISTRY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as DeviceRegistry;
      if (parsed?.mac === "") {
        parsed.mac = await registryMac(info.linkKey, parsed);
        await kvPut(NS, SCOPE, KEY_REGISTRY, JSON.stringify(parsed)).catch(() => {});
      }
      const valid = validateDeviceRegistry(parsed);
      if (!valid) return null;
      const expected = await registryMac(info.linkKey, valid);
      return valid.mac === expected ? valid : null;
    } catch {
      return null;
    }
  }

  async function saveRegistry(info: DeviceLinkInfo, reg: Omit<DeviceRegistry, "mac">): Promise<DeviceRegistry> {
    const mac = await registryMac(info.linkKey, reg);
    const full: DeviceRegistry = { ...reg, mac };
    await kvPut(NS, SCOPE, KEY_REGISTRY, JSON.stringify(full)).catch(() => {});
    registry.value = full;
    return full;
  }

  // ── hidden-room lifecycle ───────────────────────────────────────────────────

  async function connectDevRoom(): Promise<void> {
    const info = link.value;
    const reg = registry.value;
    if (!info || !reg) return;
    // Already joined to the CURRENT hidden room — nothing to do. Gating on the
    // room name (not just isConnected) means a room change re-joins: `wsStatus`
    // isn't reset by clearLocalChatState, so an isConnected-only guard would
    // strand the channel after a teardown + re-pair.
    if (dev.currentRoom.value?.slug === info.roomName && dev.isConnected.value) return;
    const peers = activeDevices(reg)
      .filter((d) => d.deviceId !== info.myDeviceId)
      .map((d) => d.nodeId)
      .filter(Boolean);
    if (!peers.length) return;
    dev.mlsIdentity.value = info.myLeafId;
    dev.currentUserName.value = info.myLeafId;
    await dev.joinByNode(info.roomName, peers).catch(() => {});
  }

  // ── outbound convergence ────────────────────────────────────────────────────

  async function refreshSettingsRevs(): Promise<SyncRevs> {
    const revs = await loadRevs();
    let changed = false;
    for (const k of SETTINGS_KEYS) {
      const val = (await kvGet("p2p:settings", SCOPE, k).catch(() => null)) ?? "";
      const rec = revs.settings[k];
      if (!rec || rec.val !== val) {
        revs.settings[k] = { val, mtime: Date.now() };
        changed = true;
      }
    }
    if (changed) await saveRevs(revs);
    return revs;
  }

  async function buildHello(): Promise<DlinkHello> {
    const revs = await refreshSettingsRevs();
    const rooms = [];
    for (const entry of main.p2pRooms.value) {
      const meta = await logMeta(entry.room);
      rooms.push({ slug: entry.room, latestTs: meta.latestTs, count: meta.count });
    }
    const settingsMtime: Record<string, number> = {};
    for (const [k, rec] of Object.entries(revs.settings)) settingsMtime[k] = rec.mtime;
    return {
      type: "dlink_hello", v: DEVLINK_VERSION,
      registryRev: registry.value?.rev ?? 0,
      rooms, settingsMtime,
    };
  }

  async function sendHello(): Promise<void> {
    if (!devOnline.value) return;
    await dev.sendSync("dlink_hello", { ...(await buildHello()) }).catch(() => {});
    lastSyncAt.value = Date.now();
  }

  async function sendHistory(room: string, sinceTs: number): Promise<void> {
    const msgs = await messagesSince(room, sinceTs);
    if (!msgs.length) return;
    const chunks = [];
    for (let i = 0; i < msgs.length; i += DLINK_HISTORY_CHUNK_MAX_MSGS) {
      chunks.push(msgs.slice(i, i + DLINK_HISTORY_CHUNK_MAX_MSGS));
    }
    for (let i = 0; i < chunks.length; i++) {
      await dev
        .sendSync("dlink_history", {
          v: DEVLINK_VERSION, room, msgs: chunks[i], chunk: i + 1, of: chunks.length,
        })
        .catch(() => {});
    }
  }

  async function pushMergeableKv(): Promise<void> {
    // Semantic-merge namespaces: mtime is irrelevant to the receiver (it does a
    // union/field merge), so any value works.
    for (const e of SEMANTIC_KEYS) {
      const val = await kvGet(e.ns, e.scope, e.k).catch(() => null);
      if (val === null || val === "") continue;
      await dev
        .sendSync("dlink_kv", { v: DEVLINK_VERSION, ns: e.ns, scope: e.scope, k: e.k, val, mtime: Date.now() })
        .catch(() => {});
    }
    // LWW namespaces (meetings): send the RECORDED change-time, so the receiver
    // only overwrites when our copy is genuinely newer than its own.
    const revs = await refreshLwwRevs(await loadRevs());
    for (const e of LWW_KEYS) {
      const rec = revs.lww[`${e.ns}|${e.k}`];
      if (!rec || rec.val === "") continue;
      await dev
        .sendSync("dlink_kv", { v: DEVLINK_VERSION, ns: e.ns, scope: e.scope, k: e.k, val: rec.val, mtime: rec.mtime })
        .catch(() => {});
    }
  }

  // ── inbound handlers ────────────────────────────────────────────────────────

  async function onHello(payload: Record<string, unknown>): Promise<void> {
    const hello = validateDlinkHello(payload);
    if (!hello) return;
    // Registry: higher rev pushes.
    if ((registry.value?.rev ?? 0) > hello.registryRev && registry.value) {
      await dev.sendSync("dlink_registry", { v: DEVLINK_VERSION, registry: registry.value }).catch(() => {});
    }
    // Merge-type namespaces are cheap + idempotent: push them on every hello.
    await pushMergeableKv();
    // Settings: push only keys where our clock is ahead.
    const revs = await refreshSettingsRevs();
    for (const [k, rec] of Object.entries(revs.settings)) {
      if (shouldAcceptRemoteKv(hello.settingsMtime[k], rec.mtime)) {
        await dev
          .sendSync("dlink_kv", { v: DEVLINK_VERSION, ns: "p2p:settings", scope: SCOPE, k, val: rec.val, mtime: rec.mtime })
          .catch(() => {});
      }
    }
    // History: push what they miss; pull what we miss.
    const theirRooms = new Map(hello.rooms.map((r) => [r.slug, r]));
    for (const entry of main.p2pRooms.value) {
      const ours = await logMeta(entry.room);
      const theirs = theirRooms.get(entry.room);
      if (ours.latestTs > (theirs?.latestTs ?? 0)) {
        await sendHistory(entry.room, theirs?.latestTs ?? 0);
      }
    }
    for (const theirs of hello.rooms) {
      const ours = await logMeta(theirs.slug);
      if (theirs.latestTs > ours.latestTs) {
        await dev
          .sendSync("dlink_history_req", { v: DEVLINK_VERSION, room: theirs.slug, sinceTs: ours.latestTs })
          .catch(() => {});
      }
    }
    lastSyncAt.value = Date.now();
  }

  async function onRegistry(payload: Record<string, unknown>): Promise<void> {
    const info = link.value;
    const frame = validateDlinkRegistry(payload);
    if (!info || !frame) return;
    const incoming = frame.registry;
    if (incoming.rev <= (registry.value?.rev ?? -1)) return;
    const expected = await registryMac(info.linkKey, incoming);
    if (incoming.mac !== expected) return;
    await kvPut(NS, SCOPE, KEY_REGISTRY, JSON.stringify(incoming)).catch(() => {});
    registry.value = incoming;
    // Were WE revoked? Tear the link down locally (our leaves get removed from
    // rooms by the remaining devices).
    const me = incoming.devices.find((d) => d.deviceId === info.myDeviceId);
    if (me?.revokedAt) await teardownLink();
  }

  function validateDlinkRegistry(payload: Record<string, unknown>) {
    if (payload.type !== "dlink_registry" || payload.v !== DEVLINK_VERSION) return null;
    const registry = validateDeviceRegistry(payload.registry);
    return registry ? { registry } : null;
  }

  async function onKv(payload: Record<string, unknown>): Promise<void> {
    const frame = validateDlinkKv(payload);
    if (!frame) return;
    const revs = await loadRevs();
    if (frame.ns === "contacts") {
      const localRaw = await kvGet("contacts", SCOPE, "").catch(() => null);
      const localParsed: unknown[] = localRaw ? (JSON.parse(localRaw) as unknown[]) : [];
      const local = localParsed
        .map(validateSyncedContact)
        .filter((c): c is NonNullable<typeof c> => c !== null);
      const remote = (JSON.parse(frame.val) as unknown[])
        .map(validateSyncedContact)
        .filter((c): c is NonNullable<typeof c> => c !== null);
      const { merged, changed } = mergeContactLists(local, remote);
      if (changed) await kvPut("contacts", SCOPE, "", JSON.stringify(merged)).catch(() => {});
    } else if (frame.ns === "p2p:rooms") {
      const remote = (JSON.parse(frame.val) as unknown[])
        .map(validateSyncedRoomEntry)
        .filter((r): r is NonNullable<typeof r> => r !== null)
        // The hidden devlink room must never leak into the saved list.
        .filter((r) => !r.room.startsWith("devlink-") && !r.name.startsWith("devlink-"));
      const { merged, changed } = mergeRoomLists(main.p2pRooms.value, remote);
      if (changed) {
        await kvPut("p2p:rooms", SCOPE, "", JSON.stringify(merged)).catch(() => {});
        await main.loadP2pRooms();
      }
    } else if (frame.ns === "meetings") {
      const key = `${frame.ns}|${frame.k}`;
      // Compare against OUR recorded change-clock first so a peer's stale copy
      // (recorded mtime) can't overwrite a newer local edit.
      const withLocal = await refreshLwwRevs(revs);
      if (shouldAcceptRemoteKv(withLocal.lww[key]?.mtime, frame.mtime)) {
        await kvPut(frame.ns, frame.scope, frame.k, frame.val).catch(() => {});
        withLocal.lww[key] = { val: frame.val, mtime: frame.mtime };
        await saveRevs(withLocal);
      }
    } else if (frame.ns === "p2p:settings") {
      const rec = revs.settings[frame.k];
      if (shouldAcceptRemoteKv(rec?.mtime, frame.mtime)) {
        await kvPut(frame.ns, frame.scope, frame.k, frame.val).catch(() => {});
        revs.settings[frame.k] = { val: frame.val, mtime: frame.mtime };
        await saveRevs(revs);
      }
    }
  }

  async function onHistoryReq(payload: Record<string, unknown>): Promise<void> {
    const frame = validateDlinkHistoryReq(payload);
    if (!frame) return;
    await sendHistory(frame.room, frame.sinceTs);
  }

  async function onHistory(payload: Record<string, unknown>): Promise<void> {
    const frame = validateDlinkHistory(payload);
    if (!frame) return;
    const cap = await getChatHistoryCapMsgs();
    const added = await mergeIntoLog(frame.room, frame.msgs, cap);
    if (added > 0) main.mergeHistory(frame.room, frame.msgs);
    lastSyncAt.value = Date.now();
  }

  dev.onSync((type, payload) => {
    if (type === "dlink_hello") void onHello(payload);
    else if (type === "dlink_registry") void onRegistry(payload);
    else if (type === "dlink_kv") void onKv(payload);
    else if (type === "dlink_history_req") void onHistoryReq(payload);
    else if (type === "dlink_history") void onHistory(payload);
    // dlink_rekey / dlink_room_admit_req are reserved wire types (validators in
    // deviceSyncModel), not used in v1: revocation cuts access via MLS removal +
    // the registry tombstone rather than key rotation (see sync.md).
  });

  watch(devOnline, (online) => {
    if (online) void sendHello();
  });

  // ── unlink ─────────────────────────────────────────────────────────────────

  async function teardownLink(): Promise<void> {
    stop();
    await kvDelete(NS, SCOPE, KEY_LINK).catch(() => {});
    await kvDelete(NS, SCOPE, KEY_REGISTRY).catch(() => {});
    await kvClearNamespace(NS, SCOPE).catch(() => {});
    link.value = null;
    registry.value = null;
    linked.value = false;
    await dev.clearLocalChatState();
  }

  /** Unlink a device: tombstone it in the registry (rev+1, re-MAC, broadcast),
   *  evict its leaf from the hidden room, and — N>2 — rotate the link key
   *  through the post-removal epoch. Unlinking the last other device tears the
   *  whole link down. The revoked leaf's room memberships are enforced lazily:
   *  `enforceRevocations()` removes revoked leaves from whichever room is open. */
  async function unlinkDevice(deviceId: string): Promise<void> {
    const info = link.value;
    const reg = registry.value;
    if (!info || !reg || deviceId === info.myDeviceId) return;
    const target = reg.devices.find((d) => d.deviceId === deviceId);
    if (!target || target.revokedAt) return;

    // 1. Tombstone the device (rev+1, re-MAC) so admissionCheck and every
    //    remaining device refuse it. Revocation is enforced by MLS removal +
    //    the registry tombstone, NOT by rotating the shared linkKey — a rekey
    //    is undeliverable to an offline sibling and would split the link.
    const next: Omit<DeviceRegistry, "mac"> = {
      v: DEVLINK_VERSION, user: reg.user, rev: reg.rev + 1,
      devices: reg.devices.map((d) =>
        d.deviceId === deviceId ? { ...d, revokedAt: Date.now() } : d,
      ),
    };
    await saveRegistry(info, next);

    // 2. Evict the revoked leaf from the devlink group and (best-effort) the
    //    open main room, and broadcast the tombstoned registry — reaching the
    //    revoked device too, so it self-tears-down (onRegistry) if online.
    await dev.removeLeaf(target.leafId).catch(() => {});
    await main.removeLeaf(target.leafId).catch(() => {});
    await dev.sendSync("dlink_registry", { v: DEVLINK_VERSION, registry: registry.value }).catch(() => {});

    // 3. If no linked devices remain, drop the whole link locally. The tombstone
    //    broadcast above already went out; further cross-room enforcement is
    //    moot with nothing left to sync.
    const remaining = registry.value
      ? activeDevices(registry.value).filter((d) => d.deviceId !== info.myDeviceId)
      : [];
    if (!remaining.length) await teardownLink();
  }

  /** Enforce registry tombstones on the currently open room: any revoked leaf
   *  still in the MLS group gets removed (exact-identity, one leaf). */
  async function enforceRevocations(): Promise<void> {
    const reg = registry.value;
    if (!reg) return;
    const revoked = reg.devices.filter((d) => d.revokedAt).map((d) => d.leafId);
    for (const leafId of revoked) {
      await main.removeLeaf(leafId).catch(() => {});
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async function refresh(): Promise<void> {
    const info = await loadLink();
    link.value = info;
    registry.value = info ? await loadRegistry(info) : null;
    linked.value = !!info && !!registry.value;
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh();
    if (!linked.value) {
      started = false;
      return;
    }
    syncing.value = true;
    await connectDevRoom();
    const secs = await getDevlinkResyncSecs();
    tick = setInterval(() => {
      void (async () => {
        await refresh();
        if (!linked.value) {
          stop();
          return;
        }
        if (!dev.isConnected.value) await connectDevRoom();
        else if (devOnline.value) await sendHello();
        await enforceRevocations();
      })();
    }, secs * 1000);
  }

  function stop(): void {
    if (tick) {
      clearInterval(tick);
      tick = null;
    }
    syncing.value = false;
    started = false;
  }

  return {
    linked, registry, link, lastSyncAt, syncing,
    devStatus: dev.mlsStatus, devConnected: dev.isConnected,
    start, stop, refresh, unlinkDevice, teardownLink, enforceRevocations,
    sendHello,
    // exposed for tests
    _internal: { onHello, onKv, onHistory, onRegistry, buildHello, dev },
  };
}

export type DeviceSync = ReturnType<typeof useDeviceSync>;
