<script setup lang="ts">
// Full-screen camera QR scanner (join a room, link a device).
//
// Two things this has to get right, both of which used to be broken on a phone:
//
//  • Stacking. It is opened from INSIDE another modal (the join window), and every
//    OyaModal teleports to <body>, so the sibling that mounted last paints on top
//    regardless of which one opened last — the join modal's backdrop and its opaque
//    card sat over the live feed. It now claims its own layer (SCANNER_Z: above the
//    modal layer and the idle-lock toast, below the vault gate) AND callers close
//    whatever modal launched it (see ChatPanel), so the two can never share a screen.
//
//  • Sizing. html5-qrcode renders the <video> at the container's clientWidth at
//    start() time and derives its height from the stream, so a container that isn't
//    measured against the visible viewport quietly runs off the bottom of the modal.
//    The viewfinder is sized from the frame's real box (OyaModal measures 100dvh —
//    NOT 100vh, which counts the mobile URL bar — minus the safe-area insets), width
//    capped so even a 3:4 portrait stream stays inside it. The scan box is a fraction
//    of the viewfinder rather than a fixed 220 px: html5-qrcode REJECTS a qrbox
//    larger than the rendered video, and on a narrow phone that rejection is a camera
//    that never opens at all.
import { ref, watch, nextTick, onUnmounted } from "vue";
import { OyaModal } from "rakotis";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean]; decoded: [string] }>();

/** Above the modal layer (60) + the idle-lock toast (70), below the vault gate (80). */
const SCANNER_Z = 75;
const REGION_ID = "p2p-qr-region";
/** html5-qrcode refuses a scan box under 50 px; stay clear of the floor. */
const MIN_EDGE = 160;

const frame = ref<HTMLElement | null>(null);
const region = ref<HTMLElement | null>(null);
const failed = ref(false); // camera denied/unavailable → say so instead of closing

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scanner: any = null;

// Widest viewfinder that still fits the frame vertically. Phone rear cameras report
// up to 3:4 (w:h) in portrait, so budgeting height = width / 0.75 is what keeps the
// feed clear of the footer, the app header and the mobile nav drawer instead of
// being clipped by them.
function sizeRegion() {
  const box = frame.value;
  const el = region.value;
  if (!box || !el) return;
  const rect = box.getBoundingClientRect();
  // Not laid out yet (or jsdom): leave the w-full default rather than pinning 0 px.
  if (rect.width < 1 || rect.height < 1) {
    el.style.removeProperty("width");
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
        // Relative to the viewfinder, never a fixed pixel box (see the header note).
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

// Tear the camera down without touching the open state. The handle is dropped
// BEFORE awaiting: a decode closes the sheet from two sides at once (this
// component + the parent flipping `open`), and a second stop() on an already
// stopping scanner is an error html5-qrcode throws at us.
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

/** Dismiss: stop the camera and hand the screen back to whoever opened us. */
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
  <OyaModal :open="open" :z="SCANNER_Z" @close="close">
    <div
      ref="frame"
      data-testid="qr-scanner-modal"
      class="flex min-h-0 w-full max-w-md flex-1 flex-col items-center justify-center gap-3"
    >
      <div
        :id="REGION_ID"
        ref="region"
        data-testid="qr-scanner-region"
        class="qr-region w-full max-w-full overflow-hidden rounded-xl border border-white/20 bg-black"
      ></div>
      <!-- A denied/absent camera used to close the sheet on the spot, which read as
           "the button does nothing"; say what happened and let the user dismiss. -->
      <p v-if="failed" data-testid="qr-scanner-error" class="text-center text-xs text-warn-dark">
        {{ $t("chat.cameraDenied") }}
      </p>
      <p v-else class="text-center text-xs text-white/70">{{ $t("chat.scanQr") }}</p>
    </div>
    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-white/30 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-80"
        @click="close"
      >
        {{ $t("common.cancel") }}
      </button>
    </template>
  </OyaModal>
</template>

<style scoped>
/* html5-qrcode injects the <video> itself with an inline px width taken at start()
   time — :deep + !important is the only way to keep it following the box (and the
   only reason the feed survives an orientation change). height stays `auto` on
   purpose: the library maps the decode crop with independent width/height ratios,
   so anything that scales the picture non-uniformly (object-fit: cover/contain)
   would silently decode the wrong region. */
.qr-region :deep(video) {
  display: block;
  width: 100% !important;
  height: auto !important;
}
</style>
