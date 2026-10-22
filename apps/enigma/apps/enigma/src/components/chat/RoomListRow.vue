<script setup lang="ts">
import { OyaIconButton } from "rakotis";
import type { P2pRoomEntry } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

defineProps<{ room: P2pRoomEntry; active?: boolean; controller: P2pRoomsController }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <div
    :class="
      active
        ? 'bg-primary-bg-light border-accent-light dark:bg-primary-bg-dark dark:border-accent-dark'
        : 'border-current/15'
    "
    class="flex w-full items-center gap-1 rounded-lg border px-1.5 py-1 text-sm transition"
  >
    <button
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left transition hover:opacity-80"
      @click="emit('open')"
    >
      <!-- Captain-set room logo, else the generic room glyph -->
      <img v-if="room.logo" :src="room.logo" alt="" class="h-5 w-5 shrink-0 rounded object-cover" />
      <font-awesome-icon v-else icon="circle-nodes" class="shrink-0 opacity-60" />
      <span class="min-w-0 flex-1 truncate">{{ room.name }}</span>
    </button>
    <OyaIconButton
      icon="qrcode"
      size="sm"
      :label="$t('chat.showInfo')"
      class="h-7 w-7 border-transparent opacity-60 hover:opacity-100"
      @click="controller.openInfo(room)"
    />
    <OyaIconButton
      icon="trash"
      size="sm"
      :label="$t('chat.deleteRoom')"
      class="h-7 w-7 border-transparent opacity-60 hover:text-warn-dark hover:opacity-100"
      @click="controller.openDeleteConfirm(room)"
    />
  </div>
</template>
