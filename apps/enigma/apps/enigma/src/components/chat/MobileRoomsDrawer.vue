<script setup lang="ts">
import { ref } from "vue";
import { OyaButton, OyaIconButton } from "rakotis";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";
import RoomsSidebar from "./RoomsSidebar.vue";
import ParticipantsPanel from "./ParticipantsPanel.vue";

const props = defineProps<{
  open: boolean;
  channel: ChatChannel;
  controller: P2pRoomsController;
}>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const ch = props.channel;
const { currentRoom, isParticipant, participants } = ch;

const busy = ref(false);
async function join() {
  busy.value = true;
  try {
    await ch.joinParticipant();
  } finally {
    busy.value = false;
  }
}
async function leave() {
  busy.value = true;
  try {
    await ch.leaveParticipant();
  } finally {
    busy.value = false;
  }
}
function close() {
  emit("update:open", false);
}
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-200"
    enter-from-class="opacity-0"
    leave-active-class="transition-opacity duration-200"
    leave-to-class="opacity-0"
  >
    <div v-if="open" class="fixed inset-0 z-40 bg-black/40 lg:hidden" @click="close" />
  </Transition>

  <Transition
    enter-active-class="transition-transform duration-200"
    enter-from-class="-translate-x-full"
    leave-active-class="transition-transform duration-200"
    leave-to-class="-translate-x-full"
  >
    <aside
      v-if="open"
      class="fixed inset-y-0 left-0 z-50 flex w-72 flex-col overflow-y-auto border-r p-4 shadow-xl lg:hidden bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1"
    >
      <div class="flex items-center justify-between border-b border-current/10 pb-3">
        <span class="text-sm font-bold">Rooms</span>
        <OyaIconButton icon="xmark" size="sm" label="Close rooms" @click="close" />
      </div>

      <div class="mt-4">
        <RoomsSidebar :channel="channel" :controller="controller" />
      </div>

      <div class="mt-4 border-t border-current/10 pt-4">
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold">Participants</span>
          <span class="text-xs opacity-60">{{ participants.length }}</span>
        </div>
        <div class="mt-3">
          <ParticipantsPanel :channel="channel" compact />
        </div>
      </div>

      <div v-if="currentRoom" class="mt-4 border-t border-current/10 pt-4">
        <OyaButton
          v-if="!isParticipant"
          :class="{ 'opacity-60 pointer-events-none': busy }"
          class="w-full"
          @click="join"
        >
          <font-awesome-icon icon="right-to-bracket" />Join Room
        </OyaButton>
        <OyaButton
          v-else
          variant="secondary"
          :class="{ 'opacity-60 pointer-events-none': busy }"
          class="w-full"
          @click="leave"
        >
          <font-awesome-icon icon="right-from-bracket" />Leave Room
        </OyaButton>
      </div>
    </aside>
  </Transition>
</template>
