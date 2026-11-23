<script setup lang="ts">
// The app's one menu (☰ in the app bar, phones and tablets): a dropdown that
// unfolds downwards under the bar. Its contents (AppDrawerBody) mount only
// while it is open.
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
    enter-active-class="transition-all duration-200 ease-out"
    enter-from-class="opacity-0 -translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition-all duration-150 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 -translate-y-2"
  >
    <div
      v-if="drawerOpen"
      class="max-h-[75dvh] overflow-y-auto border-t lg:hidden bg-header-bg-light border-accent-2 dark:bg-header-bg-dark dark:border-accent-1"
      data-testid="app-drawer"
    >
      <AppDrawerBody :dark-mode="darkMode" @update:dark-mode="emit('update:darkMode', $event)" />
    </div>
  </Transition>
</template>
