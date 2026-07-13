<script setup lang="ts">
// Read-only value + a copy button that shows a ✓ tick for 1.5s. Owns the clipboard
// write + tick state so call sites don't re-implement it.
import { ref } from "vue";
const props = defineProps<{ value: string; mono?: boolean; copyLabel?: string }>();
const emit = defineEmits<{ copied: [] }>();

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    emit("copied");
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<template>
  <div class="flex items-center gap-2">
    <input
      :value="value"
      readonly
      :class="mono ? 'font-mono' : ''"
      class="min-w-0 flex-1 rounded-lg border border-current/15 bg-transparent px-2 py-1.5 text-xs outline-none"
    />
    <button
      type="button"
      class="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition hover:opacity-80 border-accent-2 dark:border-accent-1"
      @click="copy"
    >
      {{ copied ? "✓" : copyLabel || "Copy" }}
    </button>
  </div>
</template>
