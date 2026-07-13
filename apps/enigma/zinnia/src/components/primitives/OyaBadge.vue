<script setup lang="ts">
// Small status/label chip. `tone` picks a semantic, theme-aware palette.
defineProps<{
  tone?: "neutral" | "success" | "warn" | "muted" | "pulse";
  icon?: string;
  size?: "sm" | "md";
  title?: string;
}>();

const toneClass: Record<string, string> = {
  neutral: "border-current/20",
  success:
    "border-success-light dark:border-success-dark bg-success-light dark:bg-success-dark text-primary-bg-light dark:text-primary-bg-dark",
  warn: "border-warn-light dark:border-warn-dark bg-warn-light dark:bg-warn-dark text-primary-bg-light dark:text-primary-bg-dark",
  muted: "border-current/20 opacity-60",
  pulse: "border-current/20 animate-pulse",
};
</script>

<template>
  <span
    :title="title"
    :class="[toneClass[tone || 'neutral'], size === 'md' ? 'px-3 py-2' : 'px-2.5 py-1.5']"
    class="inline-flex items-center gap-2 rounded-lg border text-xs font-bold shadow-sm transition"
  >
    <font-awesome-icon v-if="icon" :icon="icon" />
    <slot />
  </span>
</template>
