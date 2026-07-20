// Persisted per-room chat log — the storage half of multi-device history sync
// (and the reason a room's timeline now survives an app restart).
//
// Layout (encrypted kv, ns "chat:log", scope = room slug):
//   "index"    → { v, segs: [{ n, count }] }   segment directory, oldest first
//   "seg-<n>"  → PersistedMessage[]            ≤ CHAT_LOG_SEG_MAX_MSGS each
// Segmenting bounds the sealed value rewritten per append; pruning drops whole
// oldest segments once the room exceeds the chat_history_cap_msgs setting.
// System messages are never written here (presentation, not history).

import { kvGet, kvPut, kvDelete, kvClearNamespace } from "./localDb";
import {
  CHAT_LOG_SEG_MAX_MSGS, mergeMessages, validatePersistedMessage,
  type PersistedMessage,
} from "../deviceSyncModel";

const NS = "chat:log";
const INDEX_KEY = "index";

interface LogIndex {
  v: 1;
  segs: { n: number; count: number }[];
}

async function loadIndex(slug: string): Promise<LogIndex> {
  try {
    const raw = await kvGet(NS, slug, INDEX_KEY);
    if (!raw) return { v: 1, segs: [] };
    const parsed = JSON.parse(raw) as LogIndex;
    if (parsed?.v !== 1 || !Array.isArray(parsed.segs)) return { v: 1, segs: [] };
    return parsed;
  } catch {
    return { v: 1, segs: [] };
  }
}

