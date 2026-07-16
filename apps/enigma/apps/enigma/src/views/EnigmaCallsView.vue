<script setup lang="ts">
import VoxPanel from "../components/vox/VoxPanel.vue";

// darkMode is class-based (`.dark` on <html>); the prop drives the few non-Oya
// class bindings inside the panel (avatar bubble, equalizer bars).
defineProps<{ darkMode?: boolean }>();
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col overflow-hidden">
    <VoxPanel :dark-mode="!!darkMode" />
  </div>
</template>
