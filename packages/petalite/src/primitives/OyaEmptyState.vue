<script setup lang="ts">
// Centered empty/placeholder block: optional icon, message (default slot), optional action.
defineProps<{ icon?: string; size?: "sm" | "lg" }>();
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 opacity-40">
    <font-awesome-icon v-if="icon" :icon="icon" :class="size === 'lg' ? 'text-4xl' : 'text-xl'" />
    <div class="text-center text-sm"><slot /></div>
    <slot name="action" />
  </div>
</template>
