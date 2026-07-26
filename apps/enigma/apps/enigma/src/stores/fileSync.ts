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
// which BLAKE3-verifies before anything lands in <profile>/synced/. The
// devlink room is the trust boundary — its admission demands a link-key HMAC
// and refuses revoked devices — so incoming pushes are auto-accepted without a
// prompt. A room peer can never reach this code.
//
// Wire conventions (mirroring map.ts):
//   invoke args    → camelCase   file_* results → snake_case (offer_id, …)
//   filesync_*     → camelCase   event payloads → camelCase (offerId, …)

import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import { nanoid } from "nanoid";
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
  const incoming = reactive(new Map<string, { entryId: string; name: string; hash: string; reqId?: string }>());
  /** offerId → entryId for offers WE created, so file://done marks them sent. */
  const outgoing = reactive(new Map<string, string>());

  const deviceSync = computed(() => chat.deviceSync);
  const linked = computed(() => !!deviceSync.value?.linked.value);
  const online = computed(() => !!deviceSync.value?.devOnline.value);
  const entries = computed<SyncedFileEntry[]>(() =>
    liveFileEntries(deviceSync.value?.fileEntries.value ?? []),
  );
  const canTransfer = computed(() => linked.value && online.value && !batchActive.value && isTauri());
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

  /** Pick a local file and put it on the shared list. Only local files can be
   *  added (no remote browsing) — the peer mirrors the entry and can pull it. */
  async function addFile(): Promise<void> {
    lastError.value = null;
    if (!isTauri() || !deviceSync.value) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, directory: false });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    // Device-local dedupe: the same path twice is a slip, not two entries.
    for (const [entryId, rec] of localRecords) {
      if (rec.path === path && entries.value.some((e) => e.id === entryId)) return;
    }
    try {
      const { hash, size } = await invoke<{ hash: string; size: number }>("filesync_hash", { path });
      const now = Date.now();
      const name = path.split(/[\\/]/).pop() || "file";
      const entry: SyncedFileEntry = {
        id: nanoid(),
        name: name.slice(0, 120),
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
    const picked = entries.value.filter((e) => selection.has(e.id));
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
        announce.push({ entryId, offerId: offer.offer_id, addr: offer.addr, name: entry.name, size, hash });
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

  /** Auto-accept: the frame already passed devlink admission, so the sender is
   *  one of the user's own non-revoked devices. */
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
        { offerId, name: rx.name, expectedHash: rx.hash, priorPath: prior ?? null },
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

  return {
    // state
    entries, localRecords, selection, items, batchDir, batchActive, lastError,
    linked, online, canTransfer, allSelected, siblingIds,
    // actions
    init, addFile, removeEntry, openFolder, toggle, selectAll, pushSelected, pullSelected,
    entryState, localRecord,
    // exposed for tests
    _internal: { onPush, onPullReq, onResult, finishReceive, loadLocalRecords },
  };
});
