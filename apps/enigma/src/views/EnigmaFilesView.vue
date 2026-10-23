<script setup lang="ts">
import FilePanel from "../components/chat/FilePanel.vue";

// Files is peer-to-peer transfer: offer a file to a peer of the active room,
// accept or decline incoming offers, watch transfer progress. Enigma26 stores
// nothing off-device. Local file encryption and the key ring were removed on
// 2026-10-23 (README.md, "Removed features").
defineProps<{ darkMode?: boolean }>();
</script>

<template>
  <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <!-- Fills <main> exactly; the panel scrolls inside. A flex COLUMN, not a
         bare block: FilePanel sizes itself with `flex-1 min-h-0` + its own
         `overflow-y-auto`, which a display:block wrapper silently ignores. -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <FilePanel />
    </div>
  </div>
</template>
