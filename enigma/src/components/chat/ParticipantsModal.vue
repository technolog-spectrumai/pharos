<script setup lang="ts">
// The open room's participants, as a dialog from the chat header (on a phone and
// a desktop alike), with joining or leaving the room.
import { ref } from "vue";
import { OyaButton, OyaModal } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import ParticipantsPanel from "./ParticipantsPanel.vue";

const props = defineProps<{ open: boolean; channel: ChatChannel }>();
const emit = defineEmits<{ "update:open": [boolean] }>();
const ch = props.channel;
const { currentRoom, isParticipant, participants } = ch;

const busy = ref(false);
async function run(f: () => Promise<unknown>) {
  busy.value = true;
  try {
    await f();
  } finally {
    busy.value = false;
  }
}
function close() {
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div
      class="max-h-[85dvh] w-[min(32rem,92vw)] space-y-4 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      data-testid="participants-modal"
    >
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="users" />{{ $t("chat.participantsTitle") }}
        <span class="text-sm font-normal opacity-60" data-testid="participants-count">{{ participants.length }}</span>
      </h2>
      <ParticipantsPanel :channel="channel" />
      <div class="flex flex-wrap justify-end gap-2">
        <template v-if="currentRoom">
          <OyaButton
            v-if="!isParticipant"
            type="button"
            :class="{ 'pointer-events-none opacity-60': busy }"
            data-testid="join-room"
            @click="run(() => ch.joinParticipant())"
          >
            <font-awesome-icon icon="right-to-bracket" />{{ $t("chat.joinRoom") }}
          </OyaButton>
          <OyaButton
            v-else
            type="button"
            variant="secondary"
            :class="{ 'pointer-events-none opacity-60': busy }"
            data-testid="leave-room"
            @click="run(() => ch.leaveParticipant())"
          >
            <font-awesome-icon icon="right-from-bracket" />{{ $t("chat.leaveRoom") }}
          </OyaButton>
        </template>
        <OyaButton type="button" @click="close">{{ $t("chat.close") }}</OyaButton>
      </div>
    </div>
  </OyaModal>
</template>
