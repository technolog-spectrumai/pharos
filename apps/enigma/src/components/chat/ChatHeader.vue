<script setup lang="ts">
import { OyaIconButton } from "rakotis";
import type { ChatChannel } from "rakotis";
import RoomStatusBar from "./RoomStatusBar.vue";

const props = defineProps<{ channel: ChatChannel }>();
defineEmits<{ "open-sidebar": [] }>();
const { currentRoom, isParticipant, roomLogo } = props.channel;
</script>

<template>
  <header class="flex flex-col gap-3 border-b border-current/10 p-4">
    <div class="flex items-start gap-3">
      <OyaIconButton icon="bars" :label="$t('chat.a11yOpenRooms')" class="lg:hidden" @click="$emit('open-sidebar')" />
      <!-- Captain-set room logo -->
      <img
        v-if="currentRoom && roomLogo"
        :src="roomLogo"
        :alt="$t('chat.a11yRoomLogo')"
        class="mt-1 h-10 w-10 shrink-0 rounded-lg object-cover"
      />
      <div class="min-w-0 flex-1">
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ currentRoom ? $t("chat.activeRoom") : $t("chat.noRoomSelected") }}
        </p>
        <h2 class="mt-1 break-words text-xl font-bold leading-tight sm:text-2xl">
          {{ currentRoom?.name ?? $t("chat.selectARoom") }}
        </h2>
        <div v-if="currentRoom" class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs opacity-70">
          <span>{{ $t("chat.participantCount", currentRoom.participant_count) }}</span>
          <span>{{ isParticipant ? $t("chat.joinedLabel") : $t("chat.observerLabel") }}</span>
        </div>
      </div>
    </div>

    <div v-if="currentRoom" class="hidden sm:flex">
      <RoomStatusBar :channel="channel" />
    </div>
  </header>
</template>
