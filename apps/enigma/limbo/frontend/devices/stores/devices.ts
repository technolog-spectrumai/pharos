// Linked devices — compatibility state for profiles that are already linked.
// The Files → Devices tab and QR pairing are parked/removed from active UI;
// ongoing sync is still owned by the chat store's `deviceSync`.

import { computed } from "vue";
import { defineStore } from "pinia";
import {
  activeDevices, getBuildConfig,
  type DeviceEntry, type DeviceRegistry,
} from "rakotis";
import { useChatStore } from "./chat";

export const useDevicesStore = defineStore("devices", () => {
  const chatStore = useChatStore();

  const enabled = computed(() => getBuildConfig().devices_allow_linking);
  const linked = computed(() => chatStore.deviceSync?.linked.value ?? false);
  const registry = computed<DeviceRegistry | null>(() => chatStore.deviceSync?.registry.value ?? null);
  const devices = computed<DeviceEntry[]>(() => (registry.value ? activeDevices(registry.value) : []));
  const myDeviceId = computed(() => chatStore.deviceSync?.link.value?.myDeviceId ?? null);
  const lastSyncAt = computed(() => chatStore.deviceSync?.lastSyncAt.value ?? 0);
  const devConnected = computed(() => chatStore.deviceSync?.devConnected.value ?? false);
  /** Leaves currently in the devlink room — the per-row online dot. */
  const onlineLeafIds = computed<string[]>(() => chatStore.deviceSync?.onlineLeafIds.value ?? []);

  /** Unlink a device (chat store's deviceSync owns the protocol). */
  async function unlinkDevice(deviceId: string): Promise<void> {
    await chatStore.deviceSync?.unlinkDevice(deviceId);
  }

  async function refresh(): Promise<void> {
    await chatStore.deviceSync?.refresh();
  }

  return {
    enabled, linked, registry, devices, myDeviceId, lastSyncAt, devConnected, onlineLeafIds,
    unlinkDevice, refresh,
  };
});
