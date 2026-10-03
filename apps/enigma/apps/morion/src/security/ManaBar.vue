<script setup lang="ts">
// Security Mana in the app bar: a health bar for plaintext at rest.
//
// One native <progress>: the level out of the maximum. Plain files drain it by
// the kilobyte-hour and it comes back slowly (src-tauri/src/mana.rs); it takes
// the warning colour at a quarter or below, and a small arrow says which way
// it is going. Nothing ticks in Rust, so the bar asks again when the workspace
// has been read (the first read is what opens it in Rust), when the window
// comes back into view, and once a minute while it is visible. Advisory, like
// the budget itself: clicking opens workspace security, where it is
// explained.
//
// Responsive: the number shows from `lg` up, the droplet and the arrow from
// `sm` up, and the bar narrows with the window and can shrink further, so the
// right half of the app bar never pushes against the centred mark.
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspace } from "petalite/files";
import { formatMana, manaStatus, refreshMana } from "./mana";

const emit = defineEmits<{ open: [] }>();
const { t } = useI18n({ useScope: "global" });
const workspace = useWorkspace();

/** How often the bar is read while the window is visible. */
const REFRESH_MS = 60_000;
/** At or below this share the bar takes the warning colour. */
const LOW_SHARE = 0.25;

type Level = "ok" | "low" | "empty";

const level = computed<Level>(() => {
  const s = manaStatus.value;
  if (!s || s.level > s.max * LOW_SHARE) return "ok";
  return s.exhausted ? "empty" : "low";
});

/** Which way the bar is moving: it cannot fall below empty or rise past full. */
const trend = computed<"up" | "down" | "flat">(() => {
  const s = manaStatus.value;
  if (!s) return "flat";
  if (s.netPerHour < 0 && s.level > 0) return "down";
  if (s.netPerHour > 0 && s.level < s.max) return "up";
  return "flat";
});

const label = computed(() => {
  const s = manaStatus.value;
  if (!s) return "";
  const text = t("mana.bar.label", {
    level: formatMana(s.level), max: s.max, drain: formatMana(s.drainPerHour), regen: formatMana(s.regenPerHour),
  });
  return s.exhausted ? `${text} ${t("mana.bar.exhausted")}` : text;
});

let timer = 0;
function onVisibility() {
  if (document.visibilityState === "visible") void refreshMana();
}

onMounted(() => {
  void refreshMana();
  timer = window.setInterval(() => {
    if (document.visibilityState !== "hidden") void refreshMana();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", onVisibility);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

// The workspace is opened in Rust by the store's first read, after this
// mounts, and a switch reads the new folder: a finished read is when there is
// something to count.
watch(() => workspace.loading.value, (busy) => { if (!busy) void refreshMana(); });
watch(() => workspace.root.value, () => { void refreshMana(); });
</script>

<template>
  <button v-if="manaStatus" type="button" data-testid="mana-bar" :data-level="level" :data-trend="trend"
          class="flex min-w-0 shrink items-center gap-1.5 rounded-lg px-1.5 py-1 transition hover:bg-accent-light/10"
          :title="label" :aria-label="label" @click="emit('open')">
    <!-- Wrapped: Font Awesome's own display rule would beat `hidden` on the svg. -->
    <span data-testid="mana-bar-icon" class="hidden shrink-0 text-xs sm:inline-flex"
          :class="level === 'ok' ? 'mana-ink' : 'text-warn-dark'">
      <font-awesome-icon icon="droplet" />
    </span>
    <span class="flex w-10 min-w-6 shrink sm:w-16 lg:w-24" data-testid="mana-bar-track">
      <progress class="mana-meter" data-testid="mana-bar-meter" :data-level="level"
                :value="manaStatus.level" :max="manaStatus.max" :aria-label="t('mana.title')" />
    </span>
    <span v-if="trend !== 'flat'" data-testid="mana-bar-trend" class="hidden shrink-0 text-[10px] opacity-60 sm:inline-flex">
      <font-awesome-icon v-if="trend === 'up'" icon="arrow-up" />
      <font-awesome-icon v-else icon="arrow-down" />
    </span>
    <span class="hidden shrink-0 text-xs font-semibold tabular-nums lg:inline" data-testid="mana-bar-value">
      {{ Math.floor(manaStatus.level) }}
    </span>
  </button>
</template>
