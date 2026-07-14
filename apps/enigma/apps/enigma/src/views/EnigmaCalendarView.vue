<script setup lang="ts">
// Calendar tab: month grid + the selected day's meetings, create/edit form,
// RSVP and organizer actions. All state lives in the app-wide meetings
// orchestrator (stores/chat.ts) — this view is just its surface.
import { computed, ref } from "vue";
import { OyaButton, OyaModal } from "rakotis";
import { useChatStore } from "../stores/chat";
import CalendarPanel from "../components/calendar/CalendarPanel.vue";
import DayEventsPanel from "../components/calendar/DayEventsPanel.vue";
import MeetingFormModal from "../components/calendar/MeetingFormModal.vue";
import type { Meeting, MeetingDraft } from "../components/calendar/meetingModel";

// darkMode is class-based (`.dark` on <html>); the prop only absorbs the
// fall-through attr App.vue passes to every routed view.
defineProps<{ darkMode?: boolean }>();

const chatStore = useChatStore();
const meetings = chatStore.meetings;
const p2p = chatStore.p2p;

const selectedDay = ref(new Date());
const formOpen = ref(false);
const editing = ref<Meeting | null>(null);
const cancelling = ref<Meeting | null>(null);

const rooms = computed(() => p2p.p2pRooms.value);
const currentRoomSlug = computed(() => p2p.currentRoom.value?.slug ?? "");

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}
function openEdit(m: Meeting) {
  editing.value = m;
  formOpen.value = true;
}

async function onSave(draft: MeetingDraft) {
  if (editing.value) {
    await meetings.update(editing.value.id, draft);
    return;
  }
  await meetings.create(draft);
  // Inviting a room that isn't the open one: switch to it so the outbox can
  // flush once its MLS session is ready (same move as sending a room invite).
  if (draft.roomSlug && draft.roomSlug !== currentRoomSlug.value) {
    const entry = rooms.value.find((r) => r.room === draft.roomSlug);
    if (entry) void p2p.openP2pRoom(entry);
  }
}

async function confirmCancel() {
  if (!cancelling.value) return;
  await meetings.cancel(cancelling.value.id);
  cancelling.value = null;
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-xl font-bold">{{ $t('calendar.title') }}</h1>
        <p class="text-sm opacity-60">{{ $t('calendar.subtitle') }}</p>
      </div>
      <OyaButton @click="openCreate()">
        <font-awesome-icon icon="calendar-plus" />
        {{ $t('calendar.newMeeting') }}
      </OyaButton>
    </div>

    <div class="grid gap-3 lg:grid-cols-[3fr_2fr]">
      <CalendarPanel v-model="selectedDay" :meetings="meetings.meetings.value" />
      <DayEventsPanel
        :day="selectedDay"
        :meetings="meetings.meetings.value"
        @respond="(id, status) => meetings.respond(id, status)"
        @edit="openEdit"
        @cancel-meeting="(m) => (cancelling = m)"
        @remove="(id) => meetings.removeLocal(id)"
      />
    </div>

    <MeetingFormModal
      v-model:open="formOpen"
      :meeting="editing"
      :rooms="rooms"
      :current-room-slug="currentRoomSlug"
      @save="onSave"
    />

    <!-- Cancel confirmation — the cancellation is broadcast to the room. -->
    <OyaModal :open="!!cancelling" @close="cancelling = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('calendar.cancelMeeting') }}
        </p>
        <p class="text-sm opacity-80">
          {{ $t('calendar.cancelConfirm', { title: cancelling?.title ?? '' }) }}
        </p>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="cancelling = null"
        >
          {{ $t('calendar.cancel') }}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border border-warn-dark/50 px-4 py-2 text-sm font-semibold text-warn-dark transition hover:bg-warn-dark/10"
          @click="confirmCancel()"
        >
          <font-awesome-icon icon="trash" />
          {{ $t('calendar.cancelMeeting') }}
        </button>
      </template>
    </OyaModal>
  </div>
</template>
