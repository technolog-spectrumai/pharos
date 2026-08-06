// Files → Devices — per-file Push/Pull between the user's OWN linked devices.
//
// Nothing here is automatic: the user checks entries and presses Push or Pull,
// and that press is the consent for overwriting the destination copy. The
// shared allowed-files list converges in rakotis (useDeviceSync, dlink_files);
// this store owns the transfers.
//
// Bytes ride file_xfer verbatim (the Maps precedent): the sender creates an
// offer and announces its coordinates over the devlink room; the receiver
// downloads to a feature-owned tmp path and hands off to filesync_import,
// which BLAKE3-verifies before anything lands under the enigma folder. The
// devlink room is the trust boundary (link-key HMAC admission, revoked devices
// refused) — but landing bytes still takes explicit consent: an unsolicited
// push parks as a pending offer in useDeviceSync until the user accepts it
// here. Only a push answering our own pull request (reqId) lands directly —
// that pull press was the consent. A room peer can never reach this code.
//
// The tree view runs off two sources joined here: the SCAN (what is actually
// inside the enigma folder on disk) and the shared LIST (what the devices
// agreed to mirror). A scanned file not on the list is "not shared" until the
// user shares it; a listed file with no local bytes is "missing here".
//
// Wire conventions (mirroring map.ts):
//   invoke args    → camelCase   file_* results → snake_case (offer_id, …)
//   filesync_*     → camelCase   event payloads → camelCase (offerId, …)

import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import { nanoid } from "nanoid";
import { useNetworkStore } from "./network";
import {
  invoke,
  isTauri,
  kvGet,
  kvPut,
  getMaxFileSizeMb,
  liveFileEntries,
  validateDlinkFilePullReq,
  validateDlinkFilePush,
  validateDlinkFileResult,
  FILESYNC_VERSION,
  type DlinkFilePushItem,
  type DlinkFileStatus,
  type SyncedFileEntry,
} from "rakotis";
import { useChatStore } from "./chat";

/** Per-device record of where an entry's bytes actually are. NEVER replicated:
 *  a path leaks this device's directory layout, and the other device's copy
 *  lives somewhere else entirely. The shared list carries {hash,size} instead. */
export interface LocalFileRecord {
  path: string;
  hash: string;
  size: number;
  verifiedAt: number;
}

export type RowStatus = "idle" | "working" | DlinkFileStatus | "sent" | "unavailable";

export interface BatchItem {
  status: RowStatus;
  transferred: number;
  total: number;
  error?: string;
}

const LS_NS = "filesync";
const LS_SCOPE = "default";
const LS_KEY_LOCAL = "local";

/** How long a created offer waits to be claimed before we cancel it and call
 *  the row failed. Generous: the peer may be mid-download of an earlier file. */
const OFFER_TTL_MS = 120_000;

interface ScannedFile {
  dir: string;
  name: string;
  size: number;
  mtimeMs: number;
}

/** A row in either bucket, ready for treeBuilder (id doubles as the selection
 *  key — shared entries use the entry id, unshared scans use "s:<path>"). */
export interface BucketFile {
  id: string;
  dir: string;
  name: string;
  size?: number;
  marker?: "missing" | "excess" | "changed" | "notShared";
  selectable?: boolean;
}

interface OfferCreatedWire {
  offer_id: string;
  addr: string;
  name: string;
  size: number;
  mime: string;
}

