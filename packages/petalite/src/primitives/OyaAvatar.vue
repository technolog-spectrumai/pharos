<script setup lang="ts">
// Avatar tile: shows `src` image, else derives initials from `name` (or explicit `initials`).
import { computed } from "vue";
const props = defineProps<{
  name: string;
  src?: string | null;
  size?: "sm" | "md";
  initials?: string;
  muted?: boolean;
}>();
const derived = computed(() => props.initials || (props.name || "?").slice(0, 2).toUpperCase());
</script>

<template>
  <div
    :class="[
      size === 'sm' ? 'h-8 w-8' : 'h-10 w-10',
      muted ? 'border-current/20 opacity-50' : 'border-accent-2 dark:border-accent-1',
    ]"
    class="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border text-xs font-bold"
  >
    <img v-if="src" :src="src" :alt="name" class="h-full w-full object-cover" />
    <span v-else>{{ derived }}</span>
  </div>
</template>
