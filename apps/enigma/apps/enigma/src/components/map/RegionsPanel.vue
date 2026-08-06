<script setup lang="ts">
// Offline regions: import/export region packages produced by the standalone
// map_packager tool, and share regions to the room (manifest over MLS, bytes
// over the file_xfer QUIC path). The app never downloads tiles itself.
// Storage is bounded by the Settings limit; every budget rejection surfaces
// under the usage bar.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  isTauri,
  getUseTor,
  buildRegionShare,
  OyaButton,
  OyaCard,
  OyaEmptyState,
  type MapRegionManifest,
} from "rakotis";
import { useI18n } from "vue-i18n";
import { useChatStore } from "../../stores/chat";
import { useMapStore } from "../../stores/map";

const store = useMapStore();
const chatStore = useChatStore();
const tauri = isTauri();
const { t } = useI18n();

/** Rust surfaces contract-prefixed errors; translate the ones a user can act
 *  on (a blank-rendering package is otherwise a total mystery). */
function humanError(raw: string): string {
  if (raw.includes("MAPS_SCHEMA_UNSUPPORTED")) return t("map.importSchemaError");
  if (raw.includes("MAPS_STORAGE_LIMIT")) return t("map.importLimitError");
  return raw;
}

// Parent→child UI navigation is an emit; only data that must survive the
// MapPanel remount (the active id itself) goes through the store.
const emit = defineEmits<{ (e: "show-map"): void }>();

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

let unbind: (() => void) | null = null;

onMounted(async () => {
  if (!tauri) return;
  await store.reload();
  torMode.value = await getUseTor();
  // A peer that wants a region we shared publishes its transfer KeyPackage
  // hash here; authorize exactly that one (file_xfer refuses anything else).
  unbind = chatStore.p2p.onSync(async (type: string, payload: Record<string, unknown>) => {
    if (type !== "map_region_bind") return;
    const offerId = payload.offerId as string | undefined;
    const kpHash = payload.kpHash as string | undefined;
    if (offerId && kpHash) {
      await invoke("file_authorize", { offerId, kpHash }).catch(() => {});
    }
  });
});

onUnmounted(() => unbind?.());

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

/** Activate = make this the current map and jump to it; pressing again
 *  deactivates without moving the camera (D3). The kv write must land BEFORE
 *  the emit — the switch remounts MapPanel, which reads the setting on boot. */
async function toggleActive(region: MapRegionManifest) {
  if (store.activeRegionId === region.id) {
    await store.setActiveRegion(null);
    return;
  }
  await store.setActiveRegion(region.id);
  emit("show-map");
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
        <p v-if="store.lastError" class="mt-2 text-xs text-warn-dark">{{ humanError(store.lastError) }}</p>
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
              <p class="flex items-center gap-2 font-semibold">
                <span class="truncate">{{ region.name }}</span>
                <span
                  v-if="store.activeRegionId === region.id"
                  class="shrink-0 rounded-full bg-accent-light/20 px-2 py-0.5 text-[0.65rem] font-bold uppercase text-accent-light dark:bg-accent-dark/20 dark:text-accent-dark"
                >{{ $t('map.activeBadge') }}</span>
              </p>
              <p class="text-xs opacity-60">
                {{ human(region.size) }} · z{{ region.minZoom }}–{{ region.maxZoom }}
              </p>
            </div>
            <button
              type="button"
              class="transition"
              :class="store.activeRegionId === region.id
                ? 'text-accent-light dark:text-accent-dark'
                : 'opacity-60 hover:opacity-100'"
              :title="store.activeRegionId === region.id ? $t('map.deactivate') : $t('map.activateHint')"
              @click="toggleActive(region)"
            >
              <font-awesome-icon icon="layer-group" />
            </button>
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
