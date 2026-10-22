<script setup lang="ts">
import { OyaButton } from "rakotis";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";
import SavedRoomsList from "./SavedRoomsList.vue";

const props = defineProps<{ channel: ChatChannel; controller: P2pRoomsController }>();
</script>

<template>
  <div class="space-y-2.5">
    <div class="grid grid-cols-2 gap-2">
      <OyaButton class="justify-center" @click="props.controller.openCreate()">
        <font-awesome-icon icon="circle-nodes" />{{ $t("chat.newChat") }}
      </OyaButton>
      <OyaButton variant="secondary" class="justify-center" @click="props.controller.openJoin()">
        <font-awesome-icon icon="right-to-bracket" />{{ $t("chat.joinChat") }}
      </OyaButton>
    </div>
    <SavedRoomsList :channel="channel" :controller="controller" />
  </div>
</template>
