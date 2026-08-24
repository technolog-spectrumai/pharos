<script setup lang="ts">
// One MANA meter: a labelled bar with its balance, ceiling and regeneration rate.
//
// Used identically on the welcome page and in Settings → Privacy, so the two can
// never show different numbers. The bar is presentational; the numbers beside it
// are the real content, and they stay readable when the bar is too short to see.
import { formatMana, formatMeter, meterBand, meterPercent, regenPerHour, type ManaMeter } from "../../privacyMana";

withDefaults(
  defineProps<{
    meter: ManaMeter;
    /** Already-translated label ("Today", "This week"). */
    label: string;
    /** Already-translated regeneration line ("+4 MANA / hour"). */
    regenLabel?: string;
    /** Already-translated countdown ("next +1 in 12 min"). */
    nextLabel?: string;
    compact?: boolean;
  }>(),
  { compact: false },
);

/** Band → bar colour. Thresholds are cosmetic: nothing is gated at 25%. */
const bandClass: Record<string, string> = {
  full: "bg-success-light dark:bg-success-dark",
  ok: "bg-accent-light dark:bg-accent-dark",
  low: "bg-highlight",
  empty: "bg-warn-light dark:bg-warn-dark",
};
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-1" data-testid="mana-meter">
    <div class="flex items-baseline justify-between gap-3">
      <span class="truncate text-xs font-bold uppercase opacity-70">{{ label }}</span>
      <span class="shrink-0 text-sm font-bold tabular-nums" data-testid="mana-meter-value">
        {{ formatMeter(meter) }}
      </span>
    </div>

    <!-- role=meter, not progressbar: this is a level, not a task's completion. -->
    <div
      class="h-2 w-full overflow-hidden rounded-full bg-sunken-light dark:bg-sunken-dark"
      role="meter"
      :aria-valuenow="Number(formatMana(meter.balanceCenti))"
      :aria-valuemin="0"
      :aria-valuemax="Number(formatMana(meter.maxCenti))"
      :aria-label="label"
    >
      <div
        :class="bandClass[meterBand(meter)]"
        class="h-full rounded-full transition-[width] duration-500"
        :style="{ width: `${meterPercent(meter)}%` }"
        data-testid="mana-meter-bar"
      />
    </div>

    <div v-if="!compact" class="flex items-baseline justify-between gap-3 text-[11px] opacity-60">
      <span v-if="regenLabel" class="truncate">{{ regenLabel }}</span>
      <span v-if="nextLabel && meter.msToNextMana !== null" class="shrink-0 tabular-nums">
        {{ nextLabel }}
      </span>
    </div>
    <!-- regenPerHour is exposed for callers that build their own label. -->
    <span v-else class="sr-only">{{ regenPerHour(meter) }}</span>
  </div>
</template>
