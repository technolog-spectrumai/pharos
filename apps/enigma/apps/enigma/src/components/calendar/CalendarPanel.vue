<script setup lang="ts">
// Hand-rolled month grid (native Date, Monday-first): ‹ month › + Today nav,
// event dots per day, click a day to select it (drives DayEventsPanel).
// Filled dots = scheduled meetings; hollow dots = open-poll proposed slots.
import { computed, ref } from "vue";
import { OyaCard, formatDate } from "rakotis";
import { dayKey, monthGrid, type Meeting, type MeetingPoll } from "./meetingModel";

const props = defineProps<{ meetings: Meeting[]; polls?: MeetingPoll[]; modelValue: Date }>();
const emit = defineEmits<{ "update:modelValue": [Date] }>();

const anchor = ref(new Date(props.modelValue.getFullYear(), props.modelValue.getMonth(), 1));

const weeks = computed(() => monthGrid(anchor.value));
const todayKey = dayKey(new Date());
const selectedKey = computed(() => dayKey(props.modelValue));

const dotsByDay = computed(() => {
  const map = new Map<string, { filled: number; hollow: number }>();
  const bump = (k: string, kind: "filled" | "hollow") => {
    const cell = map.get(k) ?? { filled: 0, hollow: 0 };
    cell[kind] += 1;
    map.set(k, cell);
  };
  for (const m of props.meetings) {
    if (m.status === "scheduled") bump(dayKey(m.start), "filled");
  }
  for (const p of props.polls ?? []) {
    if (p.status !== "open") continue;
    for (const s of p.slots) bump(dayKey(s.start), "hollow");
  }
  return map;
});

/** At most 3 dots per cell; confirmed meetings take precedence over proposals. */
function dotsFor(day: Date): { filled: number; hollow: number } {
  const cell = dotsByDay.value.get(dayKey(day));
  if (!cell) return { filled: 0, hollow: 0 };
  const filled = Math.min(3, cell.filled);
  return { filled, hollow: Math.min(3 - filled, cell.hollow) };
}

const monthLabel = computed(() =>
  formatDate(anchor.value, "monthYear"),
);
// Monday-first weekday headers in the viewer's locale (2024-01-01 was a Monday).
// A computed, not a plain array: built once in setup, the `formatDate` reads land
// outside any tracked effect, so a language switch would flip the month header
// above to "sierpień 2026" and leave "Mon Tue Wed" underneath it — one card, two
// languages. Nothing reproduces that today only because switching language forces
// a route change that remounts this component, and `applyProfileLocaleGuess` can
// already switch it without one.
const weekdays = computed(() =>
  Array.from({ length: 7 }, (_, i) => formatDate(new Date(2024, 0, 1 + i), "weekdayShort")),
);

function shiftMonth(delta: number) {
  anchor.value = new Date(anchor.value.getFullYear(), anchor.value.getMonth() + delta, 1);
}
function goToday() {
  const t = new Date();
  anchor.value = new Date(t.getFullYear(), t.getMonth(), 1);
  emit("update:modelValue", t);
}
function pick(day: Date) {
  if (day.getMonth() !== anchor.value.getMonth()) {
    anchor.value = new Date(day.getFullYear(), day.getMonth(), 1);
  }
  emit("update:modelValue", day);
}
</script>

<template>
  <OyaCard>
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 class="text-lg font-semibold capitalize">{{ monthLabel }}</h2>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg border border-accent-2 transition hover:opacity-70 dark:border-accent-1"
          :aria-label="$t('common.back')"
          @click="shiftMonth(-1)"
        >
          <font-awesome-icon icon="arrow-left" class="text-xs" />
        </button>
        <button
          type="button"
          class="rounded-lg border border-accent-2 px-3 py-1.5 text-xs font-semibold transition hover:opacity-70 dark:border-accent-1"
          @click="goToday()"
        >
          {{ $t('calendar.today') }}
        </button>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg border border-accent-2 transition hover:opacity-70 dark:border-accent-1"
          @click="shiftMonth(1)"
        >
          <font-awesome-icon icon="arrow-right" class="text-xs" />
        </button>
      </div>
    </div>

    <div class="grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase opacity-50">
      <span v-for="wd in weekdays" :key="wd" class="py-1 capitalize">{{ wd }}</span>
    </div>
    <div class="grid grid-cols-7 gap-1">
      <button
        v-for="day in weeks.flat()"
        :key="day.getTime()"
        type="button"
        class="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg text-sm transition hover:bg-accent-light/10 dark:hover:bg-accent-dark/10"
        :class="[
          day.getMonth() !== anchor.getMonth() ? 'opacity-30' : '',
          dayKey(day) === selectedKey ? 'bg-accent-light/20 font-bold dark:bg-accent-dark/20' : '',
          dayKey(day) === todayKey ? 'ring-1 ring-accent-light dark:ring-accent-dark' : '',
        ]"
        @click="pick(day)"
      >
        <span>{{ day.getDate() }}</span>
        <span class="flex h-1.5 items-center gap-0.5">
          <span
            v-for="n in dotsFor(day).filled"
            :key="`f${n}`"
            class="h-1.5 w-1.5 rounded-full bg-accent-light dark:bg-accent-dark"
          />
          <span
            v-for="n in dotsFor(day).hollow"
            :key="`h${n}`"
            class="h-1.5 w-1.5 rounded-full border border-accent-light dark:border-accent-dark"
          />
        </span>
      </button>
    </div>
  </OyaCard>
</template>
