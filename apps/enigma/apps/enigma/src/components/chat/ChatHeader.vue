<script setup lang="ts">
import { OyaIconButton } from "rakotis";
import type { ChatChannel } from "rakotis";
import RoomStatusBar from "./RoomStatusBar.vue";

const props = defineProps<{ channel: ChatChannel }>();
defineEmits<{ "open-sidebar": []; "open-files": [] }>();
const { currentRoom, isParticipant } = props.channel;
</script>

<template>
  <header class="flex flex-col gap-3 border-b border-current/10 p-4">
    <div class="flex items-start gap-3">
      <OyaIconButton icon="bars" label="Open rooms" class="lg:hidden" @click="$emit('open-sidebar')" />
      <div class="min-w-0 flex-1">
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ currentRoom ? "Active room" : "No room selected" }}
        </p>
        <h2 class="mt-1 break-words text-xl font-bold leading-tight sm:text-2xl">
          {{ currentRoom?.name ?? "Select a room" }}
        </h2>
        <div v-if="currentRoom" class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs opacity-70">
          <span>{{ currentRoom.participant_count }} participant{{ currentRoom.participant_count === 1 ? "" : "s" }}</span>
          <span>{{ isParticipant ? "Joined" : "Observer" }}</span>
        </div>
      </div>
      <OyaIconButton
        v-if="currentRoom && isParticipant"
        icon="file-arrow-up"
        :label="$t('fileShare.title')"
        :title="$t('fileShare.title')"
        @click="$emit('open-files')"
      />
    </div>

    <div v-if="currentRoom" class="hidden sm:flex">
      <RoomStatusBar :channel="channel" />
    </div>
  </header>
</template>
