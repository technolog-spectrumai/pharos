<script setup lang="ts">
// Create/edit card form. Title, description, assignee (from the room roster),
// due date and a colour label. Mirrors MeetingFormModal.
import { computed, ref, watch } from "vue";
import { OyaButton, OyaModal, OyaTextArea, OyaTextField } from "rakotis";
import type { Participant } from "rakotis";
import { CARD_COLORS, validateCardDraft, type Card, type CardDraft } from "./kanbanModel";

const props = defineProps<{
  open: boolean;
  card?: Card | null; // set = edit mode
  roster: Participant[];
  maxTitle: number;
  maxDesc: number;
}>();
const emit = defineEmits<{ "update:open": [boolean]; save: [draft: CardDraft] }>();

const title = ref("");
const description = ref("");
const assignee = ref("");
const dueStr = ref("");
const color = ref<string>(CARD_COLORS[0]);
const errorKey = ref<string | null>(null);

const isEdit = computed(() => !!props.card);
const assignable = computed(() => props.roster.filter((p) => p.type === "human" && p.id));

const COLOR_CLASS: Record<string, string> = {
  slate: "bg-slate-400",
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
};

function toDateStr(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    errorKey.value = null;
    const c = props.card;
    title.value = c?.title ?? "";
    description.value = c?.description ?? "";
    assignee.value = c?.assignee ?? "";
    dueStr.value = toDateStr(c?.dueDate ?? null);
    color.value = c?.color && CARD_COLORS.includes(c.color as never) ? c.color : CARD_COLORS[0];
  },
);

function submit() {
  const draft: CardDraft = {
    title: title.value,
    description: description.value,
    assignee: assignee.value,
    dueDate: dueStr.value ? new Date(`${dueStr.value}T00:00`).getTime() : null,
    color: color.value,
  };
  const err = validateCardDraft(draft, props.maxTitle, props.maxDesc);
  if (err) {
    errorKey.value = err;
    return;
  }
  emit("save", draft);
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="emit('update:open', false)">
    <form
      class="w-full max-w-md space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      @submit.prevent="submit"
    >
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="table-columns" />
        {{ isEdit ? $t('kanban.editCard') : $t('kanban.newCard') }}
      </p>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('kanban.titleField') }}</label>
        <OyaTextField v-model="title" :placeholder="$t('kanban.titlePlaceholder')" :maxlength="maxTitle" />
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('kanban.description') }}</label>
        <OyaTextArea v-model="description" :rows="3" />
      </div>

      <div class="grid grid-cols-2 gap-2">
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('kanban.assignee') }}</label>
          <select v-model="assignee" class="native-field">
            <option value="">{{ $t('kanban.unassigned') }}</option>
            <option v-for="p in assignable" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('kanban.dueDate') }}</label>
          <input v-model="dueStr" type="date" class="native-field" />
        </div>
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('kanban.label') }}</label>
        <div class="flex items-center gap-2">
          <button
            v-for="col in CARD_COLORS"
            :key="col"
            type="button"
            :class="[COLOR_CLASS[col], color === col ? 'ring-2 ring-offset-2 ring-accent-dark ring-offset-primary-bg-light dark:ring-offset-primary-bg-dark' : '']"
            class="h-6 w-6 rounded-full transition"
            :title="col"
            @click="color = col"
          />
        </div>
      </div>

      <p v-if="errorKey" class="text-sm text-warn-dark">{{ $t(`kanban.${errorKey}`) }}</p>

      <div class="flex justify-end gap-2 pt-1">
        <OyaButton variant="secondary" type="button" @click="emit('update:open', false)">
          {{ $t('kanban.cancel') }}
        </OyaButton>
        <OyaButton type="submit">
          <font-awesome-icon icon="check" />
          {{ $t('kanban.save') }}
        </OyaButton>
      </div>
    </form>
  </OyaModal>
</template>

<style scoped>
/* Native date/select fields, matching OyaTextField + MeetingFormModal. */
.native-field {
  width: 100%;
  border-radius: 0.5rem;
  border: 1px solid var(--color-accent-2);
  background: transparent;
  padding: 0.4rem 0.6rem;
  font-size: 0.875rem;
  outline: none;
  color: var(--color-text-main-light);
  color-scheme: light;
}
select.native-field,
select.native-field option {
  background: var(--color-primary-bg-light);
  color: var(--color-text-main-light);
}
:global(.dark) .native-field {
  border-color: var(--color-accent-1);
  color: var(--color-text-main-dark);
  color-scheme: dark;
}
:global(.dark) select.native-field,
:global(.dark) select.native-field option {
  background: var(--color-primary-bg-dark);
  color: var(--color-text-main-dark);
}
</style>
