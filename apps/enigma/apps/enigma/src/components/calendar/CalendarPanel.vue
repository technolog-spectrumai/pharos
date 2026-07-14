<script setup lang="ts">
// Hand-rolled month grid (native Date, Monday-first): ‹ month › + Today nav,
// event dots per day, click a day to select it (drives DayEventsPanel).
import { computed, ref } from "vue";
import { OyaCard } from "rakotis";
import { dayKey, monthGrid, type Meeting } from "./meetingModel";

const props = defineProps<{ meetings: Meeting[]; modelValue: Date }>();
const emit = defineEmits<{ "update:modelValue": [Date] }>();

const anchor = ref(new Date(props.modelValue.getFullYear(), props.modelValue.getMonth(), 1));

const weeks = computed(() => monthGrid(anchor.value));
const todayKey = dayKey(new Date());
const selectedKey = computed(() => dayKey(props.modelValue));

// Scheduled-meeting dots per day (capped at 3 per cell).
const dotsByDay = computed(() => {
  const map = new Map<string, number>();
  for (const m of props.meetings) {
    if (m.status !== "scheduled") continue;
    const k = dayKey(m.start);
    map.set(k, Math.min(3, (map.get(k) ?? 0) + 1));
  }
  return map;
});

const monthLabel = computed(() =>
  anchor.value.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
);
// Monday-first weekday headers in the viewer's locale (2024-01-01 was a Monday).
const weekdays = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }),
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
            v-for="n in dotsByDay.get(dayKey(day)) ?? 0"
            :key="n"
            class="h-1.5 w-1.5 rounded-full bg-accent-light dark:bg-accent-dark"
          />
        </span>
      </button>
    </div>
  </OyaCard>
</template>
