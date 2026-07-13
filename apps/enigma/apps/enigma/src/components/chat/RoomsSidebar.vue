<script setup lang="ts">
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";
import P2pCreateRoom from "./P2pCreateRoom.vue";
import P2pJoinRoom from "./P2pJoinRoom.vue";
import SavedRoomsList from "./SavedRoomsList.vue";

defineProps<{ channel: ChatChannel; controller: P2pRoomsController; scanning?: boolean }>();
defineEmits<{ "toggle-camera": [] }>();
</script>

<template>
  <div class="space-y-2.5">
    <P2pCreateRoom :controller="controller" />
    <P2pJoinRoom :controller="controller" :scanning="scanning" @toggle-camera="$emit('toggle-camera')" />
    <SavedRoomsList :channel="channel" />
  </div>
</template>
