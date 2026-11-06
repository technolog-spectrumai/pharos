<script setup lang="ts">
// Rooms, as a dialog: what the phone's ☰ opens (no side slider). The same list
// the desktop shows on the left; picking a room closes it.
import { watch } from "vue";
import { OyaButton, OyaModal } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";
import RoomsSidebar from "./RoomsSidebar.vue";

const props = defineProps<{ open: boolean; channel: ChatChannel; controller: P2pRoomsController }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

function close() {
  emit("update:open", false);
}
watch(
  () => props.channel.currentRoom.value?.slug,
  (now, before) => {
    if (props.open && now && now !== before) close();
  },
);
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div
      class="max-h-[85dvh] w-[min(32rem,92vw)] space-y-4 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      data-testid="rooms-modal"
    >
      <h2 class="flex items-center gap-2 text-lg font-bold"><font-awesome-icon icon="comments" />{{ $t("chat.roomsTitle") }}</h2>
      <RoomsSidebar :channel="channel" :controller="controller" />
      <p v-if="channel.p2pRooms.value.length === 0" class="text-sm opacity-60" data-testid="rooms-empty">{{ $t("chat.roomsEmpty") }}</p>
      <div class="flex justify-end">
        <OyaButton type="button" @click="close">{{ $t("chat.close") }}</OyaButton>
      </div>
    </div>
  </OyaModal>
</template>
