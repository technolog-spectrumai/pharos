// Device-link model — pure types, leaf-identity helpers, validation, and merge
// logic for the multi-device (linked devices) feature. No Vue/Tauri imports
// (mapModel.ts pattern): everything here is wire- and storage-shape logic
// shared by useDeviceSync, the chat log, the Devices UI, and (field-for-field)
// the Rust pairing-bundle path in device_link.rs.
//
// Wire safety: every payload that can arrive over the devlink MLS seam is
// re-validated here on receive — never trust a wire object. The hidden room
// name and all key material are minted in Rust (blake3/HMAC live there and in
// WebCrypto); this module only carries them.

import type {
  MapLocationShare, MapPinShare, MapRegionShare,
} from "./mapModel";
import {
  validateLocationShare, validatePinShare, validateRegionShare,
} from "./mapModel";

// ── Caps (shared by send + receive validation) ────────────────────────────────

export const DEVLINK_VERSION = 1;
export const DEVICE_LABEL_MAX_LEN = 60;
export const DEVICE_SUFFIX_LEN = 8;
/** Max linked devices per user — a UI/abuse rail, not a protocol limit. */
export const DEVLINK_MAX_DEVICES = 8;
/** Messages per dlink_history frame (well under network.max_frame_bytes). */
export const DLINK_HISTORY_CHUNK_MAX_MSGS = 100;
/** Segment size of the persisted chat log (bounds the sealed value rewritten
 *  per append — never one giant blob per room). */
export const CHAT_LOG_SEG_MAX_MSGS = 100;
export const MSG_ID_MAX_LEN = 64;
export const MSG_CONTENT_MAX_LEN = 16384;
/** Media data-URL cap per persisted message (downscaled JPEG / voice clip). */
export const MSG_MEDIA_MAX_LEN = 8 * 1024 * 1024;

/** HMAC input labels (domain separation for linkKey-derived proofs). The Rust
 *  side mirrors these byte-for-byte. */
export const LINK_HMAC_LABEL_KP = "enigma/devlink/v1/kp";
export const LINK_HMAC_LABEL_REGISTRY = "enigma/devlink/v1/registry";

// ── Leaf identity ─────────────────────────────────────────────────────────────
// A linked (secondary) device's MLS leaf identity is "<user>#dev-<8 base32>".
// The primary keeps its bare identity (its user part is itself) so existing
// room memberships never churn. The suffix is rigid — user names containing
// "#" stay safe because the regex anchors the "#dev-xxxxxxxx" tail.

export const LEAF_SUFFIX_RE = /^(.+)#dev-([a-z2-7]{8})$/;

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** The user part of a leaf identity; a bare (non-device) id is its own user. */
export function userPartOf(id: string): string {
  const m = LEAF_SUFFIX_RE.exec(id);
  return m ? m[1] : id;
}

/** The device suffix of a leaf identity, or null for a bare id. */
export function devicePartOf(id: string): string | null {
  const m = LEAF_SUFFIX_RE.exec(id);
  return m ? m[2] : null;
}

export function isDeviceLeafId(id: string): boolean {
  return LEAF_SUFFIX_RE.test(id);
}

export function makeLeafId(user: string, suffix: string): string {
  return `${user}#dev-${suffix}`;
}

/** Two leaf identities that belong to the same user (linked devices or self). */
export function sameUser(a: string, b: string): boolean {
  return userPartOf(a) === userPartOf(b);
}

/** Deterministic 8-char base32 device suffix from ≥5 random bytes (callers
 *  supply the randomness — this module stays pure). */
export function deviceSuffixFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 5) throw new Error("need at least 5 bytes");
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < DEVICE_SUFFIX_LEN) {
      bits -= 5;
      out += B32_ALPHABET[(acc >> bits) & 31];
    }
    if (out.length >= DEVICE_SUFFIX_LEN) break;
  }
  return out;
}

// ── Device registry ───────────────────────────────────────────────────────────
// Stored sealed under kv ns "devices" and exchanged over the devlink channel.
// The registry is trusted between the user's own devices only, authenticated
// by HMAC-SHA256(linkKey, canonicalRegistryString) — room peers never see it.

