<script setup lang="ts">
// One doodle poll: header with status badges, the slot tally (best slot first),
// my yes / if-need-be / no buttons per slot, and the organizer's per-slot
// "Schedule this time" + "Cancel poll" controls. Expiry is derived at render
// time from the stored deadline (pollExpired) — no timer.
import { computed } from "vue";
import { OyaBadge, formatDate, formatTime } from "rakotis";
import { pollExpired, tallyPoll, type MeetingPoll, type PollVoteChoice } from "./meetingModel";

const props = defineProps<{ poll: MeetingPoll }>();
const emit = defineEmits<{
  vote: [slotId: string, choice: PollVoteChoice];
  confirmSlot: [slotId: string];
  cancelPoll: [];
  remove: [];
}>();

const CHOICES: PollVoteChoice[] = ["yes", "ifneedbe", "no"];
const choiceLabelKey: Record<PollVoteChoice, string> = {
  yes: "voteYes",
  ifneedbe: "voteIfNeedBe",
  no: "voteNo",
};
const selectedClass: Record<PollVoteChoice, string> = {
  yes: "border-success-light bg-success-light text-primary-bg-light dark:border-success-dark dark:bg-success-dark dark:text-primary-bg-dark",
  ifneedbe: "border-accent-light bg-accent-light text-primary-bg-light dark:border-accent-dark dark:bg-accent-dark dark:text-primary-bg-dark",
  no: "border-warn-light bg-warn-light text-primary-bg-light dark:border-warn-dark dark:bg-warn-dark dark:text-primary-bg-dark",
};
const chipTone: Record<PollVoteChoice, "success" | "neutral" | "muted"> = {
  yes: "success",
  ifneedbe: "neutral",
  no: "muted",
};

const isCancelled = computed(() => props.poll.status === "cancelled");
const isClosed = computed(() => props.poll.status === "closed");
const expired = computed(() => pollExpired(props.poll, Date.now()));
const canVote = computed(() => props.poll.status === "open" && !expired.value);
const hasVoted = computed(() => !!props.poll.myVotes && Object.keys(props.poll.myVotes).length > 0);
const voterCount = computed(() => Object.keys(props.poll.votes).length);

const tally = computed(() => tallyPoll(props.poll));
const orderedSlots = computed(() =>
  tally.value
    .map((t) => ({ tally: t, slot: props.poll.slots.find((s) => s.id === t.slotId)! }))
    .filter((r) => r.slot),
);
const leadingSlotId = computed(() => {
  if (!voterCount.value) return null;
  const best = tally.value[0];
  return best && best.yes + best.ifneedbe > 0 ? best.slotId : null;
});

function slotLabel(start: number, end: number): string {
  const day = formatDate(start, "dayMonthWeekdayShort");
  return `${day} · ${formatTime(start)} – ${formatTime(end)}`;
}
const deadlineLabel = computed(() =>
  props.poll.deadline ? formatDate(props.poll.deadline, "dayMonthTime") : "",
);

function votersFor(slotId: string): Array<{ name: string; choice: PollVoteChoice }> {
  return Object.entries(props.poll.votes)
    .filter(([, b]) => b.votes[slotId])
    .map(([name, b]) => ({ name, choice: b.votes[slotId] }));
}
</script>

