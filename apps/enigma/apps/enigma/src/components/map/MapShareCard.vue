<script setup lang="ts">
// Chat card for a received/sent map share (pin / route / region). Nothing
// opens or downloads automatically: pins/routes open in Maps only on the
// button press; regions transfer only after Download (then get BLAKE3 +
// manifest-verified in Rust before anything is registered).
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getUseTor, isTauri, type Message } from "rakotis";
import { useMapStore } from "../../stores/map";

const props = defineProps<{ message: Message }>();

const router = useRouter();
const store = useMapStore();
const torMode = ref(false);

onMounted(async () => {
  if (isTauri()) torMode.value = await getUseTor();
});

const share = computed(() => props.message.map ?? null);

const receive = computed(() =>
  share.value?.type === "map_region" ? store.receives.get(share.value.offerId) ?? null : null,
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
    <template v-if="share.type === 'map_pin' || share.type === 'map_route'">
      <p class="flex items-center gap-2 text-sm font-semibold">
        <font-awesome-icon :icon="share.type === 'map_pin' ? 'location-dot' : 'route'" />
        {{ share.name }}
      </p>
      <p v-if="share.type === 'map_route'" class="text-xs opacity-60">
        {{ $t('map.pointCount', { n: share.points.length }) }}
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
