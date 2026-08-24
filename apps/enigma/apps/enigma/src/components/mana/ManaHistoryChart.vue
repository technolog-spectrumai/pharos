<script setup lang="ts">
// Seven days of the meter, drawn from the ledger.
//
// This replaced the weekly bar. Two meters meant every price had to be legible
// against two ceilings at once, and the slower one moved so little that it read
// as scenery. What a second number could not show — and what this does — is the
// SHAPE of a week: when it drained, how fast, and whether it came back.
//
// Nothing is stored to make it. `manaHistory` calls the same pure `deriveBalances`
// the live number uses, once per sample, with a past `now`. So there is no
// timeline to keep in step with the ledger, no way for the chart to contradict
// the figure above it, and no network involved — the rows are already on the
// device and the only clock consulted is the local one.
//
// The SVG is hand-drawn for the same reason: a chart library would be the largest
// thing in the bundle it was used by, and would still need this file to feed it.
import { computed, ref, watch } from "vue";
import { manaBars, manaHistory, manaSparkline, formatMana, type ManaPolicy, type ManaEntry, type ManaTick } from "rakotis";

const props = defineProps<{
  policy: ManaPolicy;
  entries: readonly ManaEntry[];
  maxCenti: number;
  /** Passed in so the chart re-derives when the ledger does, and is testable. */
  now: number;
}>();

const W = 300;
const H = 64;

// Remembered, like the panel's other view choices — a reader who prefers days
// should not have to say so again on every visit.
const KEY = "enigma:mana:tick";
const tick = ref<ManaTick>(
  (() => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "day" || v === "hour" ? v : "hour";
    } catch {
      return "hour";
    }
  })(),
);
watch(tick, (v) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private window / storage off — the choice just does not persist */
  }
});

const samples = computed(() => manaHistory(props.policy, props.entries, props.now, tick.value));
const line = computed(() => manaSparkline(samples.value, props.maxCenti, W, H));
const bars = computed(() => manaBars(samples.value, props.maxCenti, W, H));

/** A day label under the bars — "24 sie", in the app's language. */
const dayLabel = (t: number) =>
  new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(t));

const lowest = computed(() =>
  samples.value.reduce((lo, s) => Math.min(lo, s.centi), props.maxCenti),
);
</script>

<template>
  <section class="flex flex-col gap-2" data-testid="mana-chart">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("mana.chartTitle") }}</h3>
      <select
        v-model="tick"
        class="rounded-lg border border-current/20 bg-transparent px-2 py-0.5 text-xs font-semibold"
        :aria-label="$t('mana.chartTick')"
        data-testid="mana-chart-tick"
      >
        <option value="hour">{{ $t("mana.tickHour") }}</option>
        <option value="day">{{ $t("mana.tickDay") }}</option>
      </select>
    </div>

    <!-- viewBox + preserveAspectRatio="none" so the chart fills whatever width the
         panel gives it on a phone without the geometry needing to know. -->
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="none"
      class="h-16 w-full overflow-visible"
      role="img"
      :aria-label="$t('mana.chartAlt', { n: policy.historyDays })"
    >
      <!-- The ceiling, so a full week and a flat-lined one do not look alike. -->
      <line x1="0" y1="0.5" :x2="W" y2="0.5" class="stroke-current opacity-15" stroke-width="1" />
      <line x1="0" :y1="H - 0.5" :x2="W" :y2="H - 0.5" class="stroke-current opacity-15" stroke-width="1" />

      <template v-if="tick === 'hour'">
        <polyline
          :points="line"
          fill="none"
          class="stroke-accent-light dark:stroke-accent-dark"
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
          data-testid="mana-chart-line"
        />
      </template>
      <template v-else>
        <rect
          v-for="b in bars"
          :key="b.t"
          :x="b.x"
          :y="b.y"
          :width="b.w"
          :height="b.h"
          rx="1"
          class="fill-accent-light dark:fill-accent-dark"
          data-testid="mana-chart-bar"
        >
          <title>{{ dayLabel(b.t) }} · {{ formatMana(b.centi) }}</title>
        </rect>
      </template>
    </svg>

    <p class="text-[11px] opacity-60" data-testid="mana-chart-low">
      {{ $t("mana.chartLow", { n: formatMana(lowest), days: policy.historyDays }) }}
    </p>
  </section>
</template>