export interface DeviceEntry {
  /** Stable local device id (the leaf suffix for secondaries, "primary" style
   *  bare marker for the primary — always unique within the registry). */
  deviceId: string;
  label: string;
  kind: "desktop" | "mobile";
  /** Full MLS leaf identity this device uses in every room. */
  leafId: string;
  /** The device's stable chat-gossip iroh NodeId (its keys/iroh_gossip). */
  nodeId: string;
  /** Unix ms. */
  addedAt: number;
  /** Unix ms when unlinked — a tombstone; the entry stays for audit/dedupe. */
  revokedAt?: number;
}

export interface DeviceRegistry {
  v: typeof DEVLINK_VERSION;
  /** The shared user identity (the primary's bare MLS id). */
  user: string;
  /** Monotonic revision — higher rev with a valid MAC replaces lower. */
  rev: number;
  devices: DeviceEntry[];
  /** Lowercase hex HMAC-SHA256(linkKey, canonicalRegistryString(this)). */
  mac: string;
}

/** Locally-held link secret + channel coordinates (kv `devices/default/link`).
 *  Never leaves the device except inside the E2EE pairing stream / rekey. */
export interface DeviceLinkInfo {
  v: typeof DEVLINK_VERSION;
  /** base64 32-byte long-term link key (minted at pairing, rotated on rekey). */
  linkKey: string;
  /** Hidden gossip room name — derived Rust-side from linkKey (blake3). */
  roomName: string;
  myDeviceId: string;
  myLeafId: string;
}

/** The MAC input: deterministic JSON of the registry without `mac` (stable
 *  field order, devices sorted by deviceId). Mirrored in Rust. */
export function canonicalRegistryString(reg: Omit<DeviceRegistry, "mac">): string {
  const devices = [...reg.devices]
    .sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0))
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label,
      kind: d.kind,
      leafId: d.leafId,
      nodeId: d.nodeId,
      addedAt: d.addedAt,
      revokedAt: d.revokedAt ?? null,
    }));
  return JSON.stringify({ v: reg.v, user: reg.user, rev: reg.rev, devices });
}

