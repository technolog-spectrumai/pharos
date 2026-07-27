<script setup lang="ts">
// The per-link board editor (peer.md P8). This board belongs to the LINK: there
// is no room slug, no captain election, and no roster — just two people, both of
// whom may change anything. Authority is therefore never resolved by role, only
// by the per-item clock, and that puts three rules on every handler below:
//
//   • Every local change stamps the thing it changed with `bumpClock(prev, me)`
//     — the card's own clock for card edits, `columnsClock` for the column set
//     (columns travel as one document). A change that forgets to bump does not
//     merely lose a race: it never propagates at all, because the peer's copy
//     already has that counter.
//   • A delete is a TOMBSTONE, never a splice. `mergePeerBoards` treats a card
//     the remote has never heard of as "not yet known", not as "deleted" — drop
//     the row and the peer pushes it straight back, forever.
//   • No wall clock decides anything. `Date.now()` appears nowhere in this file.
//
// Reads and writes go through exactly two functions, `peerSync.loadBoard` /
// `peerSync.putBoard`; the panel owns no storage and no wire type of its own.
// `putBoard` persists and broadcasts, so a write is also the send.

import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  OyaButton, OyaCard, OyaModal, OyaTextArea, OyaTextField,
  PEER_BOARD_CARDS_MAX, PEER_BOARD_COLUMNS_MAX, PEER_TEXT_MAX_LEN, PEER_TITLE_MAX_LEN,
  bumpClock, emptyPeerBoard, livePeerCards, mergePeerBoards,
  type PeerBoard, type PeerBoardCard, type PeerBoardColumn, type PeerGrant,
} from "rakotis";
import { useChatStore } from "../../stores/chat";
import { usePeersStore } from "../../stores/peers";
import { keyBetween, last, seedKeys, PEER_BOARD_DEFAULT_COLUMNS } from "./boardKeys";

const props = defineProps<{ grant: PeerGrant; darkMode: boolean }>();
const emit = defineEmits<{ close: [] }>();

const chatStore = useChatStore();
const peers = usePeersStore();

/** Re-read the stored board on a timer so an incoming `plink_board` frame shows
 *  up. Deliberately a poll of the local kv doc rather than a channel hook: the
 *  merge already happened in usePeerSync, this only has to notice, and the read
 *  is skipped entirely when nothing changed. */
const POLL_MS = 4000;

const board = ref<PeerBoard | null>(null);
/** Serialised copy of what we last read/wrote — the poll's cheap change test. */
let lastRaw = "";
let timer: ReturnType<typeof setInterval> | null = null;

const nodeId = computed(() => props.grant.peerNodeId);
const peerLabel = computed(
  () => props.grant.peerName || `${props.grant.peerNodeId.slice(0, 8)}…`,
);

/** The clock author. Every counter this panel writes is attributed to it, and it
 *  is also the tiebreak key, so an unknown NodeId means we must not write at
 *  all — a clock with an empty author fails `validateLClock` and would make the
 *  whole stored board unreadable on the next load. */
const me = computed(() => peers.myNodeId);

const iShareBoard = computed(() => props.grant.myScopes.includes("board"));
const theyShareBoard = computed(() => props.grant.theirScopes.includes("board"));
/** Neither direction carries the board: edits are real, but they stay here. */
const localOnly = computed(() => !iShareBoard.value && !theyShareBoard.value);
const canEdit = computed(() => !!me.value && !!board.value);

// ── load / poll ───────────────────────────────────────────────────────────────

function seededBoard(): PeerBoard {
  const titles = PEER_BOARD_DEFAULT_COLUMNS;
  return emptyPeerBoard(me.value, titles, seedKeys(titles.length));
}

async function reload(): Promise<void> {
  const stored = (await chatStore.peerSync?.loadBoard(nodeId.value)) ?? null;
  if (!stored) {
    // Nothing on disk yet: seed in memory only. Persisting the defaults here
    // would broadcast a columns document (clock c=1) that could out-tiebreak the
    // peer's real columns purely because our NodeId sorts lower.
    if (!board.value) board.value = seededBoard();
    return;
  }
  const raw = JSON.stringify(stored);
  if (raw === lastRaw) return;
  lastRaw = raw;
  board.value = stored;
}

onMounted(() => {
  void reload();
  timer = setInterval(() => void reload(), POLL_MS);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  timer = null;
});

// ── writes ────────────────────────────────────────────────────────────────────

