<script setup lang="ts">
// Single-line input. Root element is the <input>, so extra listeners/attrs fall through.
defineProps<{
  modelValue: string;
  type?: string;
  placeholder?: string;
  maxlength?: number;
  readonly?: boolean;
  disabled?: boolean;
  mono?: boolean;
  size?: "sm" | "md";
}>();
const emit = defineEmits<{
  "update:modelValue": [string];
  enter: [];
}>();
</script>

<template>
  <input
    :type="type || 'text'"
    :value="modelValue"
    :placeholder="placeholder"
    :maxlength="maxlength"
    :readonly="readonly"
    :disabled="disabled"
    :class="[size === 'sm' ? 'px-2 py-1.5 text-sm' : 'px-3 py-2', mono ? 'font-mono' : '']"
    class="w-full rounded-lg border outline-none transition bg-primary-bg-light dark:bg-primary-bg-dark border-accent-2 dark:border-accent-1 text-text-main-light dark:text-text-main-dark placeholder:text-text-main-light/30 dark:placeholder:text-text-main-dark/30 disabled:opacity-30"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    @keyup.enter="emit('enter')"
  />
</template>
