<script setup lang="ts">
// Board tab: the currently-open room's shared Kanban board. All state lives in
// the app-wide kanban orchestrator (stores/chat.ts) — this view is its surface
// and owns the modals (card form, column add/rename, delete confirmations).
import { computed, onMounted, ref, watch } from "vue";
import { OyaButton, OyaEmptyState, OyaModal, OyaTextField } from "rakotis";
import { useChatStore } from "../stores/chat";
import KanbanBoard from "../components/kanban/KanbanBoard.vue";
import CardEditModal from "../components/kanban/CardEditModal.vue";
import type { Card, CardDraft, Column } from "../components/kanban/kanbanModel";

// darkMode is class-based (`.dark` on <html>); the prop only absorbs the
// fall-through attr App.vue passes to every routed view.
defineProps<{ darkMode?: boolean }>();

const chatStore = useChatStore();
// Guaranteed non-null here: the /board route's `beforeEnter` redirects to /chat
// unless the build flag is on, and a flag-off build never mounts this view.
const kanban = chatStore.kanban!;
const p2p = chatStore.p2p;

const roster = computed(() => p2p.participants.value);
const currentRoomSlug = computed(() => p2p.currentRoom.value?.slug ?? "");
const hasColumns = computed(() => kanban.columns.value.length > 0);

// ── card modal ──────────────────────────────────────────────────────────────
const formOpen = ref(false);
const editingCard = ref<Card | null>(null);
const createColumnId = ref("");

function openCreateCard(columnId: string) {
  editingCard.value = null;
  createColumnId.value = columnId;
  formOpen.value = true;
}
function openEditCard(card: Card) {
  editingCard.value = card;
  formOpen.value = true;
}
async function onSaveCard(draft: CardDraft) {
  if (editingCard.value) await kanban.updateCard(editingCard.value.id, draft);
  else await kanban.createCard(createColumnId.value, draft);
}

// ── column add/rename modal ─────────────────────────────────────────────────
const columnModalOpen = ref(false);
const columnEditing = ref<Column | null>(null);
const columnName = ref("");

function openAddColumn() {
  columnEditing.value = null;
  columnName.value = "";
  columnModalOpen.value = true;
}
function openRenameColumn(col: Column) {
  columnEditing.value = col;
  columnName.value = col.title;
  columnModalOpen.value = true;
}
async function saveColumn() {
  const name = columnName.value.trim();
  if (!name) return;
  if (columnEditing.value) await kanban.renameColumn(columnEditing.value.id, name);
  else await kanban.addColumn(name);
  columnModalOpen.value = false;
}

// ── delete confirmations ────────────────────────────────────────────────────
const deletingCard = ref<Card | null>(null);
const deletingColumn = ref<Column | null>(null);

async function confirmDeleteCard() {
  if (!deletingCard.value) return;
  await kanban.deleteCard(deletingCard.value.id);
  deletingCard.value = null;
}
async function confirmDeleteColumn() {
  if (!deletingColumn.value) return;
  await kanban.deleteColumn(deletingColumn.value.id);
  deletingColumn.value = null;
}

// ── attention dot: clear while the board is on screen ───────────────────────
onMounted(() => kanban.markSeen());
watch(
  () => kanban.attentionCount.value,
  (n) => {
    if (n > 0) kanban.markSeen();
  },
);
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-xl font-bold">{{ $t('kanban.title') }}</h1>
        <p class="text-sm opacity-60">{{ $t('kanban.subtitle') }}</p>
      </div>
      <span
        v-if="kanban.amCaptain.value && currentRoomSlug"
        class="inline-flex items-center gap-2 rounded-lg border border-accent-2 px-2.5 py-1.5 text-xs font-bold opacity-70 dark:border-accent-1"
        :title="$t('kanban.admin')"
      >
        <font-awesome-icon icon="star" />
        {{ $t('kanban.admin') }}
      </span>
    </div>

    <!-- No room open -->
    <div v-if="!currentRoomSlug" class="flex flex-1 items-center justify-center">
      <OyaEmptyState icon="table-columns" size="lg">{{ $t('kanban.noRoom') }}</OyaEmptyState>
    </div>

    <!-- Room open, empty board -->
    <div v-else-if="!hasColumns" class="flex flex-1 items-center justify-center">
      <OyaEmptyState icon="table-columns" size="lg">
        {{ kanban.amCaptain.value ? $t('kanban.emptyAdmin') : $t('kanban.emptyMember') }}
        <template v-if="kanban.amCaptain.value" #action>
          <OyaButton @click="kanban.seedDefaultColumns()">
            <font-awesome-icon icon="plus" />
            {{ $t('kanban.createBoard') }}
          </OyaButton>
        </template>
      </OyaEmptyState>
    </div>

    <!-- The board -->
    <KanbanBoard
      v-else
      :kanban="kanban"
      :roster="roster"
      @add-column="openAddColumn"
      @add-card="openCreateCard"
      @rename-column="openRenameColumn"
      @delete-column="(c) => (deletingColumn = c)"
      @edit-card="openEditCard"
      @delete-card="(c) => (deletingCard = c)"
    />

    <CardEditModal
      v-model:open="formOpen"
      :card="editingCard"
      :roster="roster"
      :max-title="kanban.maxTitle"
      :max-desc="kanban.maxDesc"
      @save="onSaveCard"
    />

    <!-- Add / rename column (captain) -->
    <OyaModal :open="columnModalOpen" @close="columnModalOpen = false">
      <form
        class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
        @submit.prevent="saveColumn"
      >
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="table-columns" />
          {{ columnEditing ? $t('kanban.renameColumn') : $t('kanban.addColumn') }}
        </p>
        <OyaTextField v-model="columnName" :placeholder="$t('kanban.columnName')" :maxlength="100" @enter="saveColumn" />
        <div class="flex justify-end gap-2 pt-1">
          <OyaButton variant="secondary" type="button" @click="columnModalOpen = false">
            {{ $t('kanban.cancel') }}
          </OyaButton>
          <OyaButton type="submit">
            <font-awesome-icon icon="check" />
            {{ $t('kanban.save') }}
          </OyaButton>
        </div>
      </form>
    </OyaModal>

    <!-- Delete card confirm -->
    <OyaModal :open="!!deletingCard" @close="deletingCard = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('kanban.deleteCard') }}
        </p>
        <p class="text-sm opacity-80">{{ $t('kanban.deleteCardConfirm', { title: deletingCard?.title ?? '' }) }}</p>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="deletingCard = null"
        >
          {{ $t('kanban.cancel') }}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border border-warn-dark/50 px-4 py-2 text-sm font-semibold text-warn-dark transition hover:bg-warn-dark/10"
          @click="confirmDeleteCard()"
        >
          <font-awesome-icon icon="trash" />
          {{ $t('kanban.delete') }}
        </button>
      </template>
    </OyaModal>

    <!-- Delete column confirm -->
    <OyaModal :open="!!deletingColumn" @close="deletingColumn = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('kanban.deleteColumn') }}
        </p>
        <p class="text-sm opacity-80">{{ $t('kanban.deleteColumnConfirm', { title: deletingColumn?.title ?? '' }) }}</p>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="deletingColumn = null"
        >
          {{ $t('kanban.cancel') }}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border border-warn-dark/50 px-4 py-2 text-sm font-semibold text-warn-dark transition hover:bg-warn-dark/10"
          @click="confirmDeleteColumn()"
        >
          <font-awesome-icon icon="trash" />
          {{ $t('kanban.delete') }}
        </button>
      </template>
    </OyaModal>
  </div>
</template>
