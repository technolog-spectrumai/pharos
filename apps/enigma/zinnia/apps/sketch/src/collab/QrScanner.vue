<script setup lang="ts">
// Full-screen camera QR scanner, for joining a drawing.
//
// Adapted from enigma's QrScannerModal.vue, with its four hard-won rules kept:
//
//  • html5-qrcode renders the <video> at the container's clientWidth at
//    start() time and derives its height from the stream, so the viewfinder
//    is sized from the frame's real box (OyaModal measures 100dvh — NOT
//    100vh, which counts the mobile URL bar), width capped so even a 3:4
//    portrait stream stays inside it.
//  • The scan box is a FRACTION of the viewfinder, never a fixed pixel box:
//    html5-qrcode rejects a qrbox larger than the rendered video, and on a
//    narrow screen that rejection is a camera that never opens at all.
//  • The scanner handle is dropped BEFORE awaiting stop(): a decode closes the
//    sheet from two sides at once, and a second stop() on a stopping scanner
//    is an error the library throws at us.
//  • The injected <video> gets `:deep` width: the library sets an inline px
//    width once and would not follow a resize otherwise. Height stays auto —
//    a non-uniform scale would silently decode the wrong crop.
import { nextTick, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaModal } from "petalite/primitives";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean]; decoded: [string] }>();
const { t } = useI18n({ useScope: "global" });

const REGION_ID = "collab-qr-region";
/** html5-qrcode refuses a scan box under 50 px; stay clear of the floor. */
const MIN_EDGE = 160;

const frame = ref<HTMLElement | null>(null);
const region = ref<HTMLElement | null>(null);
/** Camera denied or absent: say so instead of closing, which reads as "the
 *  button does nothing". */
const failed = ref(false);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scanner: any = null;

function sizeRegion() {
  const box = frame.value;
  const el = region.value;
  if (!box || !el) return;
  const rect = box.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    el.style.removeProperty("width"); // not laid out yet (or jsdom)
    return;
  }
  el.style.width = `${Math.floor(Math.min(rect.width, Math.max(rect.height * 0.75, MIN_EDGE)))}px`;
}

async function start() {
  failed.value = false;
  await nextTick();
  sizeRegion();
  try {
    const { Html5Qrcode } = await import("html5-qrcode");
    scanner = new Html5Qrcode(REGION_ID);
    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 12,
        qrbox: (viewW: number, viewH: number) => {
          const edge = Math.max(50, Math.floor(Math.min(viewW, viewH) * 0.8));
          return { width: Math.min(edge, viewW), height: Math.min(edge, viewH) };
        },
      },
      (decoded: string) => onDecoded(decoded),
      () => {},
    );
  } catch {
    scanner = null;
    failed.value = true;
  }
}

async function stopCamera() {
  const running = scanner;
  scanner = null;
  if (!running) return;
  try {
    await running.stop();
  } catch {
    /* already stopped */
  }
}

async function close() {
  await stopCamera();
  emit("update:open", false);
}

function onDecoded(text: string) {
  const value = text.trim();
  if (!value) return;
  emit("decoded", value);
  void close();
}

watch(
  () => props.open,
  (o) => {
    if (o) void start();
    else void stopCamera();
  },
);
onUnmounted(() => void stopCamera());
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div ref="frame" data-testid="qr-scanner" class="flex min-h-0 w-full max-w-md flex-1 flex-col items-center justify-center gap-3">
      <div :id="REGION_ID" ref="region" class="qr-region w-full max-w-full overflow-hidden rounded-xl border border-white/20 bg-black" />
      <p v-if="failed" data-testid="qr-scanner-error" class="text-center text-xs text-warn-dark">{{ t("collab.cameraDenied") }}</p>
      <p v-else class="text-center text-xs opacity-70">{{ t("collab.scanQr") }}</p>
    </div>
    <template #footer>
      <button type="button" class="rounded-lg border border-current/30 px-4 py-2 text-sm font-semibold transition hover:opacity-80" @click="close">
        {{ t("common.cancel") }}
      </button>
    </template>
  </OyaModal>
</template>

<style scoped>
.qr-region :deep(video) {
  display: block;
  width: 100% !important;
  height: auto !important;
}
</style>