/** Persist + broadcast a locally-mutated board.
 *
 *  `next` already carries the bumped clocks. Before writing it we fold in
 *  whatever is on disk *now* (`mergePeerBoards(local=next, remote=stored)`): a
 *  frame that landed since the last poll would otherwise be overwritten by our
 *  full-document write. The merge is by clock, so our just-bumped edit still
 *  wins its own item and nothing else is lost. */
async function commit(next: PeerBoard): Promise<void> {
  if (!me.value) return;
  const sync = chatStore.peerSync;
  const stored = (await sync?.loadBoard(nodeId.value)) ?? null;
  const merged = stored ? mergePeerBoards(next, stored).merged : next;
  board.value = merged;
  lastRaw = JSON.stringify(merged);
  await sync?.putBoard(nodeId.value, merged);
}

/** `keyBetween(prev, null)` that cannot throw. Card and column keys arrive over
 *  the plink seam, where `validatePeerBoardCard` only asks for a non-empty
 *  string ≤64 chars — a trailing zero (or any non-base-62 text) makes the pure
 *  midpoint throw, and an append that throws would lose the card outright. The
 *  fallback stays lexicographically after `prev`, which is all ordering needs;
 *  identical keys are already tie-broken by id everywhere. */
function appendKey(prev: string | null): string {
  try {
    return keyBetween(prev, null);
  } catch {
    return `${prev ?? "a"}z`;
  }
}

/** Insert-or-replace a card by id. Never removes — see the tombstone rule. */
function withCard(b: PeerBoard, card: PeerBoardCard): PeerBoard {
  const known = b.cards.some((c) => c.id === card.id);
  return {
    ...b,
    cards: known ? b.cards.map((c) => (c.id === card.id ? card : c)) : [...b.cards, card],
  };
}

// ── derivation ────────────────────────────────────────────────────────────────

/** Column order: fractional key, id as the deterministic tiebreak. */
const columns = computed<PeerBoardColumn[]>(() =>
  [...(board.value?.columns ?? [])].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  ),
);

/** Card order: key then id — the exact comparator `mergePeerBoards` applies, so
 *  the list does not reshuffle the moment a remote frame merges. (the group board's
 *  `compareCards` is deliberately NOT reused: it tiebreaks on `author`, which is
 *  an MLS device id there and a human display name here.) */
function compareBoardCards(a: PeerBoardCard, b: PeerBoardCard): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const liveCards = computed(() => (board.value ? livePeerCards(board.value) : []));

function cardsIn(columnId: string): PeerBoardCard[] {
  return liveCards.value.filter((c) => c.columnId === columnId).sort(compareBoardCards);
}

/** Live cards whose column no longer exists — the peer can delete a column (one
 *  clocked document) while our cards still point at it. They are shown rather
 *  than silently dropped, and any move puts them back in a real column. */
const orphanCards = computed(() => {
  const known = new Set(columns.value.map((c) => c.id));
  return liveCards.value.filter((c) => !known.has(c.columnId)).sort(compareBoardCards);
});

const atCardCap = computed(() => liveCards.value.length >= PEER_BOARD_CARDS_MAX);
const atColumnCap = computed(() => columns.value.length >= PEER_BOARD_COLUMNS_MAX);

// ── card editing (inline, no nested modal) ────────────────────────────────────

const addingIn = ref("");
const editingId = ref("");
const draftTitle = ref("");
const draftDescription = ref("");
const draftDone = ref(false);
const draftError = ref("");

function resetDraft() {
  addingIn.value = "";
  editingId.value = "";
  draftTitle.value = "";
  draftDescription.value = "";
  draftDone.value = false;
  draftError.value = "";
}

function startAdd(columnId: string) {
  resetDraft();
  addingIn.value = columnId;
}

function startEdit(card: PeerBoardCard) {
  resetDraft();
  editingId.value = card.id;
  draftTitle.value = card.title;
  draftDescription.value = card.description;
  draftDone.value = card.done;
}

async function submitAdd() {
  const b = board.value;
  const title = draftTitle.value.trim();
  if (!b || !canEdit.value) return;
  if (!title) {
    draftError.value = "peers.boardTitleRequired";
    return;
  }
  if (atCardCap.value) {
    draftError.value = "peers.boardCardCap";
    return;
  }
  const columnId = addingIn.value;
  const tail = last(cardsIn(columnId));
  const card: PeerBoardCard = {
    id: crypto.randomUUID(),
    columnId,
    title,
    description: draftDescription.value.slice(0, PEER_TEXT_MAX_LEN),
    key: appendKey(tail?.key ?? null),
    author: chatStore.p2p.currentUserName.value ?? "",
    done: false,
    // A brand-new card starts the counter: no previous clock to advance.
    clock: bumpClock(undefined, me.value),
  };
  resetDraft();
  await commit(withCard(b, card));
}

