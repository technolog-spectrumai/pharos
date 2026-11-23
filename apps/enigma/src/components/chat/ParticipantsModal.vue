<script setup lang="ts">
// Who is in the open room, and who is linked right now (room menu ⋮ → Participants).
import { OyaModal } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import ParticipantsPanel from "./ParticipantsPanel.vue";

const props = defineProps<{ open: boolean; channel: ChatChannel }>();
const emit = defineEmits<{ "update:open": [boolean] }>();
const { participants } = props.channel;
</script>

<template>
  <OyaModal :open="open" @close="emit('update:open', false)">
    <div class="max-h-[80dvh] w-full max-w-sm space-y-4 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark" data-testid="participants-modal">
      <div class="flex items-center justify-between">
        <p class="text-lg font-bold">{{ $t("chat.participants") }}</p>
        <span class="text-sm opacity-60">{{ participants.length }}</span>
      </div>
      <ParticipantsPanel :channel="channel" />
    </div>
    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        @click="emit('update:open', false)"
      >
        {{ $t("chat.close") }}
      </button>
    </template>
  </OyaModal>
</template>
