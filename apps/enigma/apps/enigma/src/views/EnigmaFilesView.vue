<script setup lang="ts">
import FilePanel from "../components/chat/FilePanel.vue";

// darkMode is class-based (`.dark` on <html>); the prop only absorbs the
// fall-through attr App.vue passes to every routed view.
defineProps<{ darkMode?: boolean }>();
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <!-- P2P file transfer: offer a file to a peer of the active room, accept or
         decline incoming offers, watch transfer progress. -->
    <div class="min-h-0 flex-1">
      <FilePanel />
    </div>
  </div>
</template>
