<script setup lang="ts">
// Horizontal, scrollable row of columns. Pure layout: it forwards card/column
// actions up to the view (which owns the modals) and reads everything else from
// the passed-in kanban orchestrator.
import type { Participant } from "rakotis";
import type { Card, Column } from "./kanbanModel";
import type { Kanban } from "./useKanban";
import KanbanColumn from "./KanbanColumn.vue";

const props = defineProps<{ kanban: Kanban; roster: Participant[] }>();
const emit = defineEmits<{
  "add-column": [];
  "add-card": [string];
  "rename-column": [Column];
  "delete-column": [Column];
  "edit-card": [Card];
  "delete-card": [Card];
}>();
</script>

<template>
  <div class="flex flex-1 gap-3 overflow-x-auto pb-2">
    <KanbanColumn
      v-for="(col, i) in props.kanban.columns.value"
      :key="col.id"
      :column="col"
      :kanban="props.kanban"
      :roster="roster"
      :is-first="i === 0"
      :is-last="i === props.kanban.columns.value.length - 1"
      @add-card="emit('add-card', $event)"
      @rename="emit('rename-column', $event)"
      @delete-column="emit('delete-column', $event)"
      @edit-card="emit('edit-card', $event)"
      @delete-card="emit('delete-card', $event)"
    />

    <button
      v-if="props.kanban.amCaptain.value"
      type="button"
      class="flex h-max w-72 shrink-0 items-center justify-center gap-2 rounded-xl border border-dashed border-accent-2 px-3 py-3 text-sm font-semibold opacity-70 transition hover:opacity-100 dark:border-accent-1"
      @click="emit('add-column')"
    >
      <font-awesome-icon icon="plus" />
      {{ $t('kanban.addColumn') }}
    </button>
  </div>
</template>
