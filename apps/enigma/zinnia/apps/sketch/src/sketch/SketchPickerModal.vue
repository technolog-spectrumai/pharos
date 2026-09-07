<script setup lang="ts">
// One titled picker. The toolbar shows a compact control; the choices live in
// here, behind it.
//
// The title is not decoration. A row of bare swatches is unreadable about its
// own purpose — pen colour, fill colour and board colour all look identical as
// a grid of chips — so each picker says which of them it is choosing.
import { nextTick, ref, watch } from "vue";
import { OyaModal } from "petalite/primitives";

const props = defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);

// Focus the panel when it opens. Load-bearing, not politeness: Escape is
// handled on this element, and a keydown only reaches it when focus is inside.
// Left on the trigger, Escape falls through to the editor's window handler and
// clears the shape selection instead of closing the picker.
watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    await nextTick();
    panel.value?.focus();
  },
);
</script>

<template>
  <OyaModal :open="open" @close="emit('close')">
    <div
      ref="panel"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      class="w-full max-w-sm space-y-3 rounded-xl border p-4 shadow-xl outline-none
             border-accent-2 bg-bubble-bg-light dark:border-accent-1 dark:bg-bubble-bg-dark"
      @keydown.esc.stop.prevent="emit('close')"
    >
      <p class="text-sm font-semibold">{{ title }}</p>
      <slot />
      <div class="flex justify-end">
        <button
          type="button"
          data-testid="picker-close"
          class="rounded-lg border px-3 py-1.5 text-xs transition border-accent-2 hover:opacity-80 dark:border-accent-1"
          @click="emit('close')"
        >
          {{ $t("common.close") }}
        </button>
      </div>
    </div>
  </OyaModal>
</template>
