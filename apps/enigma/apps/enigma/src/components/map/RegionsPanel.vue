<script setup lang="ts">
// Offline regions: import/export region packages produced by the standalone
// map_packager tool, and share regions to the room (manifest over MLS, bytes
// over the file_xfer QUIC path). The app never downloads tiles itself.
// Storage is bounded by the Settings limit; every budget rejection surfaces
// under the usage bar.
import { computed, onMounted, ref } from "vue";
import {
  isTauri,
  getUseTor,
  buildRegionShare,
  OyaButton,
  OyaCard,
  OyaEmptyState,
  type MapRegionManifest,
} from "rakotis";
import { useChatStore } from "../../stores/chat";
import { useMapStore } from "../../stores/map";

const store = useMapStore();
const chatStore = useChatStore();
const tauri = isTauri();

const torMode = ref(false);
const shareBusy = ref<string | null>(null);

const canShare = computed(
  () =>
    chatStore.p2p.currentRoom.value !== null &&
    chatStore.p2p.isConnected.value &&
    chatStore.p2p.mlsStatus.value === "ready",
);
// Region sharing rides file_xfer (iroh QUIC), which Tor mode blocks by design —
// controls stay visible but disabled, with the reason in the tooltip (D7).
const shareBlocked = computed(() => !canShare.value || torMode.value);

const usagePct = computed(() =>
  store.limitBytes > 0 ? Math.min(100, Math.round((store.usedBytes / store.limitBytes) * 100)) : 0,
);

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

onMounted(async () => {
  if (!tauri) return;
  await store.reload();
  torMode.value = await getUseTor();
});

async function share(region: MapRegionManifest) {
  shareBusy.value = region.id;
  try {
    const offer = await store.offerRegion(region.id);
    if (offer) {
      await chatStore.p2p.sendMapShare(buildRegionShare(region, offer.offerId, offer.addr));
    }
  } finally {
    shareBusy.value = null;
  }
}

async function importFile() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
  });
  if (typeof picked === "string") await store.importRegion(picked).catch(() => {});
}

async function exportFile(region: MapRegionManifest) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: `${region.name.replace(/[^\p{L}\p{N} _-]/gu, "_")}.pmtiles`,
    filters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
  });
  if (dest) await store.exportRegion(region.id, dest);
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
    <OyaCard v-if="!tauri" class="flex flex-1 items-center justify-center">
      <OyaEmptyState icon="map" size="lg">
        <p class="font-semibold">{{ $t('map.desktopOnlyTitle') }}</p>
        <p>{{ $t('map.desktopOnlyHint') }}</p>
      </OyaEmptyState>
    </OyaCard>

    <template v-else>
      <!-- Storage usage -->
      <OyaCard>
        <div class="mb-1 flex items-center justify-between text-sm">
          <span class="font-bold">{{ $t('map.storageTitle') }}</span>
          <span class="opacity-70">{{ human(store.usedBytes) }} / {{ human(store.limitBytes) }}</span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-current/10">
          <div
            class="h-full rounded-full bg-accent-light transition-all dark:bg-accent-dark"
            :style="{ width: `${usagePct}%` }"
          />
        </div>
        <p v-if="store.lastError" class="mt-2 text-xs text-warn-dark">{{ store.lastError }}</p>
      </OyaCard>

      <!-- Saved regions -->
      <OyaCard class="min-h-0 flex-1">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm font-bold"><font-awesome-icon icon="map" /> {{ $t('map.regionsTitle') }}</h3>
          <OyaButton variant="secondary" @click="importFile">
            <font-awesome-icon icon="upload" /> {{ $t('map.importButton') }}
          </OyaButton>
        </div>
        <p v-if="store.regions.length === 0" class="text-xs opacity-60">{{ $t('map.noRegions') }}</p>
        <ul class="space-y-2">
          <li
            v-for="region in store.regions"
            :key="region.id"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-accent-2 p-2 text-sm dark:border-accent-1"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate font-semibold">{{ region.name }}</p>
              <p class="text-xs opacity-60">
                {{ human(region.size) }} · z{{ region.minZoom }}–{{ region.maxZoom }}
              </p>
            </div>
            <button
              type="button"
              class="opacity-60 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-25"
              :disabled="shareBlocked || shareBusy === region.id"
              :title="torMode ? $t('map.shareTorBlocked') : canShare ? $t('map.shareRegion') : $t('map.shareNeedsRoom')"
              @click="share(region)"
            >
              <font-awesome-icon icon="share-nodes" />
            </button>
            <button
              type="button"
              class="opacity-60 transition hover:opacity-100"
              :title="$t('map.exportButton')"
              @click="exportFile(region)"
            >
              <font-awesome-icon icon="download" />
            </button>
            <button
              type="button"
              class="opacity-60 transition hover:opacity-100"
              :title="$t('common.delete')"
              @click="store.removeRegion(region.id)"
            >
              <font-awesome-icon icon="trash" />
            </button>
          </li>
        </ul>
      </OyaCard>
    </template>
  </div>
</template>