export function activeDevices(reg: DeviceRegistry): DeviceEntry[] {
  return reg.devices.filter((d) => !d.revokedAt);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFinite_(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNonEmptyString(x: unknown, max: number): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= max;
}

const HEX_64 = /^[0-9a-f]{64}$/;

export function validateDeviceEntry(x: unknown): DeviceEntry | null {
  if (!isRecord(x)) return null;
  const { deviceId, label, kind, leafId, nodeId, addedAt, revokedAt } = x;
  if (!isNonEmptyString(deviceId, 64)) return null;
  if (typeof label !== "string" || label.length > DEVICE_LABEL_MAX_LEN) return null;
  if (kind !== "desktop" && kind !== "mobile") return null;
  if (!isNonEmptyString(leafId, 300)) return null;
  if (!isNonEmptyString(nodeId, 128)) return null;
  if (!isFinite_(addedAt) || addedAt < 0) return null;
  const entry: DeviceEntry = {
    deviceId, label, kind, leafId, nodeId, addedAt,
  };
  if (isFinite_(revokedAt) && revokedAt > 0) entry.revokedAt = revokedAt;
  return entry;
}

export function validateDeviceRegistry(x: unknown): DeviceRegistry | null {
  if (!isRecord(x)) return null;
  if (x.v !== DEVLINK_VERSION) return null;
  if (!isNonEmptyString(x.user, 300)) return null;
  if (!isFinite_(x.rev) || x.rev < 0) return null;
  if (!Array.isArray(x.devices) || x.devices.length > DEVLINK_MAX_DEVICES * 4) return null;
  const devices: DeviceEntry[] = [];
  const seen = new Set<string>();
  for (const d of x.devices) {
    const entry = validateDeviceEntry(d);
    if (!entry || seen.has(entry.deviceId)) return null;
    seen.add(entry.deviceId);
    devices.push(entry);
  }
  if (typeof x.mac !== "string" || !HEX_64.test(x.mac)) return null;
  return { v: DEVLINK_VERSION, user: x.user, rev: x.rev, devices, mac: x.mac };
}

// ── Persisted chat messages (the chat:log kv namespace + dlink_history wire) ──

export type PersistedMessageType =
  | "chat_message"
  | "mls_app"
  | "image_message"
  | "voice_message"
  | "map_pin"
  | "map_loc"
  | "map_region";

const PERSISTED_TYPES: readonly string[] = [
  "chat_message", "mls_app", "image_message", "voice_message",
  "map_pin", "map_loc", "map_region",
];

/** A validated map share on a persisted card (re-narrowed on every receive). */
export type PersistedMapShare =
  | MapPinShare | MapLocationShare | MapRegionShare;

/** One stored timeline message. `self`/initials/avatar are NOT stored — they
 *  are presentation, recomputed from the viewer's identity on load. System
 *  messages are never persisted. */
export interface PersistedMessage {
  /** Sender-minted stable id (rides the inner MLS payload) — the cross-device
   *  dedupe key. */
  id: string;
  type: PersistedMessageType;
  /** Sender's display name as rendered at receive time. */
  user: string;
  /** Sender's full MLS leaf identity when known — `self` on reload is
   *  sameUser(deviceId, viewer identity), robust across display renames. */
  deviceId?: string;
  content: string;
  image_data?: string;
  audio_data?: string;
  map?: PersistedMapShare;
  encrypted: boolean;
  /** Unix ms. */
  ts: number;
}

function validateMapShareByType(x: unknown): PersistedMapShare | null {
  if (!isRecord(x)) return null;
  if (x.type === "map_pin") return validatePinShare(x);
  if (x.type === "map_loc") return validateLocationShare(x);
  if (x.type === "map_region") return validateRegionShare(x);
  return null;
}

export function validatePersistedMessage(x: unknown): PersistedMessage | null {
  if (!isRecord(x)) return null;
  const { id, type, user, deviceId, content, image_data, audio_data, map, encrypted, ts } = x;
  if (!isNonEmptyString(id, MSG_ID_MAX_LEN)) return null;
  if (typeof type !== "string" || !PERSISTED_TYPES.includes(type)) return null;
  if (!isNonEmptyString(user, 300)) return null;
  if (typeof content !== "string" || content.length > MSG_CONTENT_MAX_LEN) return null;
  if (typeof encrypted !== "boolean") return null;
  if (!isFinite_(ts) || ts < 0) return null;
  const msg: PersistedMessage = {
    id, type: type as PersistedMessageType, user, content, encrypted, ts,
  };
  if (isNonEmptyString(deviceId, 300)) msg.deviceId = deviceId;
  if (isNonEmptyString(image_data, MSG_MEDIA_MAX_LEN)) msg.image_data = image_data;
  if (isNonEmptyString(audio_data, MSG_MEDIA_MAX_LEN)) msg.audio_data = audio_data;
  const share = validateMapShareByType(map);
  if (share) msg.map = share;
  return msg;
}

/** Union two message lists, deduped by id (local wins), ordered by (ts, id),
 *  trimmed to the newest `cap`. */
export function mergeMessages(
  local: PersistedMessage[],
  remote: PersistedMessage[],
  cap: number,
): PersistedMessage[] {
  const byId = new Map<string, PersistedMessage>();
  for (const m of remote) byId.set(m.id, m);
  for (const m of local) byId.set(m.id, m); // local wins on id collision
  const merged = [...byId.values()].sort(
    (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return cap > 0 && merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

// ── Sync allow-list ───────────────────────────────────────────────────────────
// The complete set of kv entries that replicate between linked devices. The
// Rust pairing bundle mirrors this list (device_link.rs SYNC_KV) — a pinning
// test on each side keeps them from drifting. Everything else is deliberately
// device-local: connect_timeout_secs (per-device network conditions), all
// map:* / map settings (locked decision), keys/*, mls/*, dht secrets
// and the devlink pacing knobs. The allow-list is closed, so a namespace that
// simply is not listed here never syncs — which is how the parked board/mind
// namespaces behaved and how any future feature starts out.

export interface SyncKvKey {
  ns: string;
  scope: string;
  k: string;
}

export const DEVLINK_SYNC_KV: readonly SyncKvKey[] = [
  { ns: "contacts", scope: "default", k: "" },
  { ns: "p2p:rooms", scope: "default", k: "" },
  { ns: "meetings", scope: "default", k: "" },
  { ns: "meetings", scope: "default", k: "polls" },
  { ns: "p2p:settings", scope: "default", k: "max_file_size_mb" },
  { ns: "p2p:settings", scope: "default", k: "meeting_reminder_mins" },
  { ns: "p2p:settings", scope: "default", k: "file_key_rotation_days" },
  { ns: "p2p:settings", scope: "default", k: "dht_room_publish_secs" },
] as const;

export function isSyncableKv(ns: string, scope: string, k: string): boolean {
  return DEVLINK_SYNC_KV.some((e) => e.ns === ns && e.scope === scope && e.k === k);
}

// ── Room-list merge (p2p:rooms) ───────────────────────────────────────────────
// Structural subset of useChatChannel's P2pRoomEntry (no import — that module
// imports this one). Shared fields replicate; `onion` (per-device Tor identity)
// and `host` (who created/hosts) never do — toSyncedRoomEntry strips them.

export interface SyncedRoomEntry {
  room: string;
  name: string;
  ticket: string;
  peers?: string[];
  tor?: boolean;
  code?: string;
  logo?: string;
  rules?: string;
  metaRev?: number;
  mutes?: Record<string, number>;
  bans?: string[];
}

/** Shape a local room entry for the wire: shared fields only. */
export function toSyncedRoomEntry(entry: SyncedRoomEntry & { onion?: string; host?: boolean }): SyncedRoomEntry {
  const out: SyncedRoomEntry = { room: entry.room, name: entry.name, ticket: entry.ticket };
  if (entry.peers?.length) out.peers = [...entry.peers];
  if (entry.tor) out.tor = true;
  if (entry.code) out.code = entry.code;
  if (entry.logo) out.logo = entry.logo;
  if (entry.rules) out.rules = entry.rules;
  if (entry.metaRev !== undefined) out.metaRev = entry.metaRev;
  if (entry.mutes) out.mutes = { ...entry.mutes };
  if (entry.bans?.length) out.bans = [...entry.bans];
  return out;
}

export function validateSyncedRoomEntry(x: unknown): SyncedRoomEntry | null {
  if (!isRecord(x)) return null;
  if (!isNonEmptyString(x.room, 256) || !isNonEmptyString(x.name, 256)) return null;
  if (typeof x.ticket !== "string" || x.ticket.length > 8192) return null;
  const out: SyncedRoomEntry = { room: x.room, name: x.name, ticket: x.ticket };
  if (Array.isArray(x.peers)) {
    const peers = x.peers.filter((p): p is string => isNonEmptyString(p, 128)).slice(0, 64);
    if (peers.length) out.peers = peers;
  }
  if (x.tor === true) out.tor = true;
  if (isNonEmptyString(x.code, 8192)) out.code = x.code;
  if (isNonEmptyString(x.logo, MSG_MEDIA_MAX_LEN)) out.logo = x.logo;
  if (typeof x.rules === "string" && x.rules.length > 0) out.rules = x.rules.slice(0, 4000);
  if (isFinite_(x.metaRev) && x.metaRev >= 0) out.metaRev = x.metaRev;
  if (isRecord(x.mutes)) {
    const mutes: Record<string, number> = {};
    for (const [k, v] of Object.entries(x.mutes)) {
      if (isNonEmptyString(k, 300) && isFinite_(v)) mutes[k] = v;
    }
    out.mutes = mutes;
  }
  if (Array.isArray(x.bans)) {
    out.bans = x.bans.filter((b): b is string => isNonEmptyString(b, 300)).slice(0, 256);
  }
  return out;
}

/** Merge a remote (already-stripped) room list into the local one. Per room:
 *  union by slug; the higher metaRev's captain snapshot (name/logo/rules/
 *  mutes/bans) wins; tickets/codes prefer any non-empty value (local first);
 *  peers union. Local-only fields (onion/host) are preserved untouched.
 *  Returns the merged list and whether anything changed. */
export function mergeRoomLists<T extends SyncedRoomEntry>(
  local: T[],
  remote: SyncedRoomEntry[],
): { merged: (T | SyncedRoomEntry)[]; changed: boolean } {
  const merged: (T | SyncedRoomEntry)[] = [...local];
  const bySlug = new Map<string, number>(local.map((r, i) => [r.room, i]));
  let changed = false;

  for (const r of remote) {
    const i = bySlug.get(r.room);
    if (i === undefined) {
      merged.push(r);
      bySlug.set(r.room, merged.length - 1);
      changed = true;
      continue;
    }
    const cur = merged[i];
    const next = { ...cur } as T & SyncedRoomEntry;
    if ((r.metaRev ?? 0) > (cur.metaRev ?? 0)) {
      next.metaRev = r.metaRev;
      next.name = r.name;
      if (r.logo !== undefined) next.logo = r.logo;
      if (r.rules !== undefined) next.rules = r.rules;
      if (r.mutes !== undefined) next.mutes = r.mutes;
      if (r.bans !== undefined) next.bans = r.bans;
    }
    if (!next.ticket && r.ticket) next.ticket = r.ticket;
    if (!next.code && r.code) next.code = r.code;
    if (r.tor && !next.tor) next.tor = true;
    const peers = new Set([...(cur.peers ?? []), ...(r.peers ?? [])]);
    if (peers.size !== (cur.peers ?? []).length) next.peers = [...peers];
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      merged[i] = next;
      changed = true;
    }
  }
  return { merged, changed };
}

// ── Contact-list merge ────────────────────────────────────────────────────────
// Structural mirror of services/contacts.ts ContactEntry (no import — this
// module stays dependency-free). Union by nodeId; local name wins, addedAt is
// the earliest sighting, lastSeen the latest.

export interface SyncedContact {
  nodeId: string;
  name: string;
  addedAt: number;
  lastSeen?: number;
}

export function validateSyncedContact(x: unknown): SyncedContact | null {
  if (!isRecord(x)) return null;
  if (!isNonEmptyString(x.nodeId, 128)) return null;
  if (typeof x.name !== "string" || x.name.length > 200) return null;
  if (!isFinite_(x.addedAt) || x.addedAt < 0) return null;
  const c: SyncedContact = { nodeId: x.nodeId, name: x.name, addedAt: x.addedAt };
  if (isFinite_(x.lastSeen) && x.lastSeen > 0) c.lastSeen = x.lastSeen;
  return c;
}

export function mergeContactLists<T extends SyncedContact>(
  local: T[],
  remote: SyncedContact[],
): { merged: (T | SyncedContact)[]; changed: boolean } {
  const merged: (T | SyncedContact)[] = [...local];
  const byId = new Map<string, number>(local.map((c, i) => [c.nodeId, i]));
  let changed = false;
  for (const r of remote) {
    const i = byId.get(r.nodeId);
    if (i === undefined) {
      merged.push(r);
      byId.set(r.nodeId, merged.length - 1);
      changed = true;
      continue;
    }
    const cur = merged[i];
    const next = { ...cur };
    next.addedAt = Math.min(cur.addedAt, r.addedAt);
    const lastSeen = Math.max(cur.lastSeen ?? 0, r.lastSeen ?? 0);
    if (lastSeen > 0) next.lastSeen = lastSeen;
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      merged[i] = next;
      changed = true;
    }
  }
  return { merged, changed };
}

/** LWW acceptance for a synced kv value (mtimes are recorded per key locally). */
export function shouldAcceptRemoteKv(localMtime: number | undefined, remoteMtime: number): boolean {
  return remoteMtime > (localMtime ?? 0);
}

// ── Devlink wire payloads (inner MLS messages on the hidden device room) ──────
// All versioned v:1; unknown or invalid frames are dropped silently.

export interface DlinkHello {
  type: "dlink_hello";
  v: typeof DEVLINK_VERSION;
  registryRev: number;
  /** Per-room log summary — the peer answers with dlink_history_req for rooms
   *  where it holds newer messages than `latestTs`. */
  rooms: { slug: string; latestTs: number; count: number }[];
  /** Recorded mtime per allow-listed settings key (LWW convergence). */
  settingsMtime: Record<string, number>;
}

export interface DlinkRegistry {
  type: "dlink_registry";
  v: typeof DEVLINK_VERSION;
  registry: DeviceRegistry;
}

export interface DlinkKv {
  type: "dlink_kv";
  v: typeof DEVLINK_VERSION;
  ns: string;
  scope: string;
  k: string;
  val: string;
  /** Unix ms of the write on the sending device (LWW). */
  mtime: number;
}

export interface DlinkHistoryReq {
  type: "dlink_history_req";
  v: typeof DEVLINK_VERSION;
  room: string;
  /** Send messages strictly newer than this Unix ms (0 = everything). */
  sinceTs: number;
}

export interface DlinkHistory {
  type: "dlink_history";
  v: typeof DEVLINK_VERSION;
  room: string;
  msgs: PersistedMessage[];
  chunk: number;
  of: number;
}

export interface DlinkRekey {
  type: "dlink_rekey";
  v: typeof DEVLINK_VERSION;
  /** base64 fresh 32-byte link key (sent only through a post-removal epoch). */
  linkKey: string;
  /** The new hidden room name derived from it (Rust-side blake3). */
  roomName: string;
}

export interface DlinkRoomAdmitReq {
  type: "dlink_room_admit_req";
  v: typeof DEVLINK_VERSION;
  room: string;
  ticket: string;
}

export function validateDlinkHello(x: unknown): DlinkHello | null {
  if (!isRecord(x) || x.type !== "dlink_hello" || x.v !== DEVLINK_VERSION) return null;
  if (!isFinite_(x.registryRev) || x.registryRev < 0) return null;
  if (!Array.isArray(x.rooms) || x.rooms.length > 1024) return null;
  const rooms: DlinkHello["rooms"] = [];
  for (const r of x.rooms) {
    if (!isRecord(r) || !isNonEmptyString(r.slug, 256)) return null;
    if (!isFinite_(r.latestTs) || !isFinite_(r.count)) return null;
    rooms.push({ slug: r.slug, latestTs: r.latestTs, count: r.count });
  }
  const settingsMtime: Record<string, number> = {};
  if (isRecord(x.settingsMtime)) {
    for (const [k, v] of Object.entries(x.settingsMtime)) {
      if (isNonEmptyString(k, 128) && isFinite_(v)) settingsMtime[k] = v;
    }
  }
  return { type: "dlink_hello", v: DEVLINK_VERSION, registryRev: x.registryRev, rooms, settingsMtime };
}

export function validateDlinkRegistry(x: unknown): DlinkRegistry | null {
  if (!isRecord(x) || x.type !== "dlink_registry" || x.v !== DEVLINK_VERSION) return null;
  const registry = validateDeviceRegistry(x.registry);
  if (!registry) return null;
  return { type: "dlink_registry", v: DEVLINK_VERSION, registry };
}

export function validateDlinkKv(x: unknown): DlinkKv | null {
  if (!isRecord(x) || x.type !== "dlink_kv" || x.v !== DEVLINK_VERSION) return null;
  const { ns, scope, k, val, mtime } = x;
  if (typeof ns !== "string" || typeof scope !== "string" || typeof k !== "string") return null;
  if (!isSyncableKv(ns, scope, k)) return null;
  if (typeof val !== "string" || val.length > 32 * 1024 * 1024) return null;
  if (!isFinite_(mtime) || mtime < 0) return null;
  return { type: "dlink_kv", v: DEVLINK_VERSION, ns, scope, k, val, mtime };
}

export function validateDlinkHistoryReq(x: unknown): DlinkHistoryReq | null {
  if (!isRecord(x) || x.type !== "dlink_history_req" || x.v !== DEVLINK_VERSION) return null;
  if (!isNonEmptyString(x.room, 256)) return null;
  if (!isFinite_(x.sinceTs) || x.sinceTs < 0) return null;
  return { type: "dlink_history_req", v: DEVLINK_VERSION, room: x.room, sinceTs: x.sinceTs };
}

export function validateDlinkHistory(x: unknown): DlinkHistory | null {
  if (!isRecord(x) || x.type !== "dlink_history" || x.v !== DEVLINK_VERSION) return null;
  if (!isNonEmptyString(x.room, 256)) return null;
  if (!isFinite_(x.chunk) || !isFinite_(x.of) || x.chunk < 1 || x.of < 1 || x.chunk > x.of) return null;
  if (!Array.isArray(x.msgs) || x.msgs.length > DLINK_HISTORY_CHUNK_MAX_MSGS) return null;
  const msgs: PersistedMessage[] = [];
  for (const m of x.msgs) {
    const valid = validatePersistedMessage(m);
    if (!valid) return null;
    msgs.push(valid);
  }
  return { type: "dlink_history", v: DEVLINK_VERSION, room: x.room, msgs, chunk: x.chunk, of: x.of };
}

const B64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

export function validateDlinkRekey(x: unknown): DlinkRekey | null {
  if (!isRecord(x) || x.type !== "dlink_rekey" || x.v !== DEVLINK_VERSION) return null;
  if (typeof x.linkKey !== "string" || !B64_32_BYTES.test(x.linkKey)) return null;
  if (!isNonEmptyString(x.roomName, 256)) return null;
  return { type: "dlink_rekey", v: DEVLINK_VERSION, linkKey: x.linkKey, roomName: x.roomName };
}

export function validateDlinkRoomAdmitReq(x: unknown): DlinkRoomAdmitReq | null {
  if (!isRecord(x) || x.type !== "dlink_room_admit_req" || x.v !== DEVLINK_VERSION) return null;
  if (!isNonEmptyString(x.room, 256)) return null;
  if (typeof x.ticket !== "string" || x.ticket.length > 8192) return null;
  return { type: "dlink_room_admit_req", v: DEVLINK_VERSION, room: x.room, ticket: x.ticket };
}
