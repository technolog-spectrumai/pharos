<script setup lang="ts">
// Oya surface/card. Dark mode via the `.dark` class.
defineProps<{ padded?: boolean }>();
</script>

<template>
  <section
    :class="padded !== false ? 'p-4' : 'px-2 pt-4 pb-2'"
    class="rounded-lg border shadow-md transition-colors duration-300 border-accent-2 dark:border-accent-1 bg-bubble-bg-light dark:bg-bubble-bg-dark"
  >
    <slot />
  </section>
</template>
