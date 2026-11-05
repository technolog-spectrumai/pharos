<script setup lang="ts">
// A single draggable card. Shows title, colour strip, assignee and due date;
// exposes edit/delete + promote/demote (move to adjacent column). Drag is native
// HTML5 (the drop logic lives in KanbanColumn); this only marks the drag source.
import { computed } from "vue";
import { OyaAvatar } from "rakotis";
import type { Participant } from "rakotis";
import type { Card } from "./kanbanModel";
import type { Kanban } from "./useKanban";
import { draggingCardId } from "./dragState";

const props = defineProps<{
  card: Card;
  kanban: Kanban;
  roster: Participant[];
  canDemote: boolean;
  canPromote: boolean;
}>();
const emit = defineEmits<{ edit: [Card]; delete: [Card] }>();

// Categorical label colours (a legitimate exception to the semantic-token rule).
// Literals kept whole so Tailwind's scanner keeps the classes.
const COLOR_CLASS: Record<string, string> = {
  slate: "bg-slate-400",
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
};
const colorClass = computed(() => COLOR_CLASS[props.card.color] ?? COLOR_CLASS.slate);

const assignee = computed(() => props.roster.find((p) => p.id === props.card.assignee) ?? null);

const due = computed(() => {
  if (props.card.dueDate == null) return null;
  const label = new Date(props.card.dueDate).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
  return { label, overdue: props.card.dueDate < Date.now() };
});

function onDragStart(e: DragEvent) {
  draggingCardId.value = props.card.id;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragEnd() {
  draggingCardId.value = null;
}
</script>

<template>
  <article
    :data-card-id="card.id"
    draggable="true"
    class="group flex cursor-grab gap-2 rounded-lg border border-accent-2 bg-primary-bg-light p-2.5 shadow-sm transition hover:shadow active:cursor-grabbing dark:border-accent-1 dark:bg-primary-bg-dark"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
  >
    <span :class="colorClass" class="w-1 shrink-0 rounded-full" :title="card.color" />
    <div class="min-w-0 flex-1 space-y-1.5">
      <button type="button" class="block w-full text-left text-sm font-semibold leading-snug" @click="emit('edit', card)">
        {{ card.title }}
      </button>

      <div v-if="assignee || due" class="flex flex-wrap items-center gap-2">
        <span v-if="assignee" class="inline-flex items-center gap-1.5 text-xs opacity-80">
          <OyaAvatar :name="assignee.name" :src="assignee.avatar_url" size="sm" />
          <span class="max-w-[7rem] truncate">{{ assignee.name }}</span>
        </span>
        <span
          v-if="due"
          :class="due.overdue ? 'text-warn-dark' : 'opacity-70'"
          class="inline-flex items-center gap-1 text-xs font-semibold"
        >
          <font-awesome-icon icon="clock" />
          {{ due.overdue ? $t('kanban.overdue') : $t('kanban.due', { date: due.label }) }}
        </span>
      </div>

      <div class="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          :disabled="!canDemote"
          class="rounded p-1 text-xs hover:bg-accent-2/40 disabled:opacity-20 dark:hover:bg-accent-1/40"
          :title="$t('kanban.demote')"
          @click="kanban.demoteCard(card.id)"
        >
          <font-awesome-icon icon="arrow-left" />
        </button>
        <button
          type="button"
          :disabled="!canPromote"
          class="rounded p-1 text-xs hover:bg-accent-2/40 disabled:opacity-20 dark:hover:bg-accent-1/40"
          :title="$t('kanban.promote')"
          @click="kanban.promoteCard(card.id)"
        >
          <font-awesome-icon icon="arrow-right" />
        </button>
        <span class="flex-1" />
        <button
          type="button"
          class="rounded p-1 text-xs hover:bg-accent-2/40 dark:hover:bg-accent-1/40"
          :title="$t('kanban.editCard')"
          @click="emit('edit', card)"
        >
          <font-awesome-icon icon="pencil" />
        </button>
        <button
          type="button"
          class="rounded p-1 text-xs text-warn-dark hover:bg-warn-dark/10"
          :title="$t('kanban.deleteCard')"
          @click="emit('delete', card)"
        >
          <font-awesome-icon icon="trash" />
        </button>
      </div>
    </div>
  </article>
</template>
