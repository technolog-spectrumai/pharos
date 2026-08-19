<script setup lang="ts">
// Parked linked-device UI. The active Files view no longer exposes a Devices
// sub-tab; this component remains as reference/compatibility coverage for
// already-linked profiles.
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaCard } from "rakotis";
import { useDevicesStore } from "../../stores/devices";
import FileSyncPanel from "./FileSyncPanel.vue";

defineProps<{ darkMode?: boolean }>();

const { t } = useI18n({ useScope: "global" });
const store = useDevicesStore();
const { linked, devices, myDeviceId, lastSyncAt, devConnected, onlineLeafIds } = storeToRefs(store);

function fmtWhen(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

/** A sibling is "online" when its leaf is in the devlink room right now. */
function isOnline(leafId: string, deviceId: string): boolean {
  if (deviceId === myDeviceId.value) return true;
  return onlineLeafIds.value.includes(leafId);
}

const syncLine = computed(() =>
  devConnected.value ? t("devices.syncOnline") : t("devices.syncOffline"),
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
    <!-- Linked devices — the header, always visible -->
    <OyaCard :padded="true" class="space-y-3">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
            {{ t('devices.listTitle') }}
          </p>
          <p class="mt-1 text-sm opacity-65">{{ t('devices.listHint') }}</p>
        </div>
        <p v-if="linked" class="text-xs opacity-60">
          {{ t('devices.syncStatus') }}:
          <span :class="devConnected ? 'text-green-500' : 'opacity-80'">{{ syncLine }}</span>
          <template v-if="lastSyncAt"> · {{ t('devices.lastSync') }} {{ fmtWhen(lastSyncAt) }}</template>
        </p>
      </div>

      <p v-if="!linked" class="text-sm opacity-70" data-testid="devices-not-linked">
        {{ t('devices.notLinked') }}
      </p>

      <ul v-else class="space-y-2">
        <li
          v-for="d in devices"
          :key="d.deviceId"
          class="flex items-center justify-between gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
        >
          <div class="flex min-w-0 items-center gap-3">
            <font-awesome-icon
              :icon="d.kind === 'mobile' ? 'mobile-screen' : 'desktop'"
              class="shrink-0 text-lg opacity-70"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">
                {{ d.label || d.deviceId }}
                <span
                  v-if="d.deviceId === myDeviceId"
                  class="ml-2 text-xs font-semibold uppercase text-accent-light dark:text-accent-dark"
                >{{ t('devices.thisDevice') }}</span>
              </p>
              <p class="truncate text-xs opacity-60">
                <span :class="isOnline(d.leafId, d.deviceId) ? 'text-green-500' : 'opacity-70'">●</span>
                {{ isOnline(d.leafId, d.deviceId) ? t('devices.syncOnline') : t('devices.syncOffline') }}
                · {{ t('devices.added') }} {{ fmtWhen(d.addedAt) }}
              </p>
            </div>
          </div>
          <OyaButton
            v-if="d.deviceId !== myDeviceId"
            variant="secondary"
            :data-testid="`devices-unlink-${d.deviceId}`"
            @click="store.unlinkDevice(d.deviceId)"
          >
            {{ t('devices.unlink') }}
          </OyaButton>
        </li>
      </ul>
    </OyaCard>

    <FileSyncPanel />
  </div>
</template>
