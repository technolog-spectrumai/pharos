<script setup lang="ts">
// Renders a QR code for `value`. Owns the lazy `qrcode` import + toDataURL.
//
// `size` is the DESKTOP cap, not a fixed width. A QR only works if the other
// device's camera can resolve the modules, and a 176px code on a phone is
// exactly the case that fails — so below `lg` the image takes the width it is
// given (up to a readable ceiling) and only caps at `size` on a wide screen.
//
// The bitmap is always generated at RENDER_PX, independent of display size:
// generating at the CSS size and then scaling up is what makes a phone-width
// code blurry, which costs more scans than being small does.
import { ref, watch } from "vue";
const props = defineProps<{
  value: string;
  /** Max rendered width on desktop (>= lg). Ignored on phones/tablets. */
  size?: number;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  margin?: number;
  alt?: string;
}>();

/** Generation resolution — comfortably above any display size we allow. */
const RENDER_PX = 640;

const dataUrl = ref("");
watch(
  () => props.value,
  async (val) => {
    if (!val) {
      dataUrl.value = "";
      return;
    }
    try {
      const { toDataURL } = await import("qrcode");
      dataUrl.value = await toDataURL(val, {
        errorCorrectionLevel: props.errorCorrectionLevel || "L",
        margin: props.margin ?? 1,
        width: RENDER_PX,
      });
    } catch {
      dataUrl.value = "";
    }
  },
  { immediate: true },
);
</script>

<template>
  <img
    v-if="dataUrl"
    :src="dataUrl"
    :alt="alt || 'QR code'"
    :style="{ '--qr-cap': (size || 240) + 'px' }"
    class="mx-auto aspect-square w-full max-w-[min(92vw,26rem)] rounded-lg bg-white p-2 lg:max-w-[var(--qr-cap)]"
  />
</template>
