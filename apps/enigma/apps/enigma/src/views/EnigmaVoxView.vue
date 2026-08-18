<script setup lang="ts">
import VoxPanel from "../components/vox/VoxPanel.vue";

// darkMode is class-based (`.dark` on <html>); the prop drives the few non-Oya
// class bindings inside the panel (avatar bubble, equalizer bars).
defineProps<{ darkMode?: boolean }>();
</script>

<template>
  <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden">
    <!-- Fills <main> exactly; the panel inside scrolls when a call card outgrows it. -->
    <VoxPanel :dark-mode="!!darkMode" />
  </div>
</template>
