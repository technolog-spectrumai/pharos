<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton } from "rakotis";
import { useChatStore } from "../../stores/chat";

defineProps<{ darkMode: boolean }>();

const { t } = useI18n();
const chat = useChatStore();
// Non-null: this panel is only reachable through the build-gated /calls route
// (pland.md), so it never renders in a calls-off edition.
const vox = chat.vox!;
const p2p = chat.p2p;
const {
  available,
  phase,
  ticket,
  incomingName,
  peerName,
  muted,
  error,
  callSeconds,
  spectrum,
  encryption,
  nickResults,
} = vox;

// Equalizer bars — fall back to a flat row before the first spectrum frame.
const BAR_COUNT = 24;
const bars = computed(() =>
  spectrum.value.length ? spectrum.value : new Array(BAR_COUNT).fill(0),
);

// Members of the current room we can ring (everyone but ourselves who has an id).
const roomPeers = computed(() =>
  p2p.participants.value.filter(
    (pp): pp is typeof pp & { id: string } => !!pp.id && pp.id !== p2p.mlsIdentity.value,
  ),
);

/** Short, human-comparable fingerprint of an unauthenticated NodeId claim. */
function fingerprint(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

// ── join / call inputs ──────────────────────────────────────────────────────────
const joinTicket = ref("");
const ticketCopied = ref(false);

// Call by DHT nickname.
const nickQuery = ref("");
function callByNick() {
  const n = nickQuery.value.trim();
  if (!n) return;
  void vox.callByNick(n);
}

async function copyTicket() {
  try {
    await navigator.clipboard.writeText(ticket.value);
    ticketCopied.value = true;
    setTimeout(() => (ticketCopied.value = false), 1500);
  } catch {
    /* clipboard unavailable */
  }
}

function joinPasted() {
  const tk = joinTicket.value.trim();
  if (!tk) return;
  void vox.joinByTicket(tk);
  joinTicket.value = "";
}

// ── QR of our ticket (callee, while waiting) ────────────────────────────────────
const qrDataUrl = ref("");
watch(ticket, async (tk) => {
  if (!tk) {
    qrDataUrl.value = "";
    return;
  }
  try {
    const { toDataURL } = await import("qrcode");
    qrDataUrl.value = await toDataURL(tk, { errorCorrectionLevel: "L", margin: 1, width: 240 });
  } catch {
    qrDataUrl.value = "";
  }
});

// ── join by scanning a QR (camera) ──────────────────────────────────────────────
const scanning = ref(false);
const scanError = ref(""); // i18n key
let scanner: any = null;

async function startScan() {
  scanError.value = "";
  scanning.value = true;
  await nextTick();
  try {
    const { Html5Qrcode } = await import("html5-qrcode");
    scanner = new Html5Qrcode("vox-qr-region");
    await scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 220, height: 220 } },
      (decoded: string) => {
        joinTicket.value = decoded.trim();
        void stopScan();
        joinPasted();
      },
      () => {},
    );
  } catch {
    scanError.value = "chat.cameraDenied";
    scanning.value = false;
    scanner = null;
  }
}
async function stopScan() {
  if (scanner) {
    try {
      await scanner.stop();
    } catch {
      /* ignore */
    }
    scanner = null;
  }
  scanning.value = false;
}

// ── join by uploading a QR image ────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null);
async function scanFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (fileInput.value) fileInput.value.value = "";
  if (!file) return;
  scanError.value = "";
  try {
    const { Html5Qrcode } = await import("html5-qrcode");
    const reader = new Html5Qrcode("vox-qr-file-region");
    const decoded: string = await reader.scanFile(file, false);
    try {
      await reader.clear();
    } catch {
      /* ignore */
    }
    joinTicket.value = decoded.trim();
    joinPasted();
  } catch {
    scanError.value = "chat.qrNotFound";
  }
}

onUnmounted(() => {
  void stopScan();
});

const elapsed = computed(() => {
  const s = callSeconds.value;
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
});

const cardClass = computed(() =>
  "rounded-xl border border-current/15 p-6 flex flex-col items-center gap-4 text-center",
);
</script>

