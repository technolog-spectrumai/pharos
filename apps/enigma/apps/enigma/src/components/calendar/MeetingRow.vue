<script setup lang="ts">
// One meeting line: time, title, place, organizer, status badges. Invitees get
// Accept/Decline here (the "act in the Calendar tab" side of a chat invite);
// the organizer gets Edit/Cancel plus the attendee roster.
import { computed } from "vue";
import { OyaBadge } from "rakotis";
import type { Meeting } from "./meetingModel";

const props = defineProps<{ meeting: Meeting }>();
const emit = defineEmits<{
  respond: [status: "accepted" | "declined"];
  edit: [];
  cancelMeeting: [];
  remove: [];
}>();

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const timeRange = computed(() => {
  const s = new Date(props.meeting.start);
  const e = new Date(props.meeting.end);
  const cross = s.toDateString() !== e.toDateString() ? ` (${e.toLocaleDateString()})` : "";
  return `${s.toLocaleTimeString([], TIME)} – ${e.toLocaleTimeString([], TIME)}${cross}`;
});

const isPast = computed(() => props.meeting.end <= Date.now());
const isCancelled = computed(() => props.meeting.status === "cancelled");
const canRsvp = computed(() => !props.meeting.mine && !isCancelled.value && !isPast.value);
const attendeeRows = computed(() => Object.entries(props.meeting.attendees));

const rsvpTone: Record<string, "success" | "muted" | "pulse"> = {
  accepted: "success",
  declined: "muted",
  pending: "pulse",
};
</script>

<template>
  <div
    class="rounded-lg border border-accent-2 p-3 transition dark:border-accent-1"
    :class="{ 'opacity-60': isCancelled || isPast }"
  >
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="font-semibold" :class="{ 'line-through': isCancelled }">{{ meeting.title }}</p>
        <p class="text-xs opacity-70">
          <font-awesome-icon icon="clock" class="mr-1" />{{ timeRange }}
          <template v-if="meeting.location">
            · <font-awesome-icon icon="location-dot" class="mx-1" />{{ meeting.location }}
          </template>
        </p>
        <p class="text-xs opacity-50">
          {{ $t('calendar.organizer') }}: {{ meeting.mine ? $t('calendar.you') : meeting.organizer }}
          <template v-if="meeting.roomName"> · {{ meeting.roomName }}</template>
        </p>
        <p v-if="meeting.description" class="mt-1 text-sm opacity-80">{{ meeting.description }}</p>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <OyaBadge v-if="isCancelled" tone="warn">{{ $t('calendar.cancelled') }}</OyaBadge>
        <OyaBadge
          v-else-if="!meeting.mine && meeting.myRsvp"
          :tone="rsvpTone[meeting.myRsvp]"
        >
          {{ $t(`calendar.${meeting.myRsvp}`) }}
        </OyaBadge>
        <OyaBadge
          v-if="meeting.needsBroadcast && meeting.mine && !isCancelled"
          tone="muted"
          :title="$t('calendar.willSend')"
        >
          <font-awesome-icon icon="clock" />
        </OyaBadge>
      </div>
    </div>

    <!-- Invitee: RSVP -->
    <div v-if="canRsvp" class="mt-2 flex items-center gap-2">
      <template v-if="meeting.myRsvp === 'pending'">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-semibold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
          @click="emit('respond', 'accepted')"
        >
          <font-awesome-icon icon="check" />{{ $t('calendar.accept') }}
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-accent-2 px-3 py-1.5 text-xs font-semibold transition hover:opacity-70 dark:border-accent-1"
          @click="emit('respond', 'declined')"
        >
          <font-awesome-icon icon="xmark" />{{ $t('calendar.decline') }}
        </button>
      </template>
      <template v-else-if="meeting.myRsvp">
        <span class="text-xs opacity-70">
          {{ meeting.myRsvp === 'accepted' ? $t('calendar.youAccepted') : $t('calendar.youDeclined') }}
        </span>
        <button
          type="button"
          class="text-xs underline opacity-60 transition hover:opacity-100"
          @click="emit('respond', meeting.myRsvp === 'accepted' ? 'declined' : 'accepted')"
        >
          {{ $t('calendar.change') }}
        </button>
      </template>
    </div>

    <!-- Organizer: roster + manage -->
    <template v-if="meeting.mine">
      <div v-if="attendeeRows.length" class="mt-2 flex flex-wrap items-center gap-1.5">
        <span class="text-xs opacity-50">{{ $t('calendar.attendees') }}:</span>
        <OyaBadge v-for="[name, a] in attendeeRows" :key="name" :tone="rsvpTone[a.status]">
          {{ name }} · {{ $t(`calendar.${a.status}`) }}
        </OyaBadge>
      </div>
      <div v-if="!isCancelled && !isPast" class="mt-2 flex items-center gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-accent-2 px-3 py-1.5 text-xs font-semibold transition hover:opacity-70 dark:border-accent-1"
          @click="emit('edit')"
        >
          <font-awesome-icon icon="pencil" />{{ $t('calendar.editMeeting') }}
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-warn-dark px-3 py-1.5 text-xs font-semibold text-warn-dark transition hover:opacity-70"
          @click="emit('cancelMeeting')"
        >
          <font-awesome-icon icon="trash" />{{ $t('calendar.cancelMeeting') }}
        </button>
      </div>
    </template>

    <!-- Housekeeping: drop a cancelled/past entry locally -->
    <div v-if="isCancelled || isPast" class="mt-2">
      <button
        type="button"
        class="text-xs underline opacity-50 transition hover:opacity-100"
        @click="emit('remove')"
      >
        {{ $t('calendar.removeLocal') }}
      </button>
    </div>
  </div>
</template>
