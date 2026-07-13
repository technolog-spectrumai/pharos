<script setup lang="ts">
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";
import RoomListRow from "./RoomListRow.vue";

const props = defineProps<{ channel: ChatChannel; controller: P2pRoomsController }>();
const ch = props.channel;
const { p2pRooms, currentRoom } = ch;
</script>

<template>
  <div v-if="p2pRooms.length" class="space-y-1 pt-1">
    <p class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t("chat.savedRooms") }}</p>
    <RoomListRow
      v-for="r in p2pRooms"
      :key="r.room"
      :room="r"
      :active="currentRoom?.slug === r.room"
      :controller="controller"
      @open="ch.openP2pRoom(r)"
    />
  </div>
</template>
