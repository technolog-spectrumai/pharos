<script setup lang="ts">
// Oya primary/secondary button. Dark mode via the `.dark` class (no darkMode prop).
defineProps<{
  variant?: "primary" | "secondary";
  type?: "button" | "submit" | "reset";
}>();
</script>

<template>
  <button
    :type="type || 'button'"
    :class="
      variant === 'secondary'
        ? 'border-accent-2 dark:border-accent-1 bg-bubble-bg-light dark:bg-bubble-bg-dark text-text-main-light dark:text-text-main-dark'
        : 'bg-accent-light dark:bg-accent-dark text-primary-bg-light dark:text-primary-bg-dark'
    "
    class="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold shadow-sm transition hover:opacity-90"
  >
    <slot />
  </button>
</template>
