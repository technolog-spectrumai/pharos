<script setup lang="ts">
// Centered overlay modal (teleported to <body>) with backdrop + click-outside close.
defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean]; close: [] }>();
function close() {
  emit("update:open", false);
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/70 p-6 text-text-main-light dark:text-text-main-dark"
        @click.self="close"
      >
        <slot />
        <div v-if="$slots.footer"><slot name="footer" /></div>
      </div>
    </Transition>
  </Teleport>
</template>