<template>
  <div
    class="rounded-lg border border-accent-2 p-3 transition dark:border-accent-1"
    :class="{ 'opacity-60': isCancelled }"
  >
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="font-semibold" :class="{ 'line-through': isCancelled }">
          <font-awesome-icon icon="list-check" class="mr-1 opacity-60" />{{ poll.title }}
        </p>
        <p class="text-xs opacity-50">
          {{ $t('calendar.organizer') }}: {{ poll.mine ? $t('calendar.you') : poll.organizer }}
          <template v-if="poll.roomName"> · {{ poll.roomName }}</template>
          <template v-if="poll.location"> · <font-awesome-icon icon="location-dot" class="mx-0.5" />{{ poll.location }}</template>
        </p>
        <p v-if="poll.deadline && !isClosed && !isCancelled" class="text-xs opacity-70">
          <font-awesome-icon icon="clock" class="mr-1" />
          {{ expired ? $t('calendar.votingEnded') : $t('calendar.votingEndsAt', { when: deadlineLabel }) }}
        </p>
        <p v-if="poll.description" class="mt-1 text-sm opacity-80">{{ poll.description }}</p>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <OyaBadge v-if="isCancelled" tone="warn">{{ $t('calendar.cancelled') }}</OyaBadge>
        <OyaBadge v-else-if="isClosed" tone="success">{{ $t('calendar.pollScheduled') }}</OyaBadge>
        <OyaBadge v-else-if="expired" tone="muted">{{ $t('calendar.votingEnded') }}</OyaBadge>
        <OyaBadge v-else-if="!poll.mine && !hasVoted" tone="pulse">{{ $t('calendar.awaitingYourVote') }}</OyaBadge>
        <OyaBadge v-else tone="neutral">{{ $t('calendar.pollOpen') }}</OyaBadge>
        <OyaBadge
          v-if="poll.needsBroadcast && poll.mine && !isCancelled"
          tone="muted"
          :title="$t('calendar.willSend')"
        >
          <font-awesome-icon icon="clock" />
        </OyaBadge>
      </div>
    </div>

    <!-- Slot tally, best first -->
    <div class="mt-2 flex flex-col gap-1.5">
      <div
        v-for="({ slot, tally: t }, idx) in orderedSlots"
        :key="slot.id"
        class="rounded-lg border border-current/10 px-2.5 py-2"
        :class="{
          'ring-1 ring-success-light dark:ring-success-dark': isClosed && poll.chosenSlotId === slot.id,
          'opacity-50': isClosed && poll.chosenSlotId !== slot.id,
        }"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-sm">
            <span class="font-medium">{{ slotLabel(slot.start, slot.end) }}</span>
            <OyaBadge v-if="!isClosed && !isCancelled && idx === 0 && leadingSlotId === slot.id" tone="success">
              {{ $t('calendar.bestSlot') }}
            </OyaBadge>
            <OyaBadge v-if="isClosed && poll.chosenSlotId === slot.id" tone="success" icon="check">
              {{ $t('calendar.pollScheduled') }}
            </OyaBadge>
          </div>
          <span class="text-xs opacity-60">
            <font-awesome-icon icon="check" /> {{ t.yes }}
            · ({{ t.ifneedbe }})
            · <font-awesome-icon icon="xmark" /> {{ t.no }}
          </span>
        </div>

        <div v-if="votersFor(slot.id).length" class="mt-1.5 flex flex-wrap items-center gap-1">
          <OyaBadge v-for="v in votersFor(slot.id)" :key="v.name" :tone="chipTone[v.choice]">
            {{ v.name }}
          </OyaBadge>
        </div>

        <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <template v-if="canVote">
            <button
              v-for="c in CHOICES"
              :key="c"
              type="button"
              class="rounded-lg border px-2.5 py-1 text-xs font-semibold transition hover:opacity-80"
              :class="poll.myVotes?.[slot.id] === c ? selectedClass[c] : 'border-accent-2 dark:border-accent-1'"
              @click="emit('vote', slot.id, c)"
            >
              {{ $t(`calendar.${choiceLabelKey[c]}`) }}
            </button>
          </template>
          <button
            v-if="poll.mine && poll.status === 'open'"
            type="button"
            class="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-semibold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
            @click="emit('confirmSlot', slot.id)"
          >
            <font-awesome-icon icon="calendar-plus" />{{ $t('calendar.confirmSlot') }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="!voterCount && !isCancelled" class="mt-1.5 text-xs opacity-50">{{ $t('calendar.noVotesYet') }}</p>

    <div class="mt-2 flex items-center gap-3">
      <button
        v-if="poll.mine && poll.status === 'open'"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg border border-warn-dark px-3 py-1.5 text-xs font-semibold text-warn-dark transition hover:opacity-70"
        @click="emit('cancelPoll')"
      >
        <font-awesome-icon icon="trash" />{{ $t('calendar.cancelPoll') }}
      </button>
      <button
        v-if="isClosed || isCancelled"
        type="button"
        class="text-xs underline opacity-50 transition hover:opacity-100"
        @click="emit('remove')"
      >
        {{ $t('calendar.removeLocal') }}
      </button>
    </div>
  </div>
</template>
