<script setup lang="ts">
import { ref } from "vue";
import { OyaButton } from "petalite/primitives";
import type { ChatChannel } from "rakotis";

const props = defineProps<{ channel: ChatChannel }>();
const busy = ref(false);
async function join() {
  busy.value = true;
  try {
    await props.channel.joinParticipant();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="border-b px-4 py-3 bg-primary-bg-light border-accent-2 dark:bg-primary-bg-dark dark:border-accent-1">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm opacity-75">You are observing. Join this room to send encrypted messages.</p>
      <OyaButton :class="{ 'opacity-60 pointer-events-none': busy }" class="shrink-0" @click="join">
        <font-awesome-icon icon="right-to-bracket" />Join Room
      </OyaButton>
    </div>
  </div>
</template>
