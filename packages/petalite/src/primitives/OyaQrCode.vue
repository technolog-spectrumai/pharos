<script setup lang="ts">
// Renders a QR code for `value`. Owns the lazy `qrcode` import + toDataURL generation.
import { ref, watch } from "vue";
const props = defineProps<{
  value: string;
  size?: number;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  margin?: number;
  alt?: string;
}>();

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
        width: props.size || 240,
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
    :style="{ width: (size || 240) + 'px', height: (size || 240) + 'px' }"
    class="mx-auto rounded-lg bg-white p-2"
  />
</template>
