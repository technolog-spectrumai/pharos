// Group Kanban orchestrator — one shared board per chat room.
//
// Columns are captain-owned (the captain = lowest live MLS id, reused from the
// chat channel) and travel as a single snapshot behind a monotonic `columnsRev`,
// exactly like room_meta. Cards are collaboratively owned: any member creates /
// edits / moves (promote/demote) / deletes / reorders them, reconciled by
// last-write-wins (see kanbanModel.ts). Everything rides the chat channel's
// MLS-encrypted sync seam (`onSync`/`sendSync`, `kanban_*` inner types), and each
// profile persists its own copy of the open room's board in the encrypted kv
// store (namespace "kanban", one doc per room slug).
//
// Delivery model (same as useMeetings): `sendSync` reaches only the currently
// connected members of the open room, so mutations carry an outbox flag flushed
// when MLS becomes ready, and every peer re-broadcasts the board when the roster
// grows (late joiners / reconnecting members catch up; upserts are LWW and
// idempotent, including tombstones so deletes heal). Residual gap, accepted for
// v1: a peer never online at the same time as a card's holders never learns it.
//
// Trust model: cooperative — see kanbanModel.ts.

import { computed, ref, watch } from "vue";
import { getBuildConfig, kvGet, kvPut } from "rakotis";
import type { ChatChannel } from "rakotis";
import {
  applyRemoteCard,
  applyRemoteColumns,
  columnsSorted,
  keyBetween,
  last,
  seedKeys,
  sortColumnCards,
  wireFromCard,
  type BoardDoc,
  type Card,
  type CardDraft,
  type CardWire,
  type Column,
  type ColumnsWire,
} from "./kanbanModel";

const KV_NS = "kanban";
const KV_SCOPE = "default";