async function loadSegment(slug: string, n: number): Promise<PersistedMessage[]> {
  try {
    const raw = await kvGet(NS, slug, `seg-${n}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(validatePersistedMessage)
      .filter((m): m is PersistedMessage => m !== null);
  } catch {
    return [];
  }
}

async function writeSegment(slug: string, n: number, msgs: PersistedMessage[]): Promise<void> {
  await kvPut(NS, slug, `seg-${n}`, JSON.stringify(msgs)).catch(() => {});
}

async function writeIndex(slug: string, index: LogIndex): Promise<void> {
  await kvPut(NS, slug, INDEX_KEY, JSON.stringify(index)).catch(() => {});
}

// Read–modify–write cycles must not interleave (two appends, or an append
// racing a merge): all mutations for the process are funneled through one
// promise chain. Cheap, and correctness beats parallel writes here.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => {});
  return next;
}

/** The whole stored timeline for a room, oldest first, deduped by id. Dedup on
 *  read is the backstop for a rare append/merge interleave (a live message
 *  buffered in the appender while a dlink_history merge rewrites the log) —
 *  first occurrence wins, so ordering is preserved. */
export async function loadLog(slug: string): Promise<PersistedMessage[]> {
  const index = await loadIndex(slug);
  const out: PersistedMessage[] = [];
  const seen = new Set<string>();
  for (const seg of index.segs) {
    for (const m of await loadSegment(slug, seg.n)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

/** {count, latestTs} without loading every segment — for dlink_hello. */
export async function logMeta(slug: string): Promise<{ count: number; latestTs: number }> {
  const index = await loadIndex(slug);
  const count = index.segs.reduce((sum, s) => sum + s.count, 0);
  const lastSeg = index.segs[index.segs.length - 1];
  if (!lastSeg) return { count: 0, latestTs: 0 };
  const msgs = await loadSegment(slug, lastSeg.n);
  return { count, latestTs: msgs.length ? msgs[msgs.length - 1].ts : 0 };
}

/** Messages strictly newer than `sinceTs`, oldest first. */
export async function messagesSince(slug: string, sinceTs: number): Promise<PersistedMessage[]> {
  return (await loadLog(slug)).filter((m) => m.ts > sinceTs);
}

async function prune(slug: string, index: LogIndex, cap: number): Promise<void> {
  let total = index.segs.reduce((sum, s) => sum + s.count, 0);
  while (index.segs.length > 1 && total - index.segs[0].count >= cap) {
    const dropped = index.segs.shift()!;
    total -= dropped.count;
    await kvDelete(NS, slug, `seg-${dropped.n}`).catch(() => {});
  }
}

/** Append new messages (already deduped by the caller against live state).
 *  Rolls a new segment past CHAT_LOG_SEG_MAX_MSGS; prunes past `cap`. */
export function appendMessages(slug: string, msgs: PersistedMessage[], cap: number): Promise<void> {
  if (msgs.length === 0) return Promise.resolve();
  return serialize(async () => {
    const index = await loadIndex(slug);
    let queue = [...msgs];
    while (queue.length > 0) {
      let seg = index.segs[index.segs.length - 1];
      if (!seg || seg.count >= CHAT_LOG_SEG_MAX_MSGS) {
        seg = { n: (seg?.n ?? -1) + 1, count: 0 };
        index.segs.push(seg);
      }
      const room = CHAT_LOG_SEG_MAX_MSGS - seg.count;
      const take = queue.slice(0, room);
      queue = queue.slice(room);
      const existing = seg.count > 0 ? await loadSegment(slug, seg.n) : [];
      await writeSegment(slug, seg.n, [...existing, ...take]);
      seg.count = existing.length + take.length;
    }
    await prune(slug, index, cap);
    await writeIndex(slug, index);
  });
}

/** Merge a remote batch into the stored log (dedupe by id, reorder by ts) and
 *  rewrite the segments. Returns how many messages were actually new. */
export function mergeIntoLog(
  slug: string,
  incoming: PersistedMessage[],
  cap: number,
): Promise<number> {
  if (incoming.length === 0) return Promise.resolve(0);
  return serialize(async () => {
    const index = await loadIndex(slug);
    const local = [];
    for (const seg of index.segs) local.push(...(await loadSegment(slug, seg.n)));
    const merged = mergeMessages(local, incoming, cap);
    const added = merged.length - local.length;
    const localIds = new Set(local.map((m) => m.id));
    if (added === 0 && merged.every((m) => localIds.has(m.id))) return 0;

    // Rewrite from segment 0; delete any leftover old segment keys.
    const newSegs: LogIndex["segs"] = [];
    for (let i = 0; i * CHAT_LOG_SEG_MAX_MSGS < merged.length; i++) {
      const chunk = merged.slice(i * CHAT_LOG_SEG_MAX_MSGS, (i + 1) * CHAT_LOG_SEG_MAX_MSGS);
      await writeSegment(slug, i, chunk);
      newSegs.push({ n: i, count: chunk.length });
    }
    for (const seg of index.segs) {
      if (!newSegs.some((s) => s.n === seg.n)) {
        await kvDelete(NS, slug, `seg-${seg.n}`).catch(() => {});
      }
    }
    await writeIndex(slug, { v: 1, segs: newSegs });
    return Math.max(0, added);
  });
}

/** Drop a room's entire stored history (room deleted / kicked / closed). */
export function wipeLog(slug: string): Promise<void> {
  return serialize(() => kvClearNamespace(NS, slug));
}

/** Buffered appender: batches pushMessage-rate writes into one kv write per
 *  room per second (or per 50 messages). Call flushNow() on teardown/switch. */
export function createLogAppender(getCap: () => number) {
  const pending = new Map<string, PersistedMessage[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flushNow(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    const batches = [...pending.entries()];
    pending.clear();
    for (const [slug, msgs] of batches) {
      await appendMessages(slug, msgs, getCap());
    }
  }

  function push(slug: string, msg: PersistedMessage): void {
    const list = pending.get(slug) ?? [];
    list.push(msg);
    pending.set(slug, list);
    if (list.length >= 50) { void flushNow(); return; }
    if (!timer) timer = setTimeout(() => void flushNow(), 1000);
  }

  /** Discard a room's buffered (not-yet-flushed) messages — call BEFORE wipeLog
   *  on delete/kick/close so a pending flush can't resurrect wiped history. */
  function drop(slug: string): void {
    pending.delete(slug);
  }

  return { push, flushNow, drop };
}
