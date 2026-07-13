<script setup lang="ts">
// Multi-line input. Root element is the <textarea> (keydown etc. fall through).
defineProps<{
  modelValue: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [string] }>();
</script>

<template>
  <textarea
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows || 1"
    :disabled="disabled"
    class="w-full resize-none rounded-lg border px-3 py-2 outline-none transition bg-primary-bg-light dark:bg-primary-bg-dark border-accent-2 dark:border-accent-1 text-text-main-light dark:text-text-main-dark placeholder:text-text-main-light/30 dark:placeholder:text-text-main-dark/30 disabled:opacity-30"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
</template>