async function submitEdit() {
  const b = board.value;
  const card = b?.cards.find((c) => c.id === editingId.value);
  const title = draftTitle.value.trim();
  if (!b || !card || !canEdit.value) return;
  if (!title) {
    draftError.value = "peers.boardTitleRequired";
    return;
  }
  const next: PeerBoardCard = {
    ...card,
    title,
    description: draftDescription.value.slice(0, PEER_TEXT_MAX_LEN),
    done: draftDone.value,
    clock: bumpClock(card.clock, me.value),
  };
  resetDraft();
  await commit(withCard(b, next));
}

/** Delete = tombstone + clock bump. The stub stays in `cards` forever (well,
 *  until the board is dropped): that is the only thing that makes the delete
 *  converge instead of the peer re-pushing the card back on every hello. */
async function deleteCard(card: PeerBoardCard) {
  const b = board.value;
  if (!b || !canEdit.value) return;
  resetDraft();
  await commit(
    withCard(b, { ...card, deleted: true, clock: bumpClock(card.clock, me.value) }),
  );
}

/** Move a card one column left (dir=-1) or right (dir=+1); an orphaned card
 *  (its column is gone) lands in the first column either way. */
async function moveCard(card: PeerBoardCard, dir: -1 | 1) {
  const b = board.value;
  if (!b || !canEdit.value) return;
  const cols = columns.value;
  const idx = cols.findIndex((c) => c.id === card.columnId);
  const target = idx < 0 ? cols[0] : cols[idx + dir];
  if (!target) return;
  const tail = last(cardsIn(target.id));
  await commit(
    withCard(b, {
      ...card,
      columnId: target.id,
      key: appendKey(tail?.key ?? null),
      clock: bumpClock(card.clock, me.value),
    }),
  );
}

function columnIndexOf(card: PeerBoardCard): number {
  return columns.value.findIndex((c) => c.id === card.columnId);
}

// ── column editing ────────────────────────────────────────────────────────────

const addingColumn = ref(false);
const newColumnTitle = ref("");
const renamingId = ref("");
const renameTitle = ref("");
const deleteTarget = ref<PeerBoardColumn | null>(null);

/** Where the doomed column's cards would land — named in the confirm, because
 *  deleting a column never deletes the cards in it. */
const deleteFallbackTitle = computed(
  () => columns.value.find((c) => c.id !== deleteTarget.value?.id)?.title ?? "",
);

/** Every column change is one clocked document: bump `columnsClock`, not any
 *  per-card clock (cards keep their own history across a column edit). */
function withColumns(b: PeerBoard, cols: PeerBoardColumn[]): PeerBoard {
  return { ...b, columns: cols, columnsClock: bumpClock(b.columnsClock, me.value) };
}

async function submitAddColumn() {
  const b = board.value;
  const title = newColumnTitle.value.trim();
  if (!b || !canEdit.value || !title || atColumnCap.value) return;
  const tail = last(columns.value);
  addingColumn.value = false;
  newColumnTitle.value = "";
  await commit(
    withColumns(b, [
      ...b.columns,
      {
        id: crypto.randomUUID(),
        title: title.slice(0, PEER_TITLE_MAX_LEN),
        key: appendKey(tail?.key ?? null),
      },
    ]),
  );
}

function startRename(col: PeerBoardColumn) {
  renamingId.value = col.id;
  renameTitle.value = col.title;
}

async function submitRename() {
  const b = board.value;
  const title = renameTitle.value.trim();
  const id = renamingId.value;
  if (!b || !canEdit.value || !title) return;
  renamingId.value = "";
  await commit(
    withColumns(
      b,
      b.columns.map((c) => (c.id === id ? { ...c, title: title.slice(0, PEER_TITLE_MAX_LEN) } : c)),
    ),
  );
}

/** Delete a column. Its live cards move to the first remaining column — each one
 *  a real card edit, so each gets its own clock bump — or are tombstoned when
 *  there is no column left to hold them. Nothing is ever dropped silently. */
