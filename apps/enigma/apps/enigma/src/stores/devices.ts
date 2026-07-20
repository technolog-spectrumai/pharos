// Linked devices — pairing lifecycle + device list for the Settings → Devices
// tab. Pairing itself is Rust (`devlink_*` commands + `devlink://*` events,
// src-tauri/device_link.rs); ongoing sync is the chat store's `deviceSync`
// (rakotis useDeviceSync). This store is only the UI-facing state machine:
//
//   primary:   startPairing() → QR ticket → devlink://request → confirm/reject
//              → devlink://paired → refresh the registry + start syncing
//   secondary: joinPairing(ticket) → devlink://progress → devlink://done →
//              adopt the leaf identity and reload the app (clean re-boot into
//              the linked profile)

import { ref, computed } from "vue";
import { defineStore } from "pinia";
import {
  activeDevices, getBuildConfig, invoke, isTauri,
  type DeviceEntry, type DeviceRegistry,
} from "rakotis";
import { useChatStore } from "./chat";

export interface PairRequest {
  label: string;
  kind: string;
  nodeId: string;
  deviceId: string;
}

interface PairBegun {
  ticket: string;
  expires_at: number;
}

interface DevlinkStatus {
  allow_linking: boolean;
  pairing_active: boolean;
  linked: boolean;
  device_count: number;
  my_device_id: string | null;
  my_leaf_id: string | null;
}

export const useDevicesStore = defineStore("devices", () => {
  const chatStore = useChatStore();

  const enabled = computed(() => getBuildConfig().devices_allow_linking);
  const linked = computed(() => chatStore.deviceSync?.linked.value ?? false);
  const registry = computed<DeviceRegistry | null>(() => chatStore.deviceSync?.registry.value ?? null);
  const devices = computed<DeviceEntry[]>(() => (registry.value ? activeDevices(registry.value) : []));
  const myDeviceId = computed(() => chatStore.deviceSync?.link.value?.myDeviceId ?? null);
  const lastSyncAt = computed(() => chatStore.deviceSync?.lastSyncAt.value ?? 0);
  const devConnected = computed(() => chatStore.deviceSync?.devConnected.value ?? false);

  // Pairing (primary side)
  const pairing = ref(false);
  const pairTicket = ref("");
  const pairExpiresAt = ref(0);
  const pairRequest = ref<PairRequest | null>(null);
  // Pairing (secondary side)
  const joining = ref(false);
  const joinPhase = ref("");
  const joinProgress = ref({ current: 0, total: 0 });
  const error = ref("");

  let listening = false;
  async function ensureListeners() {
    if (listening || !isTauri()) return;
    listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<PairRequest>("devlink://request", (e) => {
      pairRequest.value = e.payload;
    });
    await listen<{ registry: DeviceRegistry; leafId: string }>("devlink://paired", () => {
      // New device linked: reload the registry (MAC finalization included) and
      // make sure the devlink channel is running.
      pairing.value = false;
      pairTicket.value = "";
      pairRequest.value = null;
      void chatStore.deviceSync?.refresh().then(() => chatStore.deviceSync?.start());
    });
    await listen<{ phase: string; current: number; total: number }>("devlink://progress", (e) => {
      joinPhase.value = e.payload.phase;
      joinProgress.value = { current: e.payload.current, total: e.payload.total };
    });
    await listen<{ user: string; leafId: string }>("devlink://done", () => {
      // Everything is applied into this profile's vault. Reload the frontend so
      // the whole app re-boots as the linked leaf identity (the vault stays
      // unlocked Rust-side; devlink_adopt_identity runs in the boot loaders).
      joining.value = false;
      window.location.reload();
    });
    await listen<{ message: string }>("devlink://error", (e) => {
      error.value = e.payload.message;
      joining.value = false;
      // If a pairing session was live on this (primary) side, cancel it in Rust
      // too so a hidden QR isn't left redeemable, and clear any pending confirm
      // so the modal can't dead-end.
      pairRequest.value = null;
      if (pairing.value) void cancelPairing();
    });
  }

  /** Primary: mint the pairing QR. */
  async function startPairing(): Promise<void> {
    error.value = "";
    await ensureListeners();
    try {
      const res = await invoke<PairBegun>("devlink_pair_begin");
      pairTicket.value = res.ticket;
      pairExpiresAt.value = res.expires_at;
      pairing.value = true;
    } catch (e) {
      error.value = (e as Error).message || String(e);
    }
  }

  /** Primary: answer the confirm dialog for an incoming pairing request. */
  async function confirmPairing(accept: boolean): Promise<void> {
    try {
      await invoke("devlink_pair_confirm", { accept });
    } catch (e) {
      error.value = (e as Error).message || String(e);
    }
    if (!accept) pairRequest.value = null;
  }

  /** Primary: abort pairing (drops the QR's one-time secret). */
  async function cancelPairing(): Promise<void> {
    pairing.value = false;
    pairTicket.value = "";
    pairRequest.value = null;
    await invoke("devlink_pair_cancel").catch(() => {});
  }

  /** Secondary (this NEW device): redeem a scanned/pasted pairing ticket. */
  async function joinPairing(ticket: string, label: string, kind: "desktop" | "mobile"): Promise<void> {
    error.value = "";
    await ensureListeners();
    joining.value = true;
    joinPhase.value = "connecting";
    joinProgress.value = { current: 0, total: 0 };
    try {
      await invoke("devlink_pair_join", { ticket: ticket.trim(), label, kind });
    } catch (e) {
      joining.value = false;
      error.value = (e as Error).message || String(e);
    }
  }

  /** Unlink a device (chat store's deviceSync owns the protocol). */
  async function unlinkDevice(deviceId: string): Promise<void> {
    await chatStore.deviceSync?.unlinkDevice(deviceId);
  }

  async function refresh(): Promise<void> {
    await ensureListeners();
    await chatStore.deviceSync?.refresh();
    if (isTauri()) {
      try {
        const status = await invoke<DevlinkStatus>("devlink_status");
        pairing.value = status.pairing_active && pairing.value;
      } catch {
        /* browser / flag-off */
      }
    }
  }

  return {
    enabled, linked, registry, devices, myDeviceId, lastSyncAt, devConnected,
    pairing, pairTicket, pairExpiresAt, pairRequest,
    joining, joinPhase, joinProgress, error,
    startPairing, confirmPairing, cancelPairing, joinPairing, unlinkDevice, refresh,
  };
});
