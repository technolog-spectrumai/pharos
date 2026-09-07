<script setup lang="ts">
// Square, bordered icon button. Pass `icon` (Font Awesome name, registered app-side)
// or a custom glyph via the default slot. Native events fall through to <button>.
defineProps<{
  icon?: string;
  size?: "sm" | "md" | "lg";
  label?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  active?: boolean;
}>();

const sizeClass: Record<string, string> = {
  sm: "h-9 w-9",
  md: "h-10 w-10",
  lg: "h-11 w-11",
};
</script>

<template>
  <button
    :type="type || 'button'"
    :disabled="disabled"
    :aria-label="label"
    :title="label"
    :class="[
      sizeClass[size || 'md'],
      active ? 'bg-primary-bg-light dark:bg-primary-bg-dark' : '',
      disabled ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80',
    ]"
    class="inline-flex shrink-0 items-center justify-center rounded-lg border transition border-accent-2 dark:border-accent-1"
  >
    <slot><font-awesome-icon v-if="icon" :icon="icon" /></slot>
  </button>
</template>
