<script setup lang="ts">
// The card a modal is drawn on.
//
// OyaModal supplies the overlay, the centring and the close plumbing — but no
// SURFACE. Every call site was passing a bare `<div class="space-y-3">`, which
// means the dialog's contents float straight over the page: legible enough on a
// light background by accident, unreadable in dark mode, where the text sits on
// whatever happened to be behind it.
//
// One component rather than the same four classes pasted into every modal, so
// there is a single place that decides what a dialog looks like.
defineProps<{ title?: string; wide?: boolean }>();
</script>

<template>
  <div
    class="w-full space-y-3 rounded-xl border p-4 shadow-xl
           border-accent-2 bg-bubble-bg-light dark:border-accent-1 dark:bg-bubble-bg-dark"
    :class="wide ? 'max-w-lg' : 'max-w-sm'"
  >
    <p v-if="title" class="text-sm font-semibold">{{ title }}</p>
    <slot />
  </div>
</template>