export const useFileSyncStore = defineStore("fileSync", () => {
  const chat = useChatStore();

  const localRecords = reactive(new Map<string, LocalFileRecord>());
  const selection = reactive(new Set<string>());
  /** Per-entry progress/outcome of the batch in flight (or the last one). */
  const items = reactive(new Map<string, BatchItem>());
  const batchDir = ref<"push" | "pull" | null>(null);
  const batchActive = ref(false);
  const lastError = ref<string | null>(null);

  /** offerId → entryId for transfers WE are receiving (the filter that keeps
   *  useFileShare's and the map store's offers out of our handlers). */
  const incoming = reactive(new Map<string, { entryId: string; name: string; hash: string; dir?: string; reqId?: string }>());
  /** offerId → entryId for offers WE created, so file://done marks them sent. */
  const outgoing = reactive(new Map<string, string>());

  /** The enigma folder (created on demand Rust-side) and its last scan. */
  const root = ref("");
  const scanFiles = ref<ScannedFile[]>([]);
  const scanTruncated = ref(false);

  const deviceSync = computed(() => chat.deviceSync);
  const linked = computed(() => !!deviceSync.value?.linked.value);
  const online = computed(() => !!deviceSync.value?.devOnline.value);
  // Transfers ride file_xfer, which is iroh-only: Tor/airplane mode block them
  // in Rust (check_network_policy), so the buttons must not pretend otherwise.
  const network = useNetworkStore();
  const entries = computed<SyncedFileEntry[]>(() =>
    liveFileEntries(deviceSync.value?.fileEntries.value ?? []),
  );
  const canTransfer = computed(
    () =>
      linked.value && online.value && !batchActive.value && isTauri() && network.canDeviceSync,
  );
  const myDeviceId = computed(() => deviceSync.value?.link.value?.myDeviceId ?? "");

  /** Devices other than us that are still active in the registry. */
  const siblingIds = computed(() => {
    const reg = deviceSync.value?.registry.value;
    if (!reg) return [];
    return reg.devices
      .filter((d) => !d.revokedAt && d.deviceId !== myDeviceId.value)
      .map((d) => d.deviceId);
  });

  // ── local records (device-local kv) ─────────────────────────────────────────

  async function loadLocalRecords(): Promise<void> {
    try {
      const raw = await kvGet(LS_NS, LS_SCOPE, LS_KEY_LOCAL);
      const parsed = raw ? (JSON.parse(raw) as Record<string, LocalFileRecord>) : {};
      localRecords.clear();
      for (const [id, rec] of Object.entries(parsed)) {
        if (rec && typeof rec.path === "string" && typeof rec.hash === "string") localRecords.set(id, rec);
      }
    } catch {
      localRecords.clear();
    }
  }

  async function saveLocalRecords(): Promise<void> {
    await kvPut(LS_NS, LS_SCOPE, LS_KEY_LOCAL, JSON.stringify(Object.fromEntries(localRecords))).catch(() => {});
  }

  // ── event wiring (once, lazily — the map/useFileShare pattern) ──────────────

  let listenersReady = false;
  async function ensureListeners(): Promise<void> {
    if (listenersReady || !isTauri()) return;
    listenersReady = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ offerId: string; dir: string; transferred: number; total: number }>(
      "file://progress",
      ({ payload }) => {
        const rx = incoming.get(payload.offerId);
        if (rx && payload.dir === "recv") {
          const item = items.get(rx.entryId);
          if (item) {
            item.transferred = payload.transferred;
            item.total = payload.total;
          }
        }
      },
    );
    await listen<{ offerId: string; dir: string }>("file://done", ({ payload }) => {
      if (payload.dir === "recv" && incoming.has(payload.offerId)) void finishReceive(payload.offerId);
      else if (payload.dir === "send" && outgoing.has(payload.offerId)) {
        const entryId = outgoing.get(payload.offerId)!;
        outgoing.delete(payload.offerId);
        // Bytes left the machine — ground truth for the sender's row.
        setRow(entryId, "sent");
        void invoke("file_offer_cancel", { offerId: payload.offerId }).catch(() => {});
      }
    });
    await listen<{ offerId: string; message: string }>("file://error", ({ payload }) => {
      const rx = incoming.get(payload.offerId);
      if (rx) {
        incoming.delete(payload.offerId);
        setRow(rx.entryId, "failed", payload.message);
        void reply(rx.entryId, "failed", rx.reqId);
      }
      const outEntry = outgoing.get(payload.offerId);
      if (outEntry) {
        outgoing.delete(payload.offerId);
        setRow(outEntry, "failed", payload.message);
      }
    });
  }

  let unsubscribeDevlink: (() => void) | null = null;

  /** Wire everything up. Called from App.vue after chat init so a push from the
   *  other device lands even while the user is on another tab. */
  async function init(): Promise<void> {
    await loadLocalRecords();
    await ensureListeners();
    if (unsubscribeDevlink || !deviceSync.value) return;
    unsubscribeDevlink = deviceSync.value.onDevlinkFile((type, payload) => {
      if (type === "dlink_file_push") void onPush(payload);
      else if (type === "dlink_file_pull_req") void onPullReq(payload);
      else if (type === "dlink_file_result") onResult(payload);
    });
  }

  // ── row bookkeeping ─────────────────────────────────────────────────────────

  function setRow(entryId: string, status: RowStatus, error?: string): void {
    const item = items.get(entryId);
    if (item) {
      item.status = status;
      if (error) item.error = error;
    } else {
      items.set(entryId, { status, transferred: 0, total: 0, error });
    }
  }

  async function reply(entryId: string, status: DlinkFileStatus, reqId?: string): Promise<void> {
    const ds = deviceSync.value;
    if (!ds) return;
    await ds
      .sendDevlinkFile("dlink_file_result", { v: FILESYNC_VERSION, entryId, status, ...(reqId ? { reqId } : {}) })
      .catch(() => {});
  }

  // ── selection ───────────────────────────────────────────────────────────────

  function toggle(entryId: string): void {
    if (selection.has(entryId)) selection.delete(entryId);
    else selection.add(entryId);
  }

  const allSelected = computed(
    () => entries.value.length > 0 && entries.value.every((e) => selection.has(e.id)),
  );

  function selectAll(on = !allSelected.value): void {
    selection.clear();
    if (on) for (const e of entries.value) selection.add(e.id);
  }

  // ── adding / removing entries ───────────────────────────────────────────────

  /** Re-read the enigma folder. The tree is only as fresh as the last scan —
   *  called on tab open and after anything that touches the folder. */
  async function refresh(): Promise<void> {
    if (!isTauri()) return;
    try {
      const scan = await invoke<{ root: string; truncated: boolean; files: ScannedFile[] }>("filesync_scan");
      root.value = scan.root;
      scanTruncated.value = scan.truncated;
      scanFiles.value = scan.files;
    } catch (e) {
      lastError.value = (e as Error)?.message ?? String(e);
    }
  }

  /** Put a file that already lives in the enigma folder on the shared list —
   *  the explicit step that makes its NAME visible to the other devices. */
  async function shareFile(dir: string, name: string): Promise<void> {
    lastError.value = null;
    if (!isTauri() || !deviceSync.value || !root.value) return;
    const path = dir ? `${root.value}/${dir}/${name}` : `${root.value}/${name}`;
    // Same path twice is a slip, not two entries.
    for (const [entryId, rec] of localRecords) {
      if (rec.path === path && entries.value.some((e) => e.id === entryId)) return;
    }
    try {
      const { hash, size } = await invoke<{ hash: string; size: number }>("filesync_hash", { path });
      const now = Date.now();
      const entry: SyncedFileEntry = {
        id: nanoid(),
        name: name.slice(0, 120),
        ...(dir ? { dir } : {}),
        addedBy: myDeviceId.value,
        addedAt: now,
        updatedAt: now,
        copies: { [myDeviceId.value]: { hash, size, updatedAt: now } },
      };
      if (!(await deviceSync.value.upsertFileEntry(entry))) {
        lastError.value = "full";
        return;
      }
      localRecords.set(entry.id, { path, hash, size, verifiedAt: now });
      await saveLocalRecords();
    } catch (e) {
      lastError.value = (e as Error)?.message ?? String(e);
    }
  }

  /** Pick any local file: it is COPIED into the enigma folder root (the tree
   *  shows what the folder holds — no more entries at scattered paths), then
   *  shared. */
  async function addFile(): Promise<void> {
    lastError.value = null;
    if (!isTauri() || !deviceSync.value) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, directory: false });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    const name = (path.split(/[\\/]/).pop() || "file").slice(0, 120);
    try {
      const [copied] = await invoke<Array<{ entryId: string; status: string; newPath?: string | null }>>(
        "filesync_migrate",
        { items: [{ entryId: "pick", srcPath: path, dir: "", name }] },
      );
      if (copied?.status !== "migrated" || !copied.newPath) {
        lastError.value = copied?.status ?? "failed";
        return;
      }
      await refresh();
      // The copy may have been renamed to avoid a collision.
      const landed = copied.newPath.split(/[\\/]/).pop() || name;
      await shareFile("", landed);
    } catch (e) {
      lastError.value = (e as Error)?.message ?? String(e);
    }
  }

  /** Entries whose bytes still sit OUTSIDE the enigma folder (added before it
   *  existed). The migrate card offers to copy them in. */
  const legacyEntries = computed(() =>
    entries.value.filter((e) => {
      const rec = localRecords.get(e.id);
      return !!rec && !!root.value && !rec.path.startsWith(root.value + "/");
    }),
  );

  /** Copy every legacy entry's file into the enigma folder (sources stay). */
  async function migrateLegacy(): Promise<void> {
    if (!isTauri() || !legacyEntries.value.length) return;
    lastError.value = null;
    const items = legacyEntries.value.map((e) => ({
      entryId: e.id,
      srcPath: localRecords.get(e.id)!.path,
      dir: e.dir ?? "",
      name: e.name,
    }));
    try {
      const results = await invoke<Array<{ entryId: string; status: string; newPath?: string | null }>>(
        "filesync_migrate",
        { items },
      );
      const now = Date.now();
      for (const r of results) {
        const rec = localRecords.get(r.entryId);
        if (r.status === "migrated" && r.newPath && rec) {
          localRecords.set(r.entryId, { ...rec, path: r.newPath, verifiedAt: now });
        }
      }
      await saveLocalRecords();
      await refresh();
    } catch (e) {
      lastError.value = (e as Error)?.message ?? String(e);
    }
  }

  /** Remove from the shared list (tombstone — propagates). Bytes stay on disk. */
  async function removeEntry(entryId: string): Promise<void> {
    await deviceSync.value?.tombstoneFileEntry(entryId);
    localRecords.delete(entryId);
    selection.delete(entryId);
    items.delete(entryId);
    await saveLocalRecords();
  }

  async function openFolder(): Promise<void> {
    if (!isTauri()) return;
    try {
      const dir = await invoke<string>("filesync_dir");
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(dir);
    } catch (e) {
      lastError.value = (e as Error)?.message ?? String(e);
    }
  }

  // ── push ────────────────────────────────────────────────────────────────────

  /** True when every sibling already claims our exact bytes — nothing to send. */
  function everySiblingHas(entry: SyncedFileEntry, hash: string): boolean {
    const sibs = siblingIds.value;
    if (!sibs.length) return false;
    return sibs.every((id) => entry.copies[id]?.hash === hash);
  }

  async function pushSelected(): Promise<void> {
    if (!canTransfer.value || !selection.size) return;
    const ds = deviceSync.value!;
    batchDir.value = "push";
    batchActive.value = true;
    items.clear();
    lastError.value = null;
    const maxMb = await getMaxFileSizeMb();
    // Changed files are PULL-ONLY: hashes differ between devices, and pushing
    // would overwrite the other side's edits from here. Each device resolves a
    // divergence by pulling the version it wants — so they never enter a push
    // batch, however they got selected.
    const picked = entries.value.filter(
      (e) => selection.has(e.id) && entryState(e) !== "differs",
    );
    const announce: DlinkFilePushItem[] = [];

    for (const entry of picked) {
      setRow(entry.id, "working");
      const rec = localRecords.get(entry.id);
      if (!rec) {
        setRow(entry.id, "missing");
        continue;
      }
      let hash = rec.hash;
      let size = rec.size;
      try {
        // Stat + rehash before every push: the file may have changed or gone.
        const fresh = await invoke<{ hash: string; size: number }>("filesync_hash", { path: rec.path });
        hash = fresh.hash;
        size = fresh.size;
        if (hash !== rec.hash || size !== rec.size) {
          localRecords.set(entry.id, { ...rec, hash, size, verifiedAt: Date.now() });
          await saveLocalRecords();
          await ds.recordFileCopy(entry.id, { hash, size, updatedAt: Date.now() });
        }
      } catch {
        setRow(entry.id, "missing");
        continue;
      }
      if (maxMb > 0 && size > maxMb * 1024 * 1024) {
        setRow(entry.id, "too-large");
        continue;
      }
      if (everySiblingHas(entry, hash)) {
        setRow(entry.id, "skipped");
        continue;
      }
      try {
        const offer = await invoke<OfferCreatedWire>("file_offer_create", { path: rec.path });
        outgoing.set(offer.offer_id, entry.id);
        announce.push({
          entryId: entry.id,
          offerId: offer.offer_id,
          addr: offer.addr,
          name: entry.name,
          ...(entry.dir ? { dir: entry.dir } : {}),
          size,
          hash,
        });
        scheduleOfferGc(offer.offer_id, entry.id);
      } catch (e) {
        setRow(entry.id, "failed", (e as Error)?.message ?? String(e));
      }
    }

    if (announce.length) {
      await ds
        .sendDevlinkFile("dlink_file_push", { v: FILESYNC_VERSION, items: announce })
        .catch((e: unknown) => {
          lastError.value = (e as Error)?.message ?? String(e);
          for (const item of announce) setRow(item.entryId, "failed");
        });
    }
    batchActive.value = false;
  }

  function scheduleOfferGc(offerId: string, entryId: string): void {
    setTimeout(() => {
      if (!outgoing.has(offerId)) return;
      outgoing.delete(offerId);
      void invoke("file_offer_cancel", { offerId }).catch(() => {});
      const item = items.get(entryId);
      if (item && item.status === "working") setRow(entryId, "failed", "peer did not fetch");
    }, OFFER_TTL_MS);
  }

  // ── pull ────────────────────────────────────────────────────────────────────

  async function pullSelected(): Promise<void> {
    if (!canTransfer.value || !selection.size) return;
    const ds = deviceSync.value!;
    batchDir.value = "pull";
    batchActive.value = true;
    items.clear();
    lastError.value = null;
    const wanted: string[] = [];

    for (const entry of entries.value.filter((e) => selection.has(e.id))) {
      const sibCopies = siblingIds.value.map((id) => entry.copies[id]).filter(Boolean);
      if (!sibCopies.length) {
        setRow(entry.id, "unavailable");
        continue;
      }
      const mine = localRecords.get(entry.id);
      if (mine && sibCopies.some((c) => c.hash === mine.hash)) {
        setRow(entry.id, "skipped");
        continue;
      }
      setRow(entry.id, "working");
      wanted.push(entry.id);
    }

    if (wanted.length) {
      await ds
        .sendDevlinkFile("dlink_file_pull_req", { v: FILESYNC_VERSION, reqId: nanoid(), entryIds: wanted })
        .catch((e: unknown) => {
          lastError.value = (e as Error)?.message ?? String(e);
          for (const id of wanted) setRow(id, "failed");
        });
    }
    // The batch stays "open" only for the request; incoming pushes drive the
    // rows from here, so the buttons come back immediately.
    batchActive.value = false;
  }

  /** A sibling asks for our copies — answer with offers for what we have. */
  async function onPullReq(payload: Record<string, unknown>): Promise<void> {
    const ds = deviceSync.value;
    if (!ds || !linked.value || !isTauri()) return;
    const req = validateDlinkFilePullReq(payload);
    if (!req) return;
    const known = new Map(entries.value.map((e) => [e.id, e]));
    const announce: DlinkFilePushItem[] = [];

    for (const entryId of req.entryIds) {
      const entry = known.get(entryId);
      const rec = localRecords.get(entryId);
      if (!entry || !rec) {
        await reply(entryId, "missing", req.reqId);
        continue;
      }
      try {
        const { hash, size } = await invoke<{ hash: string; size: number }>("filesync_hash", { path: rec.path });
        const offer = await invoke<OfferCreatedWire>("file_offer_create", { path: rec.path });
        outgoing.set(offer.offer_id, entryId);
        announce.push({
          entryId,
          offerId: offer.offer_id,
          addr: offer.addr,
          name: entry.name,
          ...(entry.dir ? { dir: entry.dir } : {}),
          size,
          hash,
        });
        scheduleOfferGc(offer.offer_id, entryId);
      } catch {
        await reply(entryId, "missing", req.reqId);
      }
    }
    if (announce.length) {
      await ds
        .sendDevlinkFile("dlink_file_push", { v: FILESYNC_VERSION, reqId: req.reqId, items: announce })
        .catch(() => {});
    }
  }

  // ── receiving ───────────────────────────────────────────────────────────────

  /** Runs only for consented frames: useDeviceSync parks unsolicited pushes
   *  until the user accepts (which replays them here); reqId pushes answer our
   *  own pull. Devlink admission already vouched for the sender either way. */
  async function onPush(payload: Record<string, unknown>): Promise<void> {
    if (!linked.value || !isTauri()) return;
    const frame = validateDlinkFilePush(payload);
    if (!frame) return;
    const maxMb = await getMaxFileSizeMb();
    const known = new Map(entries.value.map((e) => [e.id, e]));

    for (const item of frame.items) {
      // Unknown/tombstoned locally ⇒ ignore: the list converges first, and the
      // sender re-announces on the next press.
      if (!known.has(item.entryId)) continue;
      // Busy with our own outgoing transfer of this entry — don't cross wires.
      if (outgoing.size && [...outgoing.values()].includes(item.entryId)) {
        await reply(item.entryId, "failed", frame.reqId);
        continue;
      }
      const mine = localRecords.get(item.entryId);
      if (mine?.hash === item.hash) {
        setRow(item.entryId, "skipped");
        await reply(item.entryId, "skipped", frame.reqId);
        continue;
      }
      if (maxMb > 0 && item.size > maxMb * 1024 * 1024) {
        setRow(item.entryId, "too-large");
        await reply(item.entryId, "too-large", frame.reqId);
        continue;
      }
      try {
        const dest = await invoke<string>("filesync_recv_path", { offerId: item.offerId });
        incoming.set(item.offerId, {
          entryId: item.entryId,
          name: item.name,
          hash: item.hash,
          dir: item.dir,
          reqId: frame.reqId,
        });
        items.set(item.entryId, { status: "working", transferred: 0, total: item.size });
        await invoke("file_download", { addr: item.addr, offerId: item.offerId, dest });
      } catch (e) {
        incoming.delete(item.offerId);
        setRow(item.entryId, "failed", (e as Error)?.message ?? String(e));
        await reply(item.entryId, "failed", frame.reqId);
      }
    }
  }

  async function finishReceive(offerId: string): Promise<void> {
    const rx = incoming.get(offerId);
    if (!rx) return;
    incoming.delete(offerId);
    const prior = localRecords.get(rx.entryId)?.path;
    try {
      const imported = await invoke<{ path: string; name: string; hash: string; size: number }>(
        "filesync_import",
        { offerId, name: rx.name, expectedHash: rx.hash, priorPath: prior ?? null, dir: rx.dir ?? null },
      );
      localRecords.set(rx.entryId, {
        path: imported.path,
        hash: imported.hash,
        size: imported.size,
        verifiedAt: Date.now(),
      });
      await saveLocalRecords();
      // Announces our new state to every sibling (broadcasts the list).
      await deviceSync.value?.recordFileCopy(rx.entryId, {
        hash: imported.hash,
        size: imported.size,
        updatedAt: Date.now(),
      });
      setRow(rx.entryId, "received");
      await reply(rx.entryId, "received", rx.reqId);
    } catch (e) {
      setRow(rx.entryId, "failed", (e as Error)?.message ?? String(e));
      await reply(rx.entryId, "failed", rx.reqId);
    }
  }

  /** The peer reports what it did with a file we announced (or couldn't send). */
  function onResult(payload: Record<string, unknown>): void {
    const res = validateDlinkFileResult(payload);
    if (!res) return;
    const item = items.get(res.entryId);
    // "received" on the sender side is already covered by file://done → sent;
    // don't downgrade a confirmed send.
    if (res.status === "received" && item?.status === "sent") return;
    setRow(res.entryId, res.status);
  }

  /** Row state for the UI: what this device holds vs what siblings claim. */
  function entryState(entry: SyncedFileEntry): "synced" | "differs" | "local-only" | "remote-only" | "missing" {
    const mine = localRecords.get(entry.id);
    const sibs = siblingIds.value.map((id) => entry.copies[id]).filter(Boolean);
    if (!mine) return sibs.length ? "remote-only" : "missing";
    if (!sibs.length) return "local-only";
    return sibs.some((c) => c.hash === mine.hash) ? "synced" : "differs";
  }

  function localRecord(entryId: string): LocalFileRecord | undefined {
    return localRecords.get(entryId);
  }

  // ── tree buckets ────────────────────────────────────────────────────────────
  // Two sources joined by absolute path: the scan says what the folder holds,
  // the shared list says what the devices agreed to mirror. Marker names line
  // up with FileTree.vue; the panel maps them to the fsync.state* strings.

  /** Absolute path a scanned file resolves to (the join key with records). */
  function scanPath(f: ScannedFile): string {
    return f.dir ? `${root.value}/${f.dir}/${f.name}` : `${root.value}/${f.name}`;
  }

  /** This device's bucket: everything in the folder, plus ghost rows for
   *  listed files that have no bytes here yet (pullable). */
  const myBucket = computed<BucketFile[]>(() => {
    const byPath = new Map<string, SyncedFileEntry>();
    for (const e of entries.value) {
      const rec = localRecords.get(e.id);
      if (rec) byPath.set(rec.path, e);
    }
    const seen = new Set<string>();
    const rows: BucketFile[] = [];
    for (const f of scanFiles.value) {
      const entry = byPath.get(scanPath(f));
      if (!entry) {
        rows.push({ id: `s:${f.dir}/${f.name}`, dir: f.dir, name: f.name, size: f.size, marker: "notShared" });
        continue;
      }
      seen.add(entry.id);
      const state = entryState(entry);
      rows.push({
        id: entry.id,
        dir: f.dir,
        name: f.name,
        size: f.size,
        marker: state === "differs" ? "changed" : state === "local-only" ? "excess" : undefined,
        selectable: true,
      });
    }
    // Listed but not on this disk (or bytes outside the folder): ghost rows.
    for (const e of entries.value) {
      if (seen.has(e.id)) continue;
      const rec = localRecords.get(e.id);
      if (rec && !rec.path.startsWith(root.value + "/")) continue; // legacy card handles these
      rows.push({ id: e.id, dir: e.dir ?? "", name: e.name, marker: "missing", selectable: true });
    }
    return rows;
  });

  /** One names-only bucket per linked sibling, markers relative to US. */
  const siblingBuckets = computed(() => {
    const reg = deviceSync.value?.registry.value;
    return siblingIds.value.map((sibId) => {
      const files: BucketFile[] = [];
      for (const e of entries.value) {
        const theirs = e.copies[sibId];
        const mine = localRecords.get(e.id);
        if (theirs) {
          files.push({
            id: `${sibId}:${e.id}`,
            dir: e.dir ?? "",
            name: e.name,
            marker: !mine ? "excess" : mine.hash !== theirs.hash ? "changed" : undefined,
          });
        } else if (mine) {
          // We hold it, they don't — missing over there.
          files.push({ id: `${sibId}:${e.id}`, dir: e.dir ?? "", name: e.name, marker: "missing" });
        }
      }
      const dev = reg?.devices.find((d) => d.deviceId === sibId);
      return { deviceId: sibId, label: dev?.label ?? sibId, files };
    });
  });

  // ── incoming-push consent (pass-through to useDeviceSync's queue) ──────────

  // Optional-chained twice: component tests hand in slim deviceSync fakes.
  const pendingPushOffers = computed(() => deviceSync.value?.pendingPushOffers?.value ?? []);
  function acceptPushOffer(offerId: string): void {
    deviceSync.value?.acceptPushOffer(offerId);
  }
  async function declinePushOffer(offerId: string): Promise<void> {
    await deviceSync.value?.declinePushOffer(offerId);
  }

  /** True when a selected entry is hash-diverged — the panel shows the
   *  pull-only hint and pushSelected refuses those rows. */
  const selectionHasChanged = computed(() =>
    entries.value.some((e) => selection.has(e.id) && entryState(e) === "differs"),
  );

  return {
    // state
    entries, localRecords, selection, items, batchDir, batchActive, lastError,
    linked, online, canTransfer, allSelected, siblingIds,
    root, scanFiles, scanTruncated, legacyEntries, myBucket, siblingBuckets,
    pendingPushOffers, selectionHasChanged,
    // actions
    init, refresh, addFile, shareFile, migrateLegacy, removeEntry, openFolder,
    toggle, selectAll, pushSelected, pullSelected,
    acceptPushOffer, declinePushOffer,
    entryState, localRecord,
    // exposed for tests
    _internal: { onPush, onPullReq, onResult, finishReceive, loadLocalRecords },
  };
});