export function useKanban(channel: ChatChannel) {
  const cfg = getBuildConfig();
  const maxCards = cfg.kanban_max_cards_per_board;
  const maxTitle = cfg.kanban_max_card_title_len;
  const maxDesc = cfg.kanban_max_card_description_len;
  const allowReorder = cfg.kanban_allow_reorder;

  const columns = ref<Column[]>([]);
  const columnsRev = ref(0);
  const cards = ref<Card[]>([]);
  const boardSlug = ref("");
  // Local-only: columns snapshot pending broadcast (never persisted/sent as data).
  const columnsNeedsBroadcast = ref(false);
  // Nav attention dot: remote changes not yet seen in the Board tab.
  const unseen = ref(0);

  const selfName = () => channel.currentUserName.value;
  const selfDevice = () => channel.mlsIdentity.value;
  const amCaptain = channel.amCaptain;

  // ── persistence (encrypted kv, one doc per room slug) ──────────────────────
  async function loadBoard(slug: string) {
    boardSlug.value = slug;
    columnsNeedsBroadcast.value = false;
    if (!slug) {
      columns.value = [];
      columnsRev.value = 0;
      cards.value = [];
      return;
    }
    try {
      const raw = await kvGet(KV_NS, KV_SCOPE, slug);
      const doc = raw ? (JSON.parse(raw) as BoardDoc) : null;
      columns.value = Array.isArray(doc?.columns) ? doc!.columns : [];
      columnsRev.value = typeof doc?.columnsRev === "number" ? doc!.columnsRev : 0;
      cards.value = Array.isArray(doc?.cards) ? doc!.cards : [];
    } catch {
      columns.value = [];
      columnsRev.value = 0;
      cards.value = [];
    }
  }

  async function persist() {
    const slug = boardSlug.value;
    if (!slug) return;
    const doc: BoardDoc = { columns: columns.value, columnsRev: columnsRev.value, cards: cards.value };
    await kvPut(KV_NS, KV_SCOPE, slug, JSON.stringify(doc)).catch(() => {});
  }

  /** Re-read the open room's board (e.g. after a profile switch swapped kv dirs). */
  async function reload() {
    await loadBoard(channel.currentRoom.value?.slug ?? "");
  }

  function cardById(id: string): Card | undefined {
    return cards.value.find((c) => c.id === id);
  }

  function touch(c: Card) {
    c.author = selfDevice();
    c.updatedAt = Date.now();
    c.needsBroadcast = true;
  }

  // ── derived ────────────────────────────────────────────────────────────────
  const sortedColumns = computed(() => columnsSorted(columns.value));
  function cardsInColumn(columnId: string): Card[] {
    return sortColumnCards(cards.value, columnId);
  }
  const liveCardCount = computed(() => cards.value.filter((c) => !c.deleted).length);
  const attentionCount = computed(() => unseen.value);
  function markSeen() {
    unseen.value = 0;
  }

  // ── column actions (captain only) ──────────────────────────────────────────
  async function afterColumnMutation() {
    columnsRev.value += 1;
    columnsNeedsBroadcast.value = true;
    await persist();
    await flushOutbox();
  }

  /** Captain: seed the build-configured default columns on an empty board. */
  async function seedDefaultColumns() {
    if (!amCaptain.value || columns.value.length) return;
    const names = cfg.kanban_default_columns;
    const keys = seedKeys(names.length);
    columns.value = names.map((title, i) => ({ id: crypto.randomUUID(), title, orderKey: keys[i] }));
    await afterColumnMutation();
  }

  async function addColumn(title: string) {
    if (!amCaptain.value) return;
    const t = title.trim();
    if (!t) return;
    const tail = last(columnsSorted(columns.value));
    columns.value = [
      ...columns.value,
      { id: crypto.randomUUID(), title: t, orderKey: keyBetween(tail?.orderKey ?? null, null) },
    ];
    await afterColumnMutation();
  }

  async function renameColumn(id: string, title: string) {
    if (!amCaptain.value) return;
    const col = columns.value.find((c) => c.id === id);
    const t = title.trim();
    if (!col || !t) return;
    col.title = t;
    await afterColumnMutation();
  }

  async function recolorColumn(id: string, color: string) {
    if (!amCaptain.value) return;
    const col = columns.value.find((c) => c.id === id);
    if (!col) return;
    col.color = color || undefined;
    await afterColumnMutation();
  }

  /** Captain: shift a column left (dir=-1) or right (dir=+1). */
  async function moveColumn(id: string, dir: -1 | 1) {
    if (!amCaptain.value) return;
    const cols = columnsSorted(columns.value);
    const idx = cols.findIndex((c) => c.id === id);
    if (idx < 0 || idx + dir < 0 || idx + dir >= cols.length) return;
    const col = columns.value.find((c) => c.id === id);
    if (!col) return;
    const beforeKey = dir > 0 ? cols[idx + 1].orderKey : (cols[idx - 2]?.orderKey ?? null);
    const afterKey = dir > 0 ? (cols[idx + 2]?.orderKey ?? null) : cols[idx - 1].orderKey;
    col.orderKey = keyBetween(beforeKey, afterKey);
    await afterColumnMutation();
  }

  /** Captain: delete a column; its live cards move to the leftmost remaining
   *  column (or are tombstoned if it was the last column) — never silently lost. */
  async function deleteColumn(id: string) {
    if (!amCaptain.value) return;
    const remaining = columnsSorted(columns.value).filter((c) => c.id !== id);
    const fallback = remaining[0];
    for (const c of cards.value) {
      if (c.columnId !== id || c.deleted) continue;
      if (fallback) {
        const tail = last(sortColumnCards(cards.value, fallback.id));
        c.columnId = fallback.id;
        c.orderKey = keyBetween(tail?.orderKey ?? null, null);
      } else {
        c.deleted = true;
      }
      touch(c);
    }
    columns.value = remaining;
    await afterColumnMutation();
  }

  // ── card actions (all members) ─────────────────────────────────────────────
  async function createCard(columnId: string, draft: CardDraft) {
    if (liveCardCount.value >= maxCards) return;
    const now = Date.now();
    const tail = last(sortColumnCards(cards.value, columnId));
    const card: Card = {
      id: crypto.randomUUID(),
      columnId,
      title: draft.title.trim(),
      description: draft.description,
      assignee: draft.assignee,
      dueDate: draft.dueDate,
      color: draft.color,
      orderKey: keyBetween(tail?.orderKey ?? null, null),
      author: selfDevice(),
      createdAt: now,
      updatedAt: now,
      deleted: false,
      needsBroadcast: true,
    };
    cards.value = [...cards.value, card];
    await persist();
    await flushOutbox();
  }

  async function updateCard(id: string, draft: CardDraft) {
    const c = cardById(id);
    if (!c || c.deleted) return;
    c.title = draft.title.trim();
    c.description = draft.description;
    c.assignee = draft.assignee;
    c.dueDate = draft.dueDate;
    c.color = draft.color;
    touch(c);
    await persist();
    await flushOutbox();
  }

  async function deleteCard(id: string) {
    const c = cardById(id);
    if (!c || c.deleted) return;
    c.deleted = true;
    touch(c);
    await persist();
    await flushOutbox();
  }

  /** Move a card to `columnId`, positioned via a fractional key between the given
   *  neighbour keys (null = column edge). Covers drag-drop and reorder. */
  async function moveCard(
    id: string,
    columnId: string,
    beforeKey: string | null = null,
    afterKey: string | null = null,
  ) {
    const c = cardById(id);
    if (!c || c.deleted) return;
    c.columnId = columnId;
    // Neighbours can share an order key (concurrent same-slot inserts, tie-broken
    // by author/id) — keyBetween would throw on a >= b; fall back to "after the
    // lower neighbour" so a drop never fails.
    try {
      c.orderKey = keyBetween(beforeKey, afterKey);
    } catch {
      c.orderKey = keyBetween(beforeKey, null);
    }
    touch(c);
    await persist();
    await flushOutbox();
  }

  /** Promote (dir=+1) / demote (dir=-1): move to the adjacent column's end. */
  async function moveToAdjacent(id: string, dir: -1 | 1) {
    const c = cardById(id);
    if (!c || c.deleted) return;
    const cols = columnsSorted(columns.value);
    const idx = cols.findIndex((col) => col.id === c.columnId);
    const target = cols[idx + dir];
    if (!target) return;
    const tail = last(sortColumnCards(cards.value, target.id));
    await moveCard(id, target.id, tail?.orderKey ?? null, null);
  }
  const promoteCard = (id: string) => moveToAdjacent(id, 1);
  const demoteCard = (id: string) => moveToAdjacent(id, -1);

  // ── protocol: sending ──────────────────────────────────────────────────────
  function canSend(): boolean {
    const slug = channel.currentRoom.value?.slug;
    return !!slug && slug === boardSlug.value && channel.mlsStatus.value === "ready";
  }

  async function sendColumns() {
    await channel.sendSync("kanban_columns", {
      roomSlug: boardSlug.value,
      columns: columns.value,
      columnsRev: columnsRev.value,
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  async function sendCard(c: Card) {
    await channel.sendSync("kanban_card_upsert", {
      ...wireFromCard(c, boardSlug.value),
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  let flushing = false;
  /** Send every pending outbox item addressed to the open room. */
  async function flushOutbox() {
    if (flushing || !canSend()) return;
    flushing = true;
    try {
      if (columnsNeedsBroadcast.value && amCaptain.value) {
        try {
          await sendColumns();
          columnsNeedsBroadcast.value = false;
        } catch {
          /* stays pending for the next trigger */
        }
      }
      let dirty = false;
      for (const c of cards.value) {
        if (!c.needsBroadcast) continue;
        try {
          await sendCard(c);
          c.needsBroadcast = false;
          dirty = true;
        } catch {
          /* stays in the outbox */
        }
      }
      if (dirty) await persist();
    } finally {
      flushing = false;
    }
  }

  /** Presence catch-up: re-share the whole board so late joiners / reconnecting
   *  members converge. Captain re-sends the columns snapshot; every peer re-sends
   *  all its cards (tombstones included, so deletes heal). LWW makes duplicates
   *  harmless, so any online holder can heal a joiner — not only the last writer. */
  async function rebroadcastBoard() {
    if (!canSend()) return;
    if (amCaptain.value && columns.value.length) {
      try {
        await sendColumns();
      } catch {
        /* next presence event retries */
      }
    }
    for (const c of cards.value) {
      try {
        await sendCard(c);
      } catch {
        /* next presence event retries */
      }
    }
  }

  watch(channel.mlsStatus, (s) => {
    if (s === "ready") void flushOutbox();
  });
  watch(
    () => channel.participants.value.length,
    (n, o) => {
      if (n > (o ?? 0)) {
        void flushOutbox();
        void rebroadcastBoard();
      }
    },
  );
  watch(
    () => channel.currentRoom.value?.slug,
    (slug) => {
      void loadBoard(slug ?? "");
    },
  );

  // ── protocol: receiving ────────────────────────────────────────────────────
  channel.onSync((type, payload) => {
    if (!type.startsWith("kanban_")) return; // not ours
    if (payload.fromDevice === selfDevice()) return; // self-echo guard
    const slug = boardSlug.value;
    if (!slug || payload.roomSlug !== slug) return; // not the open board

    if (type === "kanban_columns") {
      const wire = payload as unknown as ColumnsWire;
      const fromCaptain = payload.fromDevice === channel.captainId.value;
      const next = applyRemoteColumns(columnsRev.value, wire, fromCaptain);
      if (!next) return;
      columns.value = next;
      columnsRev.value = wire.columnsRev;
      unseen.value += 1;
      void persist();
      // Handoff: if WE are the (new) captain adopting a peer's snapshot,
      // re-broadcast it authoritatively so the whole room converges.
      if (amCaptain.value) {
        columnsNeedsBroadcast.value = true;
        void flushOutbox();
      }
      return;
    }

    if (type === "kanban_card_upsert") {
      const wire = payload as unknown as CardWire;
      const existing = cardById(wire.id);
      const merged = applyRemoteCard(existing, wire);
      if (!merged) return; // stale / duplicate
      if (existing?.needsBroadcast) merged.needsBroadcast = true; // un-sent local edit survives
      cards.value = existing
        ? cards.value.map((c) => (c.id === merged.id ? merged : c))
        : [...cards.value, merged];
      unseen.value += 1;
      void persist();
      return;
    }
  });

  void loadBoard(channel.currentRoom.value?.slug ?? "");

  return {
    // state
    columns: sortedColumns,
    cards,
    columnsRev,
    amCaptain,
    attentionCount,
    // build-config surface (for the UI)
    allowReorder,
    maxTitle,
    maxDesc,
    // derivation
    cardsInColumn,
    markSeen,
    // column actions (captain)
    seedDefaultColumns,
    addColumn,
    renameColumn,
    recolorColumn,
    moveColumn,
    deleteColumn,
    // card actions (all members)
    createCard,
    updateCard,
    deleteCard,
    moveCard,
    promoteCard,
    demoteCard,
    // lifecycle
    reload,
    flushOutbox,
  };
}

export type Kanban = ReturnType<typeof useKanban>;
