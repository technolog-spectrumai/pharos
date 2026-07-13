<script setup lang="ts">
import type { ChatChannel } from "rakotis";
import RoomListRow from "./RoomListRow.vue";

const props = defineProps<{ channel: ChatChannel }>();
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
      @click="ch.openP2pRoom(r)"
    />
  </div>
</template>
