<script setup lang="ts">
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";
import SavedRoomsList from "./SavedRoomsList.vue";

defineProps<{ channel: ChatChannel; controller: P2pRoomsController }>();
</script>

<template>
  <div class="space-y-2.5">
    <!-- New chat / Join a chat live in the chat header and open as dialogs. -->
    <SavedRoomsList :channel="channel" :controller="controller" />
  </div>
</template>
