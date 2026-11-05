// File-sync model — pure types, validation, and merge logic for per-file
// Push/Pull between a user's own linked devices. No
// Vue/Tauri imports (deviceSyncModel.ts pattern); shared by useDeviceSync
// (list replication over the devlink room) and the app's fileSync store.
//
// Wire safety: every payload arriving over the devlink MLS seam is
// re-validated here on receive — never trust a wire object. File BYTES never
// ride this seam; they go over file_xfer's dedicated QUIC path, and only the
// blake3 hash/size/offer coordinates travel in these messages. Local file
// PATHS never leave the device: each device's paths live under its own kv key
// and the shared entries carry per-device {hash,size} claims instead.

// ── Caps (shared by send + receive validation) ────────────────────────────────
// Model constants, not build knobs: linked devices must agree on validation
// limits and are one fleet (DEVLINK_MAX_DEVICES precedent) — a per-edition
// knob here would let two builds of the same user disagree about validity.

export const FILESYNC_VERSION = 1;
/** Live (non-tombstoned) entries — a UI/abuse rail, not a protocol limit. */
export const FILESYNC_MAX_ENTRIES = 200;
/** Total entries incl. tombstones a wire list may carry (registry's ×4 rule). */
export const FILESYNC_MAX_WIRE_ENTRIES = FILESYNC_MAX_ENTRIES * 4;
/** Tombstone trim threshold on save — oldest tombstones drop past this. */
export const FILESYNC_TRIM_AT = FILESYNC_MAX_ENTRIES * 2;
export const FILESYNC_NAME_MAX_LEN = 120;
export const FILESYNC_ID_MAX_LEN = 32;
/** dir caps: per-segment length shares FILESYNC_NAME_MAX_LEN. */
export const FILESYNC_DIR_MAX_LEN = 500;
export const FILESYNC_DIR_MAX_SEGMENTS = 16;
/** base32 EndpointAddr blobs (file_xfer encode_addr) stay far under this. */
export const FILESYNC_ADDR_MAX_LEN = 2048;

const HASH_RE = /^[0-9a-f]{64}$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isFinite_(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isNonEmptyString(x: unknown, max: number): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= max;
}
function isHash(x: unknown): x is string {
  return typeof x === "string" && HASH_RE.test(x);
}

/** One dir segment obeys the same character rules a name does (the shapes
 *  Rust's sanitize_file_name would strip): no separators/colon/control bytes,
 *  no dot-relative or hidden segments, bounded length. */
function validDirSegment(seg: string): boolean {
  if (seg.length === 0 || seg.length > FILESYNC_NAME_MAX_LEN) return false;
  if (seg.startsWith(".")) return false; // covers "." and ".." and dotdirs
  for (const ch of seg) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (ch === "/" || ch === "\\" || ch === ":") return false;
  }
  return true;
}

/** Normalize a wire/stored dir: a valid POSIX-relative directory path comes
 *  back verbatim, ANYTHING else (traversal, absolute, empty segments, over
 *  the caps, non-string) demotes to "" = root. Never rejects — an old peer's
 *  rebuilt echo or a hostile frame must not be able to veto the entry. */
export function normalizeDirPath(x: unknown): string {
  if (typeof x !== "string" || x === "") return "";
  if (x.length > FILESYNC_DIR_MAX_LEN) return "";
  const segs = x.split("/");
  if (segs.length > FILESYNC_DIR_MAX_SEGMENTS) return "";
  return segs.every(validDirSegment) ? x : "";
}

// ── Shared list ───────────────────────────────────────────────────────────────
// Stored sealed under kv ("filesync","default","") and replicated ONLY via the
// dlink_files message — deliberately NOT in DEVLINK_SYNC_KV (that list is the
// automatic-replication rail; this list has its own semantic merge). Pinned by
// negative tests on both the TS and Rust allow-lists.

/** One device's claim about its copy of an entry — hash + size, never a path. */
export interface FileCopyInfo {
  hash: string;
  size: number;
  /** Unix ms of the claim; per-slot LWW (only the owning device writes it). */
  updatedAt: number;
}

export interface SyncedFileEntry {
  id: string; // nanoid, minted by the adding device
  /** Display/base name; sanitized again Rust-side before touching the disk. */
  name: string;
  /** POSIX-relative directory INSIDE the enigma folder ("" / absent = root;
   *  NEVER includes the file name). Immutable after add with LOCAL wins, like
   *  name: old peers REBUILD entries from known fields, so an echoed copy from
   *  a stripped build must never be able to erase it. Sanitized again
   *  Rust-side before touching the disk. */
  dir?: string;
  /** deviceId of the adding device (registry DeviceEntry.deviceId). */
  addedBy: string;
  addedAt: number;
  /** Max of any mutation, tombstoning included. */
  updatedAt: number;
  /** Tombstone — removal must propagate (a peer's next dlink_files would
   *  otherwise resurrect the entry). Sticky: no un-remove exists. This is a
   *  deliberate, documented departure from sync.md's "no deletion sync". */
  removedAt?: number;
  /** deviceId → that device's copy claim. Each device writes ONLY its own
   *  slot, which is what makes the merge conflict-free. */
  copies: Record<string, FileCopyInfo>;
}

/** Entries the UI shows and transfers may reference. */
export function liveFileEntries<T extends SyncedFileEntry>(entries: T[]): T[] {
  return entries.filter((e) => e.removedAt === undefined);
}

/** Where the entry sits in the Files tree: "dir/name", or just "name" at root. */
export function entryTreePath(entry: Pick<SyncedFileEntry, "dir" | "name">): string {
  return entry.dir ? `${entry.dir}/${entry.name}` : entry.name;
}

export function validateFileCopyInfo(x: unknown): FileCopyInfo | null {
  if (!isRecord(x)) return null;
  if (!isHash(x.hash)) return null;
  if (!isFinite_(x.size) || x.size < 0) return null;
  if (!isFinite_(x.updatedAt) || x.updatedAt < 0) return null;
  return { hash: x.hash, size: x.size, updatedAt: x.updatedAt };
}

export function validateSyncedFileEntry(x: unknown): SyncedFileEntry | null {
  if (!isRecord(x)) return null;
  if (!isNonEmptyString(x.id, FILESYNC_ID_MAX_LEN)) return null;
  if (!isNonEmptyString(x.name, FILESYNC_NAME_MAX_LEN)) return null;
  if (!isNonEmptyString(x.addedBy, 64)) return null;
  if (!isFinite_(x.addedAt) || x.addedAt < 0) return null;
  if (!isFinite_(x.updatedAt) || x.updatedAt < 0) return null;
  const entry: SyncedFileEntry = {
    id: x.id,
    name: x.name,
    addedBy: x.addedBy,
    addedAt: x.addedAt,
    updatedAt: x.updatedAt,
    copies: {},
  };
  // Invalid dirs demote to root instead of rejecting the entry (Rust
  // re-sanitizes before any disk touch anyway); "" stays absent.
  const dir = normalizeDirPath(x.dir);
  if (dir !== "") entry.dir = dir;
  if (x.removedAt !== undefined) {
    if (!isFinite_(x.removedAt) || x.removedAt < 0) return null;
    entry.removedAt = x.removedAt;
  }
  if (x.copies !== undefined) {
    if (!isRecord(x.copies)) return null;
    let n = 0;
    for (const [deviceId, raw] of Object.entries(x.copies)) {
      if (!isNonEmptyString(deviceId, 64)) return null;
      const copy = validateFileCopyInfo(raw);
      if (!copy) return null;
      if (++n > 16) return null; // more slots than devices could ever exist
      entry.copies[deviceId] = copy;
    }
  }
  return entry;
}

/** Validate a whole stored/wire list; null on structural garbage, per-entry
 *  hard reject (registry style — a crafted list should fail loudly-silent as
 *  one unit, not half-apply). */
export function validateFileEntryList(x: unknown): SyncedFileEntry[] | null {
  if (!Array.isArray(x) || x.length > FILESYNC_MAX_WIRE_ENTRIES) return null;
  const out: SyncedFileEntry[] = [];
  const seen = new Set<string>();
  for (const raw of x) {
    const e = validateSyncedFileEntry(raw);
    if (!e || seen.has(e.id)) return null;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

// ── Merge ─────────────────────────────────────────────────────────────────────
// Conflict-free by construction:
// - union by id; name/addedBy/addedAt/dir are immutable after add (local wins
//   on the nanoid-improbable id collision). Local-wins is also what protects
//   dir against old builds: their validator rebuilds entries without it, and
//   their stripped echo must not erase what we hold;
// - removedAt: earliest wins and is sticky — losing a removal would violate
//   the "remove removes on both" promise, losing an add costs one re-add;
// - copies: per-deviceId slot, higher updatedAt wins; since only device X
//   ever writes copies[X], offline concurrent edits cannot truly conflict.

export function mergeFileLists(
  local: SyncedFileEntry[],
  remote: SyncedFileEntry[],
): { merged: SyncedFileEntry[]; changed: boolean } {
  const merged: SyncedFileEntry[] = [...local];
  const byId = new Map<string, number>(local.map((e, i) => [e.id, i]));
  let changed = false;

  for (const r of remote) {
    const i = byId.get(r.id);
    if (i === undefined) {
      merged.push(r);
      byId.set(r.id, merged.length - 1);
      changed = true;
      continue;
    }
    const cur = merged[i];
    const next: SyncedFileEntry = { ...cur, copies: { ...cur.copies } };

    if (r.removedAt !== undefined) {
      next.removedAt = cur.removedAt === undefined ? r.removedAt : Math.min(cur.removedAt, r.removedAt);
    }
    for (const [dev, copy] of Object.entries(r.copies)) {
      const mine = next.copies[dev];
      if (!mine || copy.updatedAt > mine.updatedAt) next.copies[dev] = copy;
    }
    next.updatedAt = Math.max(cur.updatedAt, r.updatedAt);

    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      merged[i] = next;
      changed = true;
    }
  }
  return { merged, changed };
}

/** Save-time bound: past FILESYNC_TRIM_AT total entries, the oldest tombstones
 *  drop first (deterministic on every device, so trims converge too). Live
 *  entries are never trimmed — the add path refuses past FILESYNC_MAX_ENTRIES. */
export function trimFileEntries(entries: SyncedFileEntry[]): SyncedFileEntry[] {
  if (entries.length <= FILESYNC_TRIM_AT) return entries;
  const tombstones = entries
    .filter((e) => e.removedAt !== undefined)
    .sort((a, b) => (a.removedAt ?? 0) - (b.removedAt ?? 0));
  const drop = new Set<string>();
  for (const t of tombstones) {
    if (entries.length - drop.size <= FILESYNC_TRIM_AT) break;
    drop.add(t.id);
  }
  return drop.size ? entries.filter((e) => !drop.has(e.id)) : entries;
}

// ── Wire payloads (inner MLS messages on the hidden device room) ──────────────
// All versioned v:1; unknown or invalid frames are dropped silently. The
// "dlink_" prefix is what routes them through the chat seam's sync gate;
// "dlink_files" deliberately does NOT match the "dlink_file_" transfer prefix,
// so list convergence stays inside useDeviceSync while transfers pass through
// to the app store.

export interface DlinkFiles {
  type: "dlink_files";
  v: typeof FILESYNC_VERSION;
  entries: SyncedFileEntry[];
}

export interface DlinkFilePushItem {
  entryId: string;
  /** file_xfer offer coordinates — the bytes ride QUIC, not this seam. */
  offerId: string;
  addr: string;
  name: string;
  /** Entry dir (SyncedFileEntry.dir) so the receiver lands the file in the
   *  matching subfolder; absent/invalid = root. */
  dir?: string;
  size: number;
  hash: string;
}

export interface DlinkFilePush {
  type: "dlink_file_push";
  v: typeof FILESYNC_VERSION;
  /** Present ⇒ this push answers a dlink_file_pull_req. */
  reqId?: string;
  items: DlinkFilePushItem[];
}

export interface DlinkFilePullReq {
  type: "dlink_file_pull_req";
  v: typeof FILESYNC_VERSION;
  reqId: string;
  entryIds: string[];
}

export type DlinkFileStatus = "received" | "skipped" | "missing" | "too-large" | "failed" | "declined";

export interface DlinkFileResult {
  type: "dlink_file_result";
  v: typeof FILESYNC_VERSION;
  reqId?: string;
  entryId: string;
  status: DlinkFileStatus;
}

export function validateDlinkFiles(x: unknown): DlinkFiles | null {
  if (!isRecord(x) || x.type !== "dlink_files" || x.v !== FILESYNC_VERSION) return null;
  const entries = validateFileEntryList(x.entries);
  if (!entries) return null;
  return { type: "dlink_files", v: FILESYNC_VERSION, entries };
}

export function validateDlinkFilePushItem(x: unknown): DlinkFilePushItem | null {
  if (!isRecord(x)) return null;
  if (!isNonEmptyString(x.entryId, FILESYNC_ID_MAX_LEN)) return null;
  if (!isNonEmptyString(x.offerId, 64)) return null;
  if (!isNonEmptyString(x.addr, FILESYNC_ADDR_MAX_LEN)) return null;
  if (!isNonEmptyString(x.name, FILESYNC_NAME_MAX_LEN)) return null;
  if (!isFinite_(x.size) || x.size < 0) return null;
  if (!isHash(x.hash)) return null;
  const out: DlinkFilePushItem = { entryId: x.entryId, offerId: x.offerId, addr: x.addr, name: x.name, size: x.size, hash: x.hash };
  const dir = normalizeDirPath(x.dir); // invalid → root, never rejects the item
  if (dir !== "") out.dir = dir;
  return out;
}

export function validateDlinkFilePush(x: unknown): DlinkFilePush | null {
  if (!isRecord(x) || x.type !== "dlink_file_push" || x.v !== FILESYNC_VERSION) return null;
  if (!Array.isArray(x.items) || x.items.length > FILESYNC_MAX_ENTRIES) return null;
  const items: DlinkFilePushItem[] = [];
  for (const raw of x.items) {
    const item = validateDlinkFilePushItem(raw);
    if (!item) return null;
    items.push(item);
  }
  const out: DlinkFilePush = { type: "dlink_file_push", v: FILESYNC_VERSION, items };
  if (x.reqId !== undefined) {
    if (!isNonEmptyString(x.reqId, FILESYNC_ID_MAX_LEN)) return null;
    out.reqId = x.reqId;
  }
  return out;
}

export function validateDlinkFilePullReq(x: unknown): DlinkFilePullReq | null {
  if (!isRecord(x) || x.type !== "dlink_file_pull_req" || x.v !== FILESYNC_VERSION) return null;
  if (!isNonEmptyString(x.reqId, FILESYNC_ID_MAX_LEN)) return null;
  if (!Array.isArray(x.entryIds) || x.entryIds.length === 0 || x.entryIds.length > FILESYNC_MAX_ENTRIES) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of x.entryIds) {
    if (!isNonEmptyString(id, FILESYNC_ID_MAX_LEN) || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return { type: "dlink_file_pull_req", v: FILESYNC_VERSION, reqId: x.reqId, entryIds: ids };
}

/** Exported for the sender-side unknown-status fallback in useDeviceSync
 *  ("declined" is new in the tree redesign — an older sender's validator
 *  drops it, which is the graceful floor for down-level builds). */
export const FILE_STATUSES: readonly DlinkFileStatus[] = ["received", "skipped", "missing", "too-large", "failed", "declined"];

export function validateDlinkFileResult(x: unknown): DlinkFileResult | null {
  if (!isRecord(x) || x.type !== "dlink_file_result" || x.v !== FILESYNC_VERSION) return null;
  if (!isNonEmptyString(x.entryId, FILESYNC_ID_MAX_LEN)) return null;
  if (typeof x.status !== "string" || !FILE_STATUSES.includes(x.status as DlinkFileStatus)) return null;
  const out: DlinkFileResult = {
    type: "dlink_file_result",
    v: FILESYNC_VERSION,
    entryId: x.entryId,
    status: x.status as DlinkFileStatus,
  };
  if (x.reqId !== undefined) {
    if (!isNonEmptyString(x.reqId, FILESYNC_ID_MAX_LEN)) return null;
    out.reqId = x.reqId;
  }
  return out;
}