async function confirmDeleteColumn() {
  const b = board.value;
  const col = deleteTarget.value;
  deleteTarget.value = null;
  if (!b || !col || !canEdit.value) return;
  const remaining = columns.value.filter((c) => c.id !== col.id);
  const fallback = remaining[0] ?? null;
  let prevKey = fallback ? (last(cardsIn(fallback.id))?.key ?? null) : null;
  const cards = b.cards.map((c) => {
    if (c.columnId !== col.id || c.deleted) return c;
    if (!fallback) return { ...c, deleted: true, clock: bumpClock(c.clock, me.value) };
    prevKey = appendKey(prevKey);
    return { ...c, columnId: fallback.id, key: prevKey, clock: bumpClock(c.clock, me.value) };
  });
  await commit(withColumns({ ...b, cards }, remaining));
}
</script>

<template>
  <OyaCard :padded="true" class="flex max-h-[85vh] w-full max-w-5xl flex-col gap-3 overflow-hidden">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="flex items-center gap-2 text-sm font-semibold">
          <font-awesome-icon icon="table-columns" class="opacity-70" />
          {{ $t('peers.boardTitle', { name: peerLabel }) }}
        </p>
        <p class="mt-1 text-xs opacity-65">{{ $t('peers.boardHint') }}</p>
      </div>
      <OyaButton variant="secondary" @click="emit('close')">{{ $t('peers.boardClose') }}</OyaButton>
    </div>

    <!-- Honesty about where an edit actually goes. Never silent. -->
    <p
      v-if="localOnly"
      class="rounded-lg border border-current/20 px-3 py-2 text-xs opacity-80"
    >
      <font-awesome-icon icon="link-slash" class="mr-1.5" />{{ $t('peers.boardLocalOnly') }}
    </p>
    <p
      v-else-if="!iShareBoard"
      class="rounded-lg border border-warn-dark/40 px-3 py-2 text-xs text-warn-dark"
    >
      {{ $t('peers.boardNotShared') }}
    </p>
    <p
      v-if="!me"
      class="rounded-lg border border-warn-dark/40 px-3 py-2 text-xs text-warn-dark"
    >
      {{ $t('peers.boardNoIdentity') }}
    </p>

    <div class="flex flex-1 gap-3 overflow-x-auto overflow-y-auto pb-2">
      <section
        v-for="(col, i) in columns"
        :key="col.id"
        class="flex w-72 shrink-0 flex-col rounded-xl border border-accent-2 bg-bubble-bg-light/40 dark:border-accent-1 dark:bg-bubble-bg-dark/40"
      >
        <header class="flex items-center gap-2 px-3 py-2.5">
          <template v-if="renamingId === col.id">
            <OyaTextField
              v-model="renameTitle"
              size="sm"
              :maxlength="PEER_TITLE_MAX_LEN"
              @enter="submitRename"
            />
            <button
              type="button"
              class="rounded p-1 text-xs hover:bg-accent-2/40 dark:hover:bg-accent-1/40"
              :title="$t('peers.boardSave')"
              @click="submitRename"
            >
              <font-awesome-icon icon="check" />
            </button>
          </template>
          <template v-else>
            <h3 class="min-w-0 flex-1 truncate text-sm font-bold">{{ col.title }}</h3>
            <span
              class="rounded-full bg-accent-2/50 px-2 py-0.5 text-xs font-semibold opacity-70 dark:bg-accent-1/50"
            >{{ cardsIn(col.id).length }}</span>
            <div v-if="canEdit" class="flex items-center gap-0.5">
              <button
                type="button"
                class="rounded p-1 text-xs hover:bg-accent-2/40 dark:hover:bg-accent-1/40"
                :title="$t('peers.boardRenameColumn')"
                @click="startRename(col)"
              >
                <font-awesome-icon icon="pencil" />
              </button>
              <button
                type="button"
                class="rounded p-1 text-xs text-warn-dark hover:bg-warn-dark/10"
                :title="$t('peers.boardDeleteColumn')"
                @click="deleteTarget = col"
              >
                <font-awesome-icon icon="trash" />
              </button>
            </div>
          </template>
        </header>

        <div class="flex min-h-[3rem] flex-1 flex-col gap-2 px-2 pb-2">
          <article
            v-for="c in cardsIn(col.id)"
            :key="c.id"
            :data-card-id="c.id"
            class="rounded-lg border border-accent-2 bg-primary-bg-light px-2.5 py-2 text-xs dark:border-accent-1 dark:bg-primary-bg-dark"
          >
            <template v-if="editingId === c.id">
              <OyaTextField
                v-model="draftTitle"
                size="sm"
                :maxlength="PEER_TITLE_MAX_LEN"
                :placeholder="$t('peers.boardCardTitle')"
                @enter="submitEdit"
              />
              <OyaTextArea
                v-model="draftDescription"
                class="mt-1.5"
                :rows="2"
                :placeholder="$t('peers.boardCardDescription')"
              />
              <label class="mt-1.5 flex cursor-pointer items-center gap-2">
                <input v-model="draftDone" type="checkbox" class="h-3.5 w-3.5 accent-current" />
                <span>{{ $t('peers.boardDone') }}</span>
              </label>
              <p v-if="draftError" class="mt-1 text-warn-dark">{{ $t(draftError) }}</p>
              <div class="mt-2 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  class="rounded px-2 py-1 text-warn-dark hover:bg-warn-dark/10"
                  @click="deleteCard(c)"
                >
                  {{ $t('peers.boardDeleteCard') }}
                </button>
                <button
                  type="button"
                  class="rounded px-2 py-1 opacity-70 hover:opacity-100"
                  @click="resetDraft"
                >
                  {{ $t('peers.boardCancel') }}
                </button>
                <button
                  type="button"
                  class="rounded bg-accent-light px-2 py-1 font-semibold text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark"
                  @click="submitEdit"
                >
                  {{ $t('peers.boardSave') }}
                </button>
              </div>
            </template>
            <template v-else>
              <p
                class="font-semibold"
                :class="c.done ? 'line-through opacity-50' : ''"
              >{{ c.title }}</p>
              <p v-if="c.description" class="mt-1 whitespace-pre-wrap opacity-70">
                {{ c.description }}
              </p>
              <div class="mt-1.5 flex items-center gap-1">
                <span v-if="c.author" class="min-w-0 flex-1 truncate opacity-50">
                  {{ $t('peers.boardBy', { name: c.author }) }}
                </span>
                <span v-else class="flex-1" />
                <template v-if="canEdit">
                  <button
                    type="button"
                    :disabled="columnIndexOf(c) <= 0"
                    class="rounded p-1 hover:bg-accent-2/40 disabled:opacity-20 dark:hover:bg-accent-1/40"
                    :title="$t('peers.boardMoveLeft')"
                    @click="moveCard(c, -1)"
                  >
                    <font-awesome-icon icon="arrow-left" />
                  </button>
                  <button
                    type="button"
                    :disabled="i === columns.length - 1"
                    class="rounded p-1 hover:bg-accent-2/40 disabled:opacity-20 dark:hover:bg-accent-1/40"
                    :title="$t('peers.boardMoveRight')"
                    @click="moveCard(c, 1)"
                  >
                    <font-awesome-icon icon="arrow-right" />
                  </button>
                  <button
                    type="button"
                    class="rounded p-1 hover:bg-accent-2/40 dark:hover:bg-accent-1/40"
                    :title="$t('peers.boardEditCard')"
                    @click="startEdit(c)"
                  >
                    <font-awesome-icon icon="pencil" />
                  </button>
                </template>
              </div>
            </template>
          </article>

          <p v-if="!cardsIn(col.id).length" class="px-1 py-2 text-xs opacity-40">
            {{ $t('peers.boardNoCards') }}
          </p>

          <div
            v-if="addingIn === col.id"
            class="rounded-lg border border-accent-2 px-2.5 py-2 text-xs dark:border-accent-1"
          >
            <OyaTextField
              v-model="draftTitle"
              size="sm"
              :maxlength="PEER_TITLE_MAX_LEN"
              :placeholder="$t('peers.boardCardTitle')"
              @enter="submitAdd"
            />
            <OyaTextArea
              v-model="draftDescription"
              class="mt-1.5"
              :rows="2"
              :placeholder="$t('peers.boardCardDescription')"
            />
            <p v-if="draftError" class="mt-1 text-warn-dark">{{ $t(draftError) }}</p>
            <div class="mt-2 flex items-center justify-end gap-1.5">
              <button
                type="button"
                class="rounded px-2 py-1 opacity-70 hover:opacity-100"
                @click="resetDraft"
              >
                {{ $t('peers.boardCancel') }}
              </button>
              <button
                type="button"
                class="rounded bg-accent-light px-2 py-1 font-semibold text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark"
                @click="submitAdd"
              >
                {{ $t('peers.boardAdd') }}
              </button>
            </div>
          </div>
        </div>

        <button
          v-if="canEdit && addingIn !== col.id"
          type="button"
          class="m-2 mt-0 flex items-center justify-center gap-2 rounded-lg border border-dashed border-accent-2 px-3 py-2 text-xs font-semibold opacity-70 transition hover:opacity-100 disabled:opacity-30 dark:border-accent-1"
          :disabled="atCardCap"
          @click="startAdd(col.id)"
        >
          <font-awesome-icon icon="plus" />
          {{ $t('peers.boardAddCard') }}
        </button>
      </section>

      <!-- Cards whose column the peer deleted: visible, and one move away from home -->
      <section
        v-if="orphanCards.length"
        class="flex w-72 shrink-0 flex-col rounded-xl border border-dashed border-warn-dark/50"
      >
        <header class="px-3 py-2.5">
          <h3 class="truncate text-sm font-bold">{{ $t('peers.boardOrphans') }}</h3>
          <p class="mt-0.5 text-[11px] opacity-60">{{ $t('peers.boardOrphansHint') }}</p>
        </header>
        <div class="flex flex-1 flex-col gap-2 px-2 pb-2">
          <article
            v-for="c in orphanCards"
            :key="c.id"
            class="rounded-lg border border-accent-2 bg-primary-bg-light px-2.5 py-2 text-xs dark:border-accent-1 dark:bg-primary-bg-dark"
          >
            <p class="font-semibold">{{ c.title }}</p>
            <div class="mt-1.5 flex justify-end gap-1">
              <button
                v-if="canEdit && columns.length"
                type="button"
                class="rounded p-1 hover:bg-accent-2/40 dark:hover:bg-accent-1/40"
                :title="$t('peers.boardMoveRight')"
                @click="moveCard(c, 1)"
              >
                <font-awesome-icon icon="arrow-right" />
              </button>
              <button
                v-if="canEdit"
                type="button"
                class="rounded p-1 text-warn-dark hover:bg-warn-dark/10"
                :title="$t('peers.boardDeleteCard')"
                @click="deleteCard(c)"
              >
                <font-awesome-icon icon="trash" />
              </button>
            </div>
          </article>
        </div>
      </section>

      <div v-if="canEdit" class="w-72 shrink-0">
        <div
          v-if="addingColumn"
          class="flex items-center gap-2 rounded-xl border border-dashed border-accent-2 px-3 py-3 dark:border-accent-1"
        >
          <OyaTextField
            v-model="newColumnTitle"
            size="sm"
            :maxlength="PEER_TITLE_MAX_LEN"
            :placeholder="$t('peers.boardColumnName')"
            @enter="submitAddColumn"
          />
          <button
            type="button"
            class="rounded p-1 text-xs hover:bg-accent-2/40 dark:hover:bg-accent-1/40"
            :title="$t('peers.boardSave')"
            @click="submitAddColumn"
          >
            <font-awesome-icon icon="check" />
          </button>
        </div>
        <button
          v-else
          type="button"
          class="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-accent-2 px-3 py-3 text-sm font-semibold opacity-70 transition hover:opacity-100 disabled:opacity-30 dark:border-accent-1"
          :disabled="atColumnCap"
          @click="addingColumn = true"
        >
          <font-awesome-icon icon="plus" />
          {{ $t('peers.boardAddColumn') }}
        </button>
      </div>
    </div>

    <!-- Column delete says where the cards go, because they are not deleted with it -->
    <OyaModal :open="!!deleteTarget" @close="deleteTarget = null">
      <OyaCard v-if="deleteTarget" :padded="true" class="w-full max-w-md space-y-3 text-sm">
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ $t('peers.boardDeleteColumnTitle', { name: deleteTarget.title }) }}
        </p>
        <p>
          {{
            deleteFallbackTitle
              ? $t('peers.boardDeleteColumnMoves', { name: deleteFallbackTitle })
              : $t('peers.boardDeleteColumnLast')
          }}
        </p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="deleteTarget = null">
            {{ $t('peers.boardCancel') }}
          </OyaButton>
          <OyaButton @click="confirmDeleteColumn">
            <font-awesome-icon icon="trash" />{{ $t('peers.boardDeleteColumn') }}
          </OyaButton>
        </div>
      </OyaCard>
    </OyaModal>
  </OyaCard>
</template>
