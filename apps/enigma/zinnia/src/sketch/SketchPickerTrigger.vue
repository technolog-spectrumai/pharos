<script setup lang="ts">
// The closed picker: a select-box-shaped button that shows the current value
// and opens the modal.
//
// It shows the VALUE, not just a name — the chip, the size, the percentage —
// because the whole point of collapsing five rows into five controls is that
// the toolbar still has to answer "what am I drawing with?" at a glance.
//
// `aria-expanded`, never `aria-pressed`: the palette pencil inside the pen
// picker is the one genuine toggle in this toolbar, and it is addressed by
// `aria-pressed`. A trigger carrying the same attribute would answer that
// query first.
defineProps<{ label: string; open?: boolean }>();
</script>

<template>
  <button
    type="button"
    class="flex h-9 items-center gap-1.5 rounded-lg border px-2 text-xs transition
           border-accent-2 hover:opacity-80 dark:border-accent-1"
    :class="open && 'border-accent-light dark:border-accent-dark'"
    :title="label"
    :aria-label="label"
    aria-haspopup="dialog"
    :aria-expanded="open ?? false"
  >
    <slot />
    <font-awesome-icon icon="chevron-down" class="text-[10px] opacity-60" />
  </button>
</template>
