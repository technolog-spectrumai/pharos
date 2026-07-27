<script setup lang="ts">
// Chat card for a received/sent map share (pin / route / location / region).
// Nothing opens or downloads automatically: pins/routes/locations open in Maps
// only on the button press; regions transfer only after Download (then get
// BLAKE3 + manifest-verified in Rust before anything is registered).
//
// A location card outlives its marker: past MAP_LOC_TTL_MS the map stops
// drawing it, but the card stays as a permanent record of what was shared and
// when — so it says so rather than pretending to still be current.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  MAP_LOC_TTL_MS, getUseTor, isLocationLive, isTauri, locationAgeMs, type Message,
} from "rakotis";
import { useMapStore } from "../../stores/map";

const props = defineProps<{ message: Message }>();

const router = useRouter();
const { t } = useI18n({ useScope: "global" });
const store = useMapStore();
const torMode = ref(false);
// Re-render the relative age (and the expiry flip) without a reload.
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  tick = setInterval(() => { now.value = Date.now(); }, 60_000);
  if (isTauri()) torMode.value = await getUseTor();
});
onUnmounted(() => {
  if (tick) clearInterval(tick);
});

const share = computed(() => props.message.map ?? null);

const receive = computed(() =>
  share.value?.type === "map_region" ? store.receives.get(share.value.offerId) ?? null : null,
);

/** Coarse "shared N ago" — minutes, then hours. Deliberately not a clock time:
 *  the card is about recency, and the sender's clock is not ours. */
const sharedAgo = computed(() => {
  if (share.value?.type !== "map_loc") return "";
  const mins = Math.floor(locationAgeMs(share.value, now.value) / 60_000);
  if (mins < 1) return t("map.locJustNow");
  if (mins < 60) return t("map.locAgoMinutes", { n: mins });
  return t("map.locAgoHours", { n: Math.floor(mins / 60) });
});

const locExpired = computed(
  () => share.value?.type === "map_loc" && !isLocationLive(share.value, now.value),
);

function human(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openInMaps() {
  if (!share.value || share.value.type === "map_region") return;
  store.focusShare(share.value);
  void router.push("/map");
}

async function download() {
  if (share.value?.type !== "map_region") return;
  await store.acceptRegionShare(share.value).catch(() => {});
}
</script>

<template>
  <div v-if="share" class="mt-1 space-y-2">
    <!-- Pin / route -->
    <template v-if="share.type === 'map_pin'">
      <p class="flex items-center gap-2 text-sm font-semibold">
        <font-awesome-icon :icon="share.type === 'map_pin' ? 'location-dot' : 'route'" />
        <span
          v-if="share.color"
          class="inline-block h-3 w-3 shrink-0 rounded-full border border-current/30"
          :style="{ backgroundColor: share.color }"
        />
        {{ share.name }}
      </p>
      <p v-if="share.type === 'map_pin' && share.note" class="text-xs opacity-70">{{ share.note }}</p>
      <button
        type="button"
        class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-70"
        @click="openInMaps"
      >
        <font-awesome-icon icon="map" /> {{ $t('map.openInMaps') }}
      </button>
    </template>

    <!-- Shared location (expires on the map, never on the card) -->
    <template v-else-if="share.type === 'map_loc'">
      <p class="flex items-center gap-2 text-sm font-semibold">
        <font-awesome-icon icon="location-crosshairs" />
        {{ share.label || $t('map.locCardDefault') }}
      </p>
      <p v-if="share.note" class="text-xs opacity-70">{{ share.note }}</p>
      <p class="text-xs opacity-60">{{ sharedAgo }}</p>
      <p v-if="locExpired" class="text-xs opacity-50">
        {{ $t('map.locExpired', { hours: Math.round(MAP_LOC_TTL_MS / 3600000) }) }}
      </p>
      <button
        type="button"
        class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-70"
        @click="openInMaps"
      >
        <font-awesome-icon icon="map" /> {{ $t('map.openInMaps') }}
      </button>
    </template>

    <!-- Region offer -->
    <template v-else>
      <p class="flex items-center gap-2 text-sm font-semibold">
        <font-awesome-icon icon="map" /> {{ share.manifest.name }}
      </p>
      <p class="text-xs opacity-60">
        {{ $t('map.regionCard', {
          size: human(share.manifest.size),
          min: share.manifest.minZoom,
          max: share.manifest.maxZoom,
        }) }}
      </p>
      <template v-if="!message.self">
        <button
          v-if="!receive || receive.state === 'error'"
          type="button"
          class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="torMode"
          :title="torMode ? $t('map.shareTorBlocked') : ''"
          @click="download"
        >
          <font-awesome-icon icon="download" /> {{ $t('map.downloadRegion') }}
        </button>
        <p v-if="receive?.state === 'error'" class="text-xs text-warn-dark">{{ receive.error }}</p>
        <template v-if="receive && receive.state !== 'error'">
          <div v-if="receive.state !== 'done'" class="h-1.5 w-40 overflow-hidden rounded-full bg-current/10">
            <div
              class="h-full rounded-full bg-accent-light transition-all dark:bg-accent-dark"
              :style="{ width: receive.total ? `${Math.round((receive.transferred / receive.total) * 100)}%` : '10%' }"
            />
          </div>
          <p class="text-xs opacity-70">
            {{ receive.state === 'done' ? $t('map.regionImported')
              : receive.state === 'importing' ? $t('map.regionVerifying')
              : $t('map.regionTransferring') }}
          </p>
        </template>
      </template>
    </template>
  </div>
</template>
