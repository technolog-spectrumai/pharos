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
import PollCard from "../components/calendar/PollCard.vue";
import PollFormModal from "../components/calendar/PollFormModal.vue";
import type {
  Meeting,
  MeetingDraft,
  MeetingPoll,
  PollDraft,
} from "../components/calendar/meetingModel";

// darkMode is class-based (`.dark` on <html>); the prop only absorbs the
// fall-through attr App.vue passes to every routed view.
defineProps<{ darkMode?: boolean }>();

const chatStore = useChatStore();
// Non-null: the /calendar route is build-gated (pland.md), so this view only
// ever mounts in an edition where the composable exists.
const meetings = chatStore.meetings!;
const p2p = chatStore.p2p;

const selectedDay = ref(new Date());
const formOpen = ref(false);
const editing = ref<Meeting | null>(null);
const cancelling = ref<Meeting | null>(null);
const pollFormOpen = ref(false);
const confirmingSlot = ref<{ poll: MeetingPoll; slotId: string } | null>(null);
const cancellingPoll = ref<MeetingPoll | null>(null);

const rooms = computed(() => p2p.p2pRooms.value);
const currentRoomSlug = computed(() => p2p.currentRoom.value?.slug ?? "");

const POLL_STATUS_RANK: Record<string, number> = { open: 0, closed: 1, cancelled: 2 };
const sortedPolls = computed(() =>
  [...meetings.polls.value].sort(
    (a, b) =>
      (POLL_STATUS_RANK[a.status] ?? 3) - (POLL_STATUS_RANK[b.status] ?? 3) ||
      b.createdAt.localeCompare(a.createdAt),
  ),
);

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}
function openEdit(m: Meeting) {
  editing.value = m;
  formOpen.value = true;
}

/** Inviting a room that isn't the open one: switch to it so the outbox can
 *  flush once its MLS session is ready (same move as sending a room invite). */
function openRoomIfNeeded(roomSlug: string) {
  if (roomSlug && roomSlug !== currentRoomSlug.value) {
    const entry = rooms.value.find((r) => r.room === roomSlug);
    if (entry) void p2p.openP2pRoom(entry);
  }
}

async function onSave(draft: MeetingDraft) {
  if (editing.value) {
    await meetings.update(editing.value.id, draft);
    return;
  }
  await meetings.create(draft);
  openRoomIfNeeded(draft.roomSlug);
}

async function onSavePoll(draft: PollDraft) {
  await meetings.createPoll(draft);
  openRoomIfNeeded(draft.roomSlug);
}

async function confirmCancel() {
  if (!cancelling.value) return;
  await meetings.cancel(cancelling.value.id);
  cancelling.value = null;
}

const confirmingSlotLabel = computed(() => {
  const c = confirmingSlot.value;
  const slot = c?.poll.slots.find((s) => s.id === c.slotId);
  if (!slot) return "";
  return new Date(slot.start).toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
});

async function confirmSlotNow() {
  if (!confirmingSlot.value) return;
  await meetings.confirmPoll(confirmingSlot.value.poll.id, confirmingSlot.value.slotId);
  confirmingSlot.value = null;
}

async function cancelPollNow() {
  if (!cancellingPoll.value) return;
  await meetings.cancelPoll(cancellingPoll.value.id);
  cancellingPoll.value = null;
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-xl font-bold">{{ $t('calendar.title') }}</h1>
        <p class="text-sm opacity-60">{{ $t('calendar.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <OyaButton variant="secondary" @click="pollFormOpen = true">
          <font-awesome-icon icon="list-check" />
          {{ $t('calendar.newPoll') }}
        </OyaButton>
        <OyaButton @click="openCreate()">
          <font-awesome-icon icon="calendar-plus" />
          {{ $t('calendar.newMeeting') }}
        </OyaButton>
      </div>
    </div>

    <!-- Doodle polls: find a time before committing to a meeting. -->
    <div v-if="sortedPolls.length" class="flex flex-col gap-2">
      <h2 class="text-sm font-semibold uppercase tracking-wide opacity-60">
        {{ $t('calendar.pollsSection') }}
      </h2>
      <PollCard
        v-for="p in sortedPolls"
        :key="p.id"
        :poll="p"
        @vote="(slotId, choice) => meetings.votePoll(p.id, slotId, choice)"
        @confirm-slot="(slotId) => (confirmingSlot = { poll: p, slotId })"
        @cancel-poll="cancellingPoll = p"
        @remove="meetings.removePollLocal(p.id)"
      />
    </div>

    <div class="grid gap-3 lg:grid-cols-[3fr_2fr]">
      <CalendarPanel
        v-model="selectedDay"
        :meetings="meetings.meetings.value"
        :polls="meetings.polls.value"
      />
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

    <PollFormModal
      v-model:open="pollFormOpen"
      :rooms="rooms"
      :current-room-slug="currentRoomSlug"
      @save="onSavePoll"
    />

    <!-- Confirm a winning slot — closes the poll and invites the room. -->
    <OyaModal :open="!!confirmingSlot" @close="confirmingSlot = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="calendar-plus" />
          {{ $t('calendar.confirmSlot') }}
        </p>
        <p class="text-sm opacity-80">
          {{ $t('calendar.pollConfirm', { title: confirmingSlot?.poll.title ?? '', when: confirmingSlotLabel }) }}
        </p>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="confirmingSlot = null"
        >
          {{ $t('calendar.cancel') }}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border border-success-dark/50 px-4 py-2 text-sm font-semibold text-success-dark transition hover:bg-success-dark/10"
          @click="confirmSlotNow()"
        >
          <font-awesome-icon icon="check" />
          {{ $t('calendar.confirmSlot') }}
        </button>
      </template>
    </OyaModal>

    <!-- Cancel poll confirmation — the cancellation is broadcast to the room. -->
    <OyaModal :open="!!cancellingPoll" @close="cancellingPoll = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('calendar.cancelPoll') }}
        </p>
        <p class="text-sm opacity-80">
          {{ $t('calendar.pollCancelConfirm', { title: cancellingPoll?.title ?? '' }) }}
        </p>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="cancellingPoll = null"
        >
          {{ $t('calendar.cancel') }}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border border-warn-dark/50 px-4 py-2 text-sm font-semibold text-warn-dark transition hover:bg-warn-dark/10"
          @click="cancelPollNow()"
        >
          <font-awesome-icon icon="trash" />
          {{ $t('calendar.cancelPoll') }}
        </button>
      </template>
    </OyaModal>

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
