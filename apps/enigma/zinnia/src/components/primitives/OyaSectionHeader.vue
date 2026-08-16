<script setup lang="ts">
// Section header: uppercase eyebrow + title + hint, with an optional #actions slot.
defineProps<{
  eyebrow?: string;
  title?: string;
  hint?: string;
  icon?: string;
  tone?: "accent" | "muted";
  as?: "h1" | "h2" | "p";
}>();
</script>

<template>
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <p
        v-if="eyebrow"
        :class="tone === 'accent' ? 'text-accent-light dark:text-accent-dark' : 'opacity-60'"
        class="text-xs font-semibold uppercase tracking-wide"
      >
        {{ eyebrow }}
      </p>
      <component
        :is="as || 'h2'"
        v-if="title"
        :class="tone === 'accent' ? 'text-accent-light dark:text-accent-dark' : ''"
        class="font-bold"
      >
        <font-awesome-icon v-if="icon" :icon="icon" class="mr-2" />{{ title }}
      </component>
      <slot />
      <p v-if="hint" class="mt-1 text-sm opacity-60">{{ hint }}</p>
    </div>
    <div v-if="$slots.actions" class="shrink-0"><slot name="actions" /></div>
  </div>
</template>
