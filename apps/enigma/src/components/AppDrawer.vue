<script setup lang="ts">
// The app's one menu (☰ in the app bar, phones and tablets), sliding in from
// the right. Its contents (AppDrawerBody) mount only while it is open.
import { watch } from "vue";
import { useRoute } from "vue-router";
import { drawerOpen } from "../stores/ui";
import AppDrawerBody from "./AppDrawerBody.vue";

defineProps<{ darkMode: boolean }>();
const emit = defineEmits<{ "update:darkMode": [boolean] }>();
const route = useRoute();
// Any navigation closes it.
watch(() => route.fullPath, () => (drawerOpen.value = false));
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-200"
    enter-from-class="opacity-0"
    leave-active-class="transition-opacity duration-200"
    leave-to-class="opacity-0"
  >
    <div v-if="drawerOpen" class="fixed inset-0 z-[55] bg-black/40 lg:hidden" @click="drawerOpen = false" />
  </Transition>

  <Transition
    enter-active-class="transition-transform duration-200"
    enter-from-class="translate-x-full"
    leave-active-class="transition-transform duration-200"
    leave-to-class="translate-x-full"
  >
    <aside
      v-if="drawerOpen"
      class="fixed inset-y-0 right-0 z-[56] flex w-80 max-w-[88vw] flex-col overflow-y-auto border-l p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl lg:hidden bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1"
      data-testid="app-drawer"
    >
      <AppDrawerBody :dark-mode="darkMode" @update:dark-mode="emit('update:darkMode', $event)" />
    </aside>
  </Transition>
</template>
