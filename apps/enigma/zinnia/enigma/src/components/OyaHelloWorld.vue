<script setup lang="ts">
import { ref } from "vue";
import EnigmaWelcomeView from "./EnigmaWelcomeView.vue";
import EnigmaChatView from "./EnigmaChatView.vue";

defineProps<{
  darkMode: boolean;
}>();

const activeView = ref<"welcome" | "chat">("welcome");
</script>

<template>
  <EnigmaWelcomeView
    v-if="activeView === 'welcome'"
    :dark-mode="darkMode"
    @open-chat="activeView = 'chat'"
  />

  <EnigmaChatView
    v-else
    :dark-mode="darkMode"
    @back="activeView = 'welcome'"
  />
</template>