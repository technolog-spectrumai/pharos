<script setup lang="ts">
import type { P2pRoomEntry } from "rakotis";
defineProps<{ room: P2pRoomEntry; active?: boolean }>();
</script>

<template>
  <button
    :class="
      active
        ? 'bg-primary-bg-light border-accent-light dark:bg-primary-bg-dark dark:border-accent-dark'
        : 'border-current/15 hover:opacity-80'
    "
    class="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition"
  >
    <font-awesome-icon icon="circle-nodes" class="shrink-0 opacity-60" />
    <span class="min-w-0 flex-1 truncate">{{ room.name }}</span>
  </button>
</template>
