<script setup lang="ts">
// The selected day's meetings + the next few upcoming ones. Row actions
// (RSVP / edit / cancel / remove) bubble up to the view.
import { computed } from "vue";
import { OyaCard, OyaEmptyState } from "rakotis";
import MeetingRow from "./MeetingRow.vue";
import { dayKey, meetingsOnDay, upcoming, type Meeting } from "./meetingModel";

const props = defineProps<{ day: Date; meetings: Meeting[] }>();
const emit = defineEmits<{
  respond: [id: string, status: "accepted" | "declined"];
  edit: [meeting: Meeting];
  cancelMeeting: [meeting: Meeting];
  remove: [id: string];
}>();

const dayLabel = computed(() =>
  props.day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
);
const dayMeetings = computed(() => meetingsOnDay(props.meetings, dayKey(props.day)));
// The day list already shows today's items — "Upcoming" fills the lookahead.
const upcomingMeetings = computed(() => upcoming(props.meetings, Date.now()));
</script>

<template>
  <div class="flex flex-col gap-3">
    <OyaCard>
      <h3 class="mb-2 text-sm font-semibold uppercase tracking-wide opacity-60">
        {{ dayLabel }}
      </h3>
      <div v-if="dayMeetings.length" class="flex flex-col gap-2">
        <MeetingRow
          v-for="m in dayMeetings"
          :key="m.id"
          :meeting="m"
          @respond="(s) => emit('respond', m.id, s)"
          @edit="emit('edit', m)"
          @cancel-meeting="emit('cancelMeeting', m)"
          @remove="emit('remove', m.id)"
        />
      </div>
      <OyaEmptyState v-else icon="calendar" class="py-6">
        {{ $t('calendar.noEventsDay') }}
      </OyaEmptyState>
    </OyaCard>

    <OyaCard v-if="upcomingMeetings.length">
      <h3 class="mb-2 text-sm font-semibold uppercase tracking-wide opacity-60">
        {{ $t('calendar.upcoming') }}
      </h3>
      <div class="flex flex-col gap-2">
        <div v-for="m in upcomingMeetings" :key="m.id" class="text-sm">
          <span class="font-mono text-xs opacity-60">
            {{ new Date(m.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }}
            {{ new Date(m.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
          </span>
          <span class="ml-2 font-medium">{{ m.title }}</span>
          <span v-if="!m.mine && m.myRsvp === 'pending'" class="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-warn-dark" :title="$t('calendar.pendingTitle')" />
        </div>
      </div>
    </OyaCard>
  </div>
</template>
