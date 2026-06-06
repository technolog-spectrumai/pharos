// Offline storage for the Notes (bento) module: a cached snapshot of the data
// (so notes are viewable/editable with no server) plus a queue of mutations
// made while offline, replayed by the store's sync(). Persistence is plain
// localStorage (works in both the browser and the Tauri webview), namespaced by
// server URL so different backends never share a cache.
import type { NoteBox, NoteCategory, NoteLink, NoteReference, NoteProperties } from "./api";

export interface NotesSnapshot {
  boxes: NoteBox[];
  categories: NoteCategory[];
  links: NoteLink[];
  references: NoteReference[];
  lastSyncedAt: string | null;
}

export type QueueOp =
  | { id: string; kind: "createBox"; tempId: number; data: { label: string; properties: NoteProperties; category_id?: number | null } }
  | { id: string; kind: "updateBox"; boxId: number; data: Partial<{ label: string; properties: NoteProperties; category_id: number | null }> }
  | { id: string; kind: "deleteBox"; boxId: number }
  | { id: string; kind: "createLink"; tempId: number; from_box: number; to_box: number; label: string }
  | { id: string; kind: "deleteLink"; linkId: number }
  | { id: string; kind: "deleteReference"; refId: number };

const PREFIX = "enigma:notes:";

function scopeKey(scope: string, suffix: string): string {
  return `${PREFIX}${suffix}:${scope || "default"}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / unavailable — stay in-memory */
  }
}

export function loadSnapshot(scope: string): NotesSnapshot | null {
  return readJson<NotesSnapshot | null>(scopeKey(scope, "snapshot"), null);
}

export function saveSnapshot(scope: string, snapshot: NotesSnapshot): void {
  writeJson(scopeKey(scope, "snapshot"), snapshot);
}

export function loadQueue(scope: string): QueueOp[] {
  return readJson<QueueOp[]>(scopeKey(scope, "queue"), []);
}

export function saveQueue(scope: string, queue: QueueOp[]): void {
  writeJson(scopeKey(scope, "queue"), queue);
}

export function clearOffline(scope: string): void {
  try {
    localStorage.removeItem(scopeKey(scope, "snapshot"));
    localStorage.removeItem(scopeKey(scope, "queue"));
  } catch {
    /* ignore */
  }
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** Optimistic ids for offline-created rows are negative so they never collide
 *  with real (positive) server ids. */
export function makeTempId(rows: { id: number }[]): number {
  let min = 0;
  for (const r of rows) if (r.id < min) min = r.id;
  return min - 1;
}

export function isTempId(id: number): boolean {
  return id < 0;
}

let _counter = 0;
/** A short unique id for a queue entry (not the row id). */
export function opId(): string {
  _counter += 1;
  return `${Date.now().toString(36)}-${_counter}`;
}

/** Network failures (fetch rejects → TypeError, no HTTP status) mean "offline";
 *  real HTTP errors are thrown as `"<status>: ..."` and must NOT be queued. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const msg = (e as Error)?.message ?? "";
  return !/^\d{3}:/.test(msg);
}

/** Replace a temp row id with its real id everywhere in the pending queue
 *  (so a later op that references an offline-created box targets the real row). */
export function remapQueueId(queue: QueueOp[], from: number, to: number): QueueOp[] {
  return queue.map((op) => {
    switch (op.kind) {
      case "updateBox":
      case "deleteBox":
        return op.boxId === from ? { ...op, boxId: to } : op;
      case "createLink": {
        const next = { ...op };
        if (next.from_box === from) next.from_box = to;
        if (next.to_box === from) next.to_box = to;
        return next;
      }
      default:
        return op;
    }
  });
}

/** Human-readable counts of what's pending, for the Sync button tooltip. */
export function summarizeQueue(queue: QueueOp[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const op of queue) out[op.kind] = (out[op.kind] ?? 0) + 1;
  return out;
}
