<script setup lang="ts">
// Doodle-poll creation form: title + a builder for 2+ proposed time slots
// (date, start, end each), an optional voting deadline, and the room whose
// members vote. Create-only — slots can't be edited afterwards (cancel and
// recreate instead).
import { computed, ref, watch } from "vue";
import { OyaButton, OyaModal, OyaTextArea, OyaTextField } from "rakotis";
import type { P2pRoomEntry } from "rakotis";
import { dayKey, validatePollDraft, type PollDraft } from "./meetingModel";

const props = defineProps<{
  open: boolean;
  rooms: P2pRoomEntry[];
  currentRoomSlug?: string;
}>();
const emit = defineEmits<{ "update:open": [boolean]; save: [draft: PollDraft] }>();

interface SlotRow {
  dateStr: string;
  startStr: string;
  endStr: string;
}

const title = ref("");
const description = ref("");
const location = ref("");
const slotRows = ref<SlotRow[]>([]);
const deadlineStr = ref(""); // datetime-local, optional
const roomSlug = ref("");
const errorKey = ref<string | null>(null);

function toTimeStr(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5); // local "HH:MM"
}

function defaultRow(daysAhead: number): SlotRow {
  const next = new Date(Date.now() + 24 * 3_600_000 * daysAhead);
  next.setMinutes(0, 0, 0);
  return {
    dateStr: dayKey(next),
    startStr: toTimeStr(next.getTime()),
    endStr: toTimeStr(next.getTime() + 3_600_000),
  };
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    errorKey.value = null;
    title.value = "";
    description.value = "";
    location.value = "";
    slotRows.value = [defaultRow(1), defaultRow(2)];
    deadlineStr.value = "";
    roomSlug.value = props.currentRoomSlug || props.rooms[0]?.room || "";
  },
);

function addSlot() {
  slotRows.value = [...slotRows.value, defaultRow(slotRows.value.length + 1)];
}
function removeSlot(i: number) {
  if (slotRows.value.length <= 2) return;
  slotRows.value = slotRows.value.filter((_, idx) => idx !== i);
}

const roomName = computed(() => props.rooms.find((r) => r.room === roomSlug.value)?.name ?? "");

function parseLocal(date: string, time: string): number {
  return date && time ? new Date(`${date}T${time}`).getTime() : NaN;
}

function submit() {
  const draft: PollDraft = {
    title: title.value,
    description: description.value,
    location: location.value,
    slots: slotRows.value.map((r) => ({
      start: parseLocal(r.dateStr, r.startStr),
      end: parseLocal(r.dateStr, r.endStr),
    })),
    roomSlug: roomSlug.value,
    roomName: roomName.value,
    deadline: deadlineStr.value ? new Date(deadlineStr.value).getTime() : undefined,
  };
  const err = validatePollDraft(draft);
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
      class="max-h-[85vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      @submit.prevent="submit"
    >
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="list-check" />
        {{ $t('calendar.newPoll') }}
      </p>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.titleField') }}</label>
        <OyaTextField v-model="title" :placeholder="$t('calendar.titlePlaceholder')" :maxlength="200" />
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.pollSlots') }}</label>
        <div v-for="(row, i) in slotRows" :key="i" class="flex items-center gap-2">
          <input v-model="row.dateStr" type="date" class="native-field flex-1" />
          <input v-model="row.startStr" type="time" class="native-field w-24" />
          <input v-model="row.endStr" type="time" class="native-field w-24" />
          <button
            v-if="slotRows.length > 2"
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent-2 opacity-60 transition hover:opacity-100 dark:border-accent-1"
            :title="$t('calendar.removeSlot')"
            @click="removeSlot(i)"
          >
            <font-awesome-icon icon="xmark" class="text-xs" />
          </button>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-accent-2 px-3 py-1.5 text-xs font-semibold transition hover:opacity-70 dark:border-accent-1"
          @click="addSlot()"
        >
          <font-awesome-icon icon="plus" />{{ $t('calendar.addSlot') }}
        </button>
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.deadlineField') }}</label>
        <input v-model="deadlineStr" type="datetime-local" class="native-field" />
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.location') }}</label>
        <OyaTextField v-model="location" :maxlength="200" />
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.description') }}</label>
        <OyaTextArea v-model="description" :rows="2" />
      </div>

      <!-- Polls need peers to vote — no "local only" option here. -->
      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.room') }}</label>
        <select v-model="roomSlug" class="native-field">
          <option v-for="r in rooms" :key="r.room" :value="r.room">{{ r.name }}</option>
        </select>
      </div>

      <p v-if="errorKey" class="text-sm text-warn-dark">{{ $t(`calendar.${errorKey}`) }}</p>

      <div class="flex justify-end gap-2 pt-1">
        <OyaButton variant="secondary" type="button" @click="emit('update:open', false)">
          {{ $t('calendar.cancel') }}
        </OyaButton>
        <OyaButton type="submit">
          <font-awesome-icon icon="check" />
          {{ $t('calendar.save') }}
        </OyaButton>
      </div>
    </form>
  </OyaModal>
</template>

<style scoped>
/* Native date/time/select fields, matching OyaTextField (same block as
   MeetingFormModal). Pickers follow the theme via color-scheme. */
.native-field {
  width: 100%;
  border-radius: 0.5rem;
  border: 1px solid var(--color-accent-2);
  background: transparent;
  padding: 0.4rem 0.6rem;
  font-size: 0.875rem;
  outline: none;
  color-scheme: light;
}
:global(.dark) .native-field {
  border-color: var(--color-accent-1);
  color-scheme: dark;
}
.native-field:disabled {
  opacity: 0.4;
}
</style>
