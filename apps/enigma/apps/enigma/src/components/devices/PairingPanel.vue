<script setup lang="ts">
// Files → Devices → Pairing: the two pairing flows (extracted verbatim from
// the old Settings → Devices panel; the linked-device list it used to carry
// now lives in DevicesTab's header card).
//   • "Link a new device" (primary): mint the QR (devlink_pair_begin), show it
//     with an expiry countdown, and confirm the incoming request by fingerprint.
//   • "This is the new device" (secondary): scan or paste the pairing ticket,
//     watch the transfer progress, then the app reloads as the linked identity.
// Pairing is iroh-only: airplane mode and Tor-exclusive mode disable the
// controls with a reason (file_xfer precedent), never hide them.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import {
  OyaButton, OyaCard, OyaCopyField, OyaModal, OyaQrCode, OyaTextField,
} from "rakotis";
import { useDevicesStore } from "../../stores/devices";
import QrScannerModal from "../chat/QrScannerModal.vue";
import { useNetworkStore } from "../../stores/network";

const { t } = useI18n({ useScope: "global" });
const store = useDevicesStore();
const {
  pairing, pairTicket, pairExpiresAt, pairRequest,
  joining, joinPhase, joinProgress, error,
} = storeToRefs(store);

// ── network-policy state (disabled-with-reason, never hidden) ─────────────────
// Live from the shared store: flipping the Settings toggles disables the
// pairing controls here at the same moment, not at the next remount.
const network = useNetworkStore();
const offline = computed(() => network.offline);
const torMode = computed(() => network.useTor);
const blocked = computed(() => offline.value || torMode.value);
const blockedReason = computed(() =>
  offline.value ? t("devices.blockedOffline") : torMode.value ? t("devices.blockedTor") : "");

// ── pairing QR countdown ──────────────────────────────────────────────────────
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
const secondsLeft = computed(() =>
  Math.max(0, Math.round((pairExpiresAt.value - now.value) / 1000)));
// When the QR's one-time secret expires, tear the pairing session down instead
// of leaving a dead "0 s" QR on screen (the Rust secret is already unredeemable).
watch(secondsLeft, (s) => {
  if (pairing.value && s <= 0) void store.cancelPairing();
});

// Can't pair to yourself: while this device is showing its own QR, block the
// "new device" (join) controls.
const canJoin = computed(() => !blocked.value && !pairing.value);

// ── secondary-side form ───────────────────────────────────────────────────────
const scanOpen = ref(false);
const manualTicket = ref("");
const deviceLabel = ref("");
const deviceKind = ref<"desktop" | "mobile">("desktop");

function shortNode(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

async function join(ticket: string) {
  scanOpen.value = false;
  if (!ticket.trim()) return;
  await store.joinPairing(ticket, deviceLabel.value.trim() || t("devices.defaultLabel"), deviceKind.value);
  manualTicket.value = "";
}

onMounted(async () => {
  tick = setInterval(() => { now.value = Date.now(); }, 1000);
  await network.refresh();
  await store.refresh();
});
onUnmounted(() => {
  if (tick) clearInterval(tick);
});
</script>

<template>
  <div class="space-y-4">
    <!-- Link a new device (primary side) -->
    <OyaCard :padded="true" class="space-y-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ t('devices.pairTitle') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ t('devices.pairHint') }}</p>
      </div>

      <p v-if="blocked" class="text-sm font-semibold text-amber-500">{{ blockedReason }}</p>

      <div v-if="!pairing" class="flex flex-wrap gap-2">
        <OyaButton :disabled="blocked" @click="store.startPairing()">
          <font-awesome-icon icon="qrcode" />{{ t('devices.showQr') }}
        </OyaButton>
      </div>

      <div v-else class="space-y-3">
        <div class="flex flex-col items-center gap-2">
          <OyaQrCode :value="pairTicket" :size="200" />
          <p class="text-xs opacity-70">{{ t('devices.qrExpires', { s: secondsLeft }) }}</p>
          <OyaCopyField :value="pairTicket" mono class="w-full" />
        </div>
        <div class="flex justify-center">
          <OyaButton variant="secondary" @click="store.cancelPairing()">
            {{ t('devices.cancelPairing') }}
          </OyaButton>
        </div>
      </div>
    </OyaCard>

    <!-- This is the new device (secondary side) -->
    <OyaCard :padded="true" class="space-y-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ t('devices.joinTitle') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ t('devices.joinHint') }}</p>
      </div>

      <div v-if="!joining" class="space-y-3">
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs font-semibold uppercase tracking-wide opacity-70">
            {{ t('devices.labelField') }}
            <OyaTextField v-model="deviceLabel" :placeholder="t('devices.defaultLabel')" />
          </label>
          <label class="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide opacity-70">
            {{ t('devices.kindField') }}
            <select
              v-model="deviceKind"
              class="rounded-lg border border-accent-2 bg-primary-bg-light px-3 py-2 text-sm outline-none dark:border-accent-1 dark:bg-primary-bg-dark"
            >
              <option value="desktop">{{ t('devices.kindDesktop') }}</option>
              <option value="mobile">{{ t('devices.kindMobile') }}</option>
            </select>
          </label>
        </div>
        <p v-if="pairing" class="text-xs opacity-70">{{ t('devices.joinBlockedPairing') }}</p>
        <div class="flex flex-wrap gap-2">
          <OyaButton :disabled="!canJoin" @click="scanOpen = true">
            <font-awesome-icon icon="camera" />{{ t('devices.scanQr') }}
          </OyaButton>
        </div>
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs font-semibold uppercase tracking-wide opacity-70">
            {{ t('devices.pasteTicket') }}
            <OyaTextField v-model="manualTicket" mono size="sm" />
          </label>
          <OyaButton :disabled="!canJoin || !manualTicket.trim()" @click="join(manualTicket)">
            {{ t('devices.joinButton') }}
          </OyaButton>
        </div>
      </div>

      <div v-else class="space-y-2 text-sm">
        <p class="font-semibold">{{ t('devices.joining') }} — {{ joinPhase }}</p>
        <p v-if="joinProgress.total" class="text-xs opacity-70">
          {{ joinProgress.current }} / {{ joinProgress.total }}
        </p>
      </div>

      <p v-if="error" class="text-sm font-semibold text-red-500">{{ error }}</p>
    </OyaCard>

    <!-- Incoming pairing request (primary confirm gate) -->
    <OyaModal :open="!!pairRequest" @close="store.confirmPairing(false)">
      <OyaCard v-if="pairRequest" :padded="true" class="w-full max-w-md space-y-3 text-sm">
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ t('devices.requestTitle') }}
        </p>
        <p>{{ t('devices.requestBody', { label: pairRequest.label || pairRequest.deviceId }) }}</p>
        <p class="break-all text-xs opacity-70">
          {{ t('devices.requestFingerprint') }}: {{ shortNode(pairRequest.nodeId) }}
        </p>
        <p class="text-xs opacity-70">{{ t('devices.requestWarning') }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="store.confirmPairing(false)">
            {{ t('devices.reject') }}
          </OyaButton>
          <OyaButton @click="store.confirmPairing(true)">
            {{ t('devices.accept') }}
          </OyaButton>
        </div>
      </OyaCard>
    </OyaModal>

    <QrScannerModal v-model:open="scanOpen" @decoded="join($event)" />
  </div>
</template>