<template>
  <div class="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto p-4">
    <!-- Browser / unsupported -->
    <div v-if="!available" :class="cardClass" class="max-w-md">
      <font-awesome-icon icon="phone" class="text-3xl opacity-60" />
      <p class="text-sm opacity-80">{{ t("vox.desktopOnly") }}</p>
    </div>

    <!-- Incoming call -->
    <div v-else-if="phase === 'incoming'" :class="cardClass" class="max-w-md">
      <font-awesome-icon icon="phone" class="text-3xl animate-pulse text-accent-dark" />
      <p class="text-lg font-bold">{{ t("vox.incomingFrom", { name: incomingName }) }}</p>
      <div class="flex gap-3">
        <OyaButton variant="primary" @click="vox.accept()">
          <font-awesome-icon icon="phone" /> {{ t("vox.accept") }}
        </OyaButton>
        <OyaButton variant="secondary" @click="vox.decline()">
          <font-awesome-icon icon="phone-slash" /> {{ t("vox.decline") }}
        </OyaButton>
      </div>
    </div>

    <!-- Connected -->
    <div v-else-if="phase === 'connected'" :class="cardClass" class="max-w-md">
      <div
        class="flex h-16 w-16 items-center justify-center rounded-full text-2xl font-bold"
        :class="darkMode ? 'bg-bubble-bg-dark' : 'bg-bubble-bg-light'"
      >
        {{ (peerName || "?").slice(0, 1).toUpperCase() }}
      </div>
      <p class="text-lg font-bold">{{ peerName }}</p>
      <p class="font-mono text-sm opacity-70">{{ elapsed }}</p>

      <!-- Encryption status -->
      <p
        v-if="encryption === 'mls'"
        class="flex items-center gap-1.5 text-xs font-semibold text-emerald-500"
      >
        <font-awesome-icon icon="lock" /> {{ t("vox.encMls") }}
      </p>
      <div
        v-else-if="encryption === 'transport'"
        class="flex flex-col items-center gap-1.5 rounded-lg border border-warn-dark/40 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark"
      >
        <span class="flex items-center gap-1.5">
          <font-awesome-icon icon="triangle-exclamation" /> {{ t("vox.encTransport") }}
        </span>
        <button type="button" class="font-bold underline" @click="vox.restart()">
          {{ t("vox.restart") }}
        </button>
      </div>

      <!-- Live equalizer of the incoming voice -->
      <div class="flex h-20 w-full max-w-xs items-center justify-center gap-[3px]">
        <div
          v-for="(b, i) in bars"
          :key="i"
          class="w-1.5 rounded-full transition-[height] duration-75 ease-out"
          :class="darkMode ? 'bg-accent-dark' : 'bg-accent-light'"
          :style="{ height: `${Math.max(6, b * 100)}%`, opacity: muted ? 0.3 : 0.55 + b * 0.45 }"
        />
      </div>

      <div class="flex gap-3">
        <OyaButton variant="secondary" @click="vox.toggleMute()">
          <font-awesome-icon :icon="muted ? 'microphone-slash' : 'microphone'" />
          {{ muted ? t("vox.unmute") : t("vox.mute") }}
        </OyaButton>
        <OyaButton variant="primary" @click="vox.hangup()">
          <font-awesome-icon icon="phone-slash" /> {{ t("vox.hangUp") }}
        </OyaButton>
      </div>
    </div>

    <!-- Calling out -->
    <div v-else-if="phase === 'calling'" :class="cardClass" class="max-w-md">
      <font-awesome-icon icon="spinner" spin class="text-3xl opacity-70" />
      <p class="text-sm opacity-80">{{ peerName ? t("vox.callingName", { name: peerName }) : t("vox.calling") }}</p>
      <OyaButton variant="secondary" @click="vox.hangup()">
        <font-awesome-icon icon="phone-slash" /> {{ t("vox.cancel") }}
      </OyaButton>
    </div>

    <!-- Waiting (we created a ticket) -->
    <div v-else-if="phase === 'waiting'" :class="cardClass" class="w-full max-w-md">
      <p class="text-sm font-semibold opacity-80">{{ t("vox.shareToCall") }}</p>
      <img v-if="qrDataUrl" :src="qrDataUrl" alt="QR" class="h-48 w-48 rounded bg-white p-2" />
      <textarea
        :value="ticket"
        readonly
        rows="3"
        class="w-full resize-none rounded-lg border border-current/15 bg-transparent p-2 text-xs"
      />
      <div class="flex items-center gap-3">
        <OyaButton variant="secondary" @click="copyTicket">
          <font-awesome-icon icon="copy" /> {{ ticketCopied ? t("chat.copy") + " ✓" : t("chat.copy") }}
        </OyaButton>
        <OyaButton variant="primary" @click="vox.hangup()">
          {{ t("vox.cancel") }}
        </OyaButton>
      </div>
      <p class="flex items-center gap-2 text-xs opacity-60">
        <font-awesome-icon icon="spinner" spin /> {{ t("vox.waiting") }}
      </p>
    </div>

    <!-- Idle: start or join -->
    <div v-else class="flex w-full max-w-md flex-col gap-6">
      <!-- Call a member of the current room -->
      <div :class="cardClass">
        <font-awesome-icon icon="phone" class="text-3xl opacity-70" />
        <p class="text-sm font-semibold opacity-80">{{ t("vox.roomPeersTitle") }}</p>
        <p v-if="!roomPeers.length" class="text-xs opacity-60">{{ t("vox.noRoomPeers") }}</p>
        <ul v-else class="flex w-full flex-col gap-2">
          <li
            v-for="peer in roomPeers"
            :key="peer.id"
            class="flex items-center justify-between gap-2 rounded-lg border border-current/10 px-3 py-2"
          >
            <span class="truncate text-sm">{{ peer.name || peer.id }}</span>
            <OyaButton variant="primary" @click="vox.callPeer({ id: peer.id, name: peer.name })">
              <font-awesome-icon icon="phone" /> {{ t("vox.callPeer") }}
            </OyaButton>
          </li>
        </ul>
      </div>

      <!-- Call by nickname (DHT directory) -->
      <div :class="cardClass">
        <font-awesome-icon icon="phone" class="text-3xl opacity-70" />
        <p class="text-sm opacity-80">{{ t("vox.callContactHint") }}</p>
        <input
          v-model="nickQuery"
          :placeholder="t('vox.contactPlaceholder')"
          class="w-full rounded-lg border border-current/15 bg-transparent p-2 text-sm"
          @keydown.enter="callByNick"
        />
        <OyaButton variant="primary" @click="callByNick">
          <font-awesome-icon icon="phone" /> {{ t("vox.callContact") }}
        </OyaButton>
        <!-- Disambiguation: nickname claims are unauthenticated, so show fingerprints. -->
        <div v-if="nickResults.length > 1" class="w-full text-left">
          <p class="mb-1 text-xs opacity-60">{{ t("vox.nickResultsHint") }}</p>
          <ul class="flex flex-col gap-2">
            <li
              v-for="claim in nickResults"
              :key="claim.node_id"
              class="flex items-center justify-between gap-2 rounded-lg border border-current/10 px-3 py-2"
            >
              <span class="min-w-0">
                <span class="block truncate text-sm">{{ claim.name || "?" }}</span>
                <span class="block truncate font-mono text-[10px] opacity-60">{{ fingerprint(claim.node_id) }}</span>
              </span>
              <OyaButton variant="secondary" @click="vox.callNode(claim.node_id, claim.name)">
                <font-awesome-icon icon="phone" /> {{ t("vox.callPeer") }}
              </OyaButton>
            </li>
          </ul>
        </div>
      </div>

      <!-- Start a ticket/QR call -->
      <div :class="cardClass">
        <font-awesome-icon icon="phone" class="text-3xl opacity-70" />
        <p class="text-sm opacity-80">{{ t("vox.startHint") }}</p>
        <OyaButton variant="primary" @click="vox.createCall()">
          <font-awesome-icon icon="phone" /> {{ t("vox.startCall") }}
        </OyaButton>
      </div>

      <div :class="cardClass">
        <p class="text-sm font-semibold opacity-80">{{ t("vox.joinHint") }}</p>
        <textarea
          v-model="joinTicket"
          :placeholder="t('vox.pasteTicket')"
          rows="3"
          class="w-full resize-none rounded-lg border border-current/15 bg-transparent p-2 text-xs"
        />
        <div class="flex flex-wrap items-center justify-center gap-2">
          <OyaButton variant="primary" @click="joinPasted">
            <font-awesome-icon icon="phone" /> {{ t("vox.join") }}
          </OyaButton>
          <OyaButton variant="secondary" @click="scanning ? stopScan() : startScan()">
            <font-awesome-icon icon="camera" /> {{ scanning ? t("vox.stopScan") : t("chat.scanQr") }}
          </OyaButton>
          <OyaButton variant="secondary" @click="fileInput?.click()">
            <font-awesome-icon icon="upload" /> {{ t("chat.uploadQr") }}
          </OyaButton>
          <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="scanFile" />
        </div>
        <div v-show="scanning" id="vox-qr-region" class="w-full max-w-[260px]" />
        <div id="vox-qr-file-region" class="hidden" />
        <p v-if="scanError" class="text-xs text-warn-dark">{{ t(scanError) }}</p>
      </div>
    </div>

    <p v-if="error && phase !== 'connected'" class="text-xs text-warn-dark">
      {{ error.startsWith("vox.") || error.startsWith("chat.") ? t(error) : error }}
    </p>
  </div>
</template>
