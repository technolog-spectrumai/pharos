<script setup lang="ts">
import { watch, nextTick, onUnmounted } from "vue";
import { OyaModal } from "rakotis";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean]; decoded: [string] }>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scanner: any = null;

async function start() {
  await nextTick();
  try {
    const { Html5Qrcode } = await import("html5-qrcode");
    scanner = new Html5Qrcode("p2p-qr-region");
    await scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 220, height: 220 } },
      (decoded: string) => {
        emit("decoded", decoded.trim());
        void stop();
      },
      () => {},
    );
  } catch {
    void stop();
  }
}
async function stop() {
  if (scanner) {
    try {
      await scanner.stop();
    } catch {
      /* ignore */
    }
    scanner = null;
  }
  emit("update:open", false);
}

watch(
  () => props.open,
  (o) => {
    if (o) void start();
    else void stop();
  },
);
onUnmounted(() => void stop());
</script>

<template>
  <OyaModal :open="open" @close="stop">
    <div id="p2p-qr-region" class="w-full max-w-sm overflow-hidden rounded-xl border border-white/20 bg-black"></div>
    <template #footer>
      <button
        class="rounded-lg border border-white/30 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-80"
        @click="stop"
      >
        {{ $t("common.cancel") }}
      </button>
    </template>
  </OyaModal>
</template>
