// Chat-history model — pure types, leaf-identity helpers and validation for
// PERSISTED chat messages. No Vue/Tauri imports:
// storage-shape logic shared by the chat log, the chat channel and peer sync.
//
// This was `deviceSyncModel.ts` until device linking was parked (2026-08-18,
// see limbo/frontend/devices/). What stayed is the half that was never really
// about linked devices: how a message is stored, and how a leaf identity
// parses. The device registry, the kv sync allow-list and the devlink wire
// payloads went to limbo with the feature.
//
// Leaf identities keep their `#dev-xxxxxxxx` grammar even though nothing mints
// one any more: a vault written before the park can still hold them, and chat
// must keep resolving those to the right human rather than showing a stranger.
// For a bare id every helper here is the identity function.
//
// Wire safety: a persisted message can arrive over an MLS seam, so it is
// re-validated on receive — never trust a wire object.

/** Segment size of the persisted chat log (bounds the sealed value rewritten
 *  per append — never one giant blob per room). */
export const CHAT_LOG_SEG_MAX_MSGS = 100;
export const MSG_ID_MAX_LEN = 64;
export const MSG_CONTENT_MAX_LEN = 16384;
/** Media data-URL cap per persisted message (downscaled JPEG / voice clip). */
export const MSG_MEDIA_MAX_LEN = 8 * 1024 * 1024;


// ── Leaf identity ─────────────────────────────────────────────────────────────
// A linked (secondary) device's MLS leaf identity is "<user>#dev-<8 base32>".
// The primary keeps its bare identity (its user part is itself) so existing
// room memberships never churn. The suffix is rigid — user names containing
// "#" stay safe because the regex anchors the "#dev-xxxxxxxx" tail.

export const LEAF_SUFFIX_RE = /^(.+)#dev-([a-z2-7]{8})$/;

/** The user part of a leaf identity; a bare (non-device) id is its own user. */
export function userPartOf(id: string): string {
  const m = LEAF_SUFFIX_RE.exec(id);
  return m ? m[1] : id;
}
/** Two leaf identities that belong to the same user (linked devices or self). */
export function sameUser(a: string, b: string): boolean {
  return userPartOf(a) === userPartOf(b);
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


// ── Persisted chat messages (the chat:log kv namespace) ──────────────────────

/** The three `map_*` types are what the Map tab used to put in a room: a
 *  shared pin, location or region. Maps left the app (2026-10-03), but those
 *  messages are in stored histories and can still arrive from a peer on an
 *  older build — so the TYPES stay known, and such a message is kept as a
 *  card that says it cannot be shown, rather than silently vanishing. Its
 *  payload is not read or stored any more. */
export const MAP_SHARE_TYPES = ["map_pin", "map_loc", "map_region"] as const;
export type MapShareType = (typeof MAP_SHARE_TYPES)[number];

export function isMapShareType(type: unknown): type is MapShareType {
  return typeof type === "string" && (MAP_SHARE_TYPES as readonly string[]).includes(type);
}

export type PersistedMessageType =
  | "chat_message"
  | "mls_app"
  | "image_message"
  | "voice_message"
  | MapShareType;

const PERSISTED_TYPES: readonly string[] = [
  "chat_message", "mls_app", "image_message", "voice_message",
  ...MAP_SHARE_TYPES,
];

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
  encrypted: boolean;
  /** Unix ms. */
  ts: number;
}

export function validatePersistedMessage(x: unknown): PersistedMessage | null {
  if (!isRecord(x)) return null;
  const { id, type, user, deviceId, content, image_data, audio_data, encrypted, ts } = x;
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
