<script setup lang="ts">
// The last seven days of the daily meter, as one line (hourly samples), drawn
// with Chart.js — vendored in petalite (petalite/vendor/chartjs), not fetched.
//
// Nothing is stored to make it. `hpHistory` calls the same pure `deriveBalances`
// the live number uses, once per sample, with a past `now`. So there is no
// timeline to keep in step with the ledger, no way for the chart to contradict
// the figure above it, and no network involved.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { hpHistory, formatHp, type HpPolicy, type HpEntry } from "rakotis";
import { Chart, type ChartInstance } from "petalite/vendor/chartjs";

const props = defineProps<{
  policy: HpPolicy;
  entries: readonly HpEntry[];
  maxCenti: number;
  /** Passed in so the chart re-derives when the ledger does, and is testable. */
  now: number;
}>();

const { locale } = useI18n();

/** Hourly samples over the history window (7 days). */
const samples = computed(() => hpHistory(props.policy, props.entries, props.now, "hour"));
/** The series as HP, for the chart and for tests. */
const points = computed(() => samples.value.map((s) => s.centi / 100));

const lowest = computed(() => samples.value.reduce((lo, s) => Math.min(lo, s.centi), props.maxCenti));

const dayFmt = computed(() => new Intl.DateTimeFormat(locale.value, { weekday: "short", day: "numeric" }));
const timeFmt = computed(
  () => new Intl.DateTimeFormat(locale.value, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
);

const canvas = ref<HTMLCanvasElement | null>(null);
let chart: ChartInstance | null = null;

/** Colours from the theme, read off the page so light and dark both work. */
function colours() {
  const css = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains("dark");
  // The highlight on dark, the deep accent on light: both read clearly on their ground.
  const accent = dark ? "#8c96e8" : css.getPropertyValue("--color-accent-light").trim() || "#2f3d63";
  const text = canvas.value ? getComputedStyle(canvas.value).color : "#888";
  return { accent, text };
}

function config() {
  const { accent, text } = colours();
  const times = samples.value.map((s) => s.t);
  return {
    type: "line",
    data: {
      labels: times,
      datasets: [
        {
          data: points.value,
          borderColor: accent,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.25,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items: { label: string }[]) => timeFmt.value.format(new Date(Number(items[0]?.label))),
            label: (item: { parsed: { y: number } }) => `${formatHp(Math.round(item.parsed.y * 100))} HP`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: text,
            autoSkip: false,
            maxRotation: 0,
            // One label a day, at its first sample.
            callback: (_v: unknown, i: number) => {
              const t = times[i];
              const prev = times[i - 1];
              const day = (x: number) => new Date(x).toDateString();
              // At day boundaries only: the window starts mid-day, and a label
              // for that part-day would collide with the next one.
              return prev !== undefined && day(t) !== day(prev) ? dayFmt.value.format(new Date(t)) : null;
            },
          },
        },
        y: {
          min: 0,
          max: props.maxCenti / 100,
          ticks: { color: text, maxTicksLimit: 5 },
          grid: { color: "rgba(127,127,127,0.15)" },
        },
      },
    },
  };
}

function draw() {
  const el = canvas.value;
  // No 2D context (jsdom in tests, or a webview with canvas off): the numbers
  // under the chart still say what matters.
  if (!el || !el.getContext?.("2d")) return;
  if (chart) {
    const c = config();
    chart.data.labels = c.data.labels;
    chart.data.datasets[0].data = c.data.datasets[0].data;
    chart.options.scales = c.options.scales;
    chart.update("none");
    return;
  }
  try {
    chart = new Chart(el, config());
  } catch {
    chart = null;
  }
}

onMounted(draw);
watch([points, locale, () => props.maxCenti], draw);
onBeforeUnmount(() => {
  chart?.destroy();
  chart = null;
});

defineExpose({ points });
</script>

<template>
  <section class="flex flex-col gap-2" data-testid="hp-chart">
    <h3 class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("hp.chartTitle") }}</h3>
    <div class="relative h-40 w-full sm:h-48">
      <canvas
        ref="canvas"
        role="img"
        :aria-label="$t('hp.chartAlt', { n: policy.historyDays })"
        data-testid="hp-chart-line"
        :data-points="points.length"
      />
    </div>
    <p class="text-[11px] opacity-60" data-testid="hp-chart-low">
      {{ $t("hp.chartLow", { n: formatHp(lowest), days: policy.historyDays }) }}
    </p>
  </section>
</template>
