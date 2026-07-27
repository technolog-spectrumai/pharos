<script setup lang="ts">
// One board column: header (+ admin controls when captain), its ordered cards,
// an "Add card" button, and the native drop zone. Drop position is derived from
// the pointer's Y against the card elements — no DnD library.
import { computed } from "vue";
import type { Participant } from "rakotis";
import { last, type Card, type Column } from "./kanbanModel";
import type { Kanban } from "./useKanban";
import KanbanCard from "./KanbanCard.vue";
import { draggingCardId } from "./dragState";

const props = defineProps<{
  column: Column;
  kanban: Kanban;
  roster: Participant[];
  isFirst: boolean;
  isLast: boolean;
}>();
const emit = defineEmits<{
  "add-card": [string];
  rename: [Column];
  "delete-column": [Column];
  "edit-card": [Card];
  "delete-card": [Card];
}>();

const cards = computed(() => props.kanban.cardsInColumn(props.column.id));
const amCaptain = props.kanban.amCaptain;

function onDrop(e: DragEvent) {
  const draggedId = draggingCardId.value;
  draggingCardId.value = null;
  if (!draggedId) return;
  const dragged = props.kanban.cards.value.find((c) => c.id === draggedId);
  if (!dragged) return;

  const list = cards.value.filter((c) => c.id !== draggedId);

  if (!props.kanban.allowReorder) {
    // No within-column reorder: accept cross-column moves only (append to end).
    if (dragged.columnId === props.column.id) return;
    props.kanban.moveCard(draggedId, props.column.id, last(list)?.orderKey ?? null, null);
    return;
  }

  // Reorder allowed: find the insertion index from the pointer against the
  // rendered cards (excluding the dragged one, whose DOM node stays until drop).
  const container = e.currentTarget as HTMLElement;
  const cardEls = Array.from(container.querySelectorAll<HTMLElement>("[data-card-id]")).filter(
    (el) => el.dataset.cardId !== draggedId,
  );
  let insertIdx = cardEls.length;
  for (let i = 0; i < cardEls.length; i++) {
    const rect = cardEls[i].getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      insertIdx = i;
      break;
    }
  }
  const beforeKey = list[insertIdx - 1]?.orderKey ?? null;
  const afterKey = list[insertIdx]?.orderKey ?? null;
  props.kanban.moveCard(draggedId, props.column.id, beforeKey, afterKey);
}
</script>

<template>
  <section
    class="flex w-72 shrink-0 flex-col rounded-xl border border-accent-2 bg-bubble-bg-light/40 dark:border-accent-1 dark:bg-bubble-bg-dark/40"
    @dragover.prevent
    @drop="onDrop"
  >
    <header class="flex items-center gap-2 px-3 py-2.5">
      <h3 class="min-w-0 flex-1 truncate text-sm font-bold">{{ column.title }}</h3>
      <span class="rounded-full bg-accent-2/50 px-2 py-0.5 text-xs font-semibold opacity-70 dark:bg-accent-1/50">
        {{ cards.length }}
      </span>
      <div v-if="amCaptain" class="flex items-center gap-0.5">
        <button
          type="button"
          :disabled="isFirst"
          class="rounded p-1 text-xs hover:bg-accent-2/40 disabled:opacity-20 dark:hover:bg-accent-1/40"
          :title="$t('kanban.moveLeft')"
          @click="kanban.moveColumn(column.id, -1)"
        >
          <font-awesome-icon icon="arrow-left" />
        </button>
        <button
          type="button"
          :disabled="isLast"
          class="rounded p-1 text-xs hover:bg-accent-2/40 disabled:opacity-20 dark:hover:bg-accent-1/40"
          :title="$t('kanban.moveRight')"
          @click="kanban.moveColumn(column.id, 1)"
        >
          <font-awesome-icon icon="arrow-right" />
        </button>
        <button
          type="button"
          class="rounded p-1 text-xs hover:bg-accent-2/40 dark:hover:bg-accent-1/40"
          :title="$t('kanban.renameColumn')"
          @click="emit('rename', column)"
        >
          <font-awesome-icon icon="pencil" />
        </button>
        <button
          type="button"
          class="rounded p-1 text-xs text-warn-dark hover:bg-warn-dark/10"
          :title="$t('kanban.deleteColumn')"
          @click="emit('delete-column', column)"
        >
          <font-awesome-icon icon="trash" />
        </button>
      </div>
    </header>

    <div class="flex min-h-[3rem] flex-1 flex-col gap-2 px-2 pb-2">
      <KanbanCard
        v-for="c in cards"
        :key="c.id"
        :card="c"
        :kanban="kanban"
        :roster="roster"
        :can-demote="!isFirst"
        :can-promote="!isLast"
        @edit="emit('edit-card', $event)"
        @delete="emit('delete-card', $event)"
      />
      <p v-if="!cards.length" class="px-1 py-2 text-xs opacity-40">{{ $t('kanban.noCards') }}</p>
    </div>

    <button
      type="button"
      class="m-2 mt-0 flex items-center justify-center gap-2 rounded-lg border border-dashed border-accent-2 px-3 py-2 text-xs font-semibold opacity-70 transition hover:opacity-100 dark:border-accent-1"
      @click="emit('add-card', column.id)"
    >
      <font-awesome-icon icon="plus" />
      {{ $t('kanban.addCard') }}
    </button>
  </section>
</template>
