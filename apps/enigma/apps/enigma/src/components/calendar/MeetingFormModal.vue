<script setup lang="ts">
// Create/edit meeting form. Native date + time inputs (single-day meetings in
// v1 — the model itself supports cross-midnight ranges). The room picker
// chooses whose members get invited; it is fixed once a meeting exists.
import { computed, ref, watch } from "vue";
import { OyaButton, OyaModal, OyaTextArea, OyaTextField } from "rakotis";
import type { P2pRoomEntry } from "rakotis";
import { dayKey, validateMeetingDraft, type Meeting, type MeetingDraft } from "./meetingModel";

const props = defineProps<{
  open: boolean;
  meeting?: Meeting | null; // set = edit mode
  rooms: P2pRoomEntry[];
  currentRoomSlug?: string;
}>();
const emit = defineEmits<{ "update:open": [boolean]; save: [draft: MeetingDraft] }>();

const title = ref("");
const description = ref("");
const location = ref("");
const dateStr = ref("");
const startStr = ref("");
const endStr = ref("");
const roomSlug = ref("");
const errorKey = ref<string | null>(null);

const isEdit = computed(() => !!props.meeting);

function toTimeStr(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5); // local "HH:MM"
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    errorKey.value = null;
    const m = props.meeting;
    if (m) {
      title.value = m.title;
      description.value = m.description;
      location.value = m.location;
      dateStr.value = dayKey(m.start);
      startStr.value = toTimeStr(m.start);
      endStr.value = toTimeStr(m.end);
      roomSlug.value = m.roomSlug;
    } else {
      title.value = "";
      description.value = "";
      location.value = "";
      const next = new Date(Date.now() + 3_600_000); // default: the next full hour
      next.setMinutes(0, 0, 0);
      dateStr.value = dayKey(next);
      startStr.value = toTimeStr(next.getTime());
      endStr.value = toTimeStr(next.getTime() + 3_600_000);
      roomSlug.value = props.currentRoomSlug ?? "";
    }
  },
);

const roomName = computed(() => props.rooms.find((r) => r.room === roomSlug.value)?.name ?? "");

function parseLocal(date: string, time: string): number {
  return date && time ? new Date(`${date}T${time}`).getTime() : NaN;
}

function submit() {
  const draft: MeetingDraft = {
    title: title.value,
    description: description.value,
    location: location.value,
    start: parseLocal(dateStr.value, startStr.value),
    end: parseLocal(dateStr.value, endStr.value),
    roomSlug: roomSlug.value,
    roomName: roomName.value,
  };
  const err = validateMeetingDraft(draft);
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
        <font-awesome-icon icon="calendar-plus" />
        {{ isEdit ? $t('calendar.editMeeting') : $t('calendar.newMeeting') }}
      </p>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.titleField') }}</label>
        <OyaTextField v-model="title" :placeholder="$t('calendar.titlePlaceholder')" :maxlength="200" />
      </div>

      <div class="grid grid-cols-3 gap-2">
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.date') }}</label>
          <input v-model="dateStr" type="date" class="native-field" />
        </div>
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.startTime') }}</label>
          <input v-model="startStr" type="time" class="native-field" />
        </div>
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.endTime') }}</label>
          <input v-model="endStr" type="time" class="native-field" />
        </div>
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.location') }}</label>
        <OyaTextField v-model="location" :maxlength="200" />
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.description') }}</label>
        <OyaTextArea v-model="description" :rows="3" />
      </div>

      <div class="space-y-1">
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('calendar.room') }}</label>
        <select v-model="roomSlug" :disabled="isEdit" class="native-field">
          <option value="">{{ $t('calendar.noRoom') }}</option>
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
/* Native date/time/select fields, matching OyaTextField. The pickers follow the
   active theme via color-scheme (the .dark class rides <html>). */
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
