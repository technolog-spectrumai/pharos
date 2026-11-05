<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { OyaButton, OyaEmptyState } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import ChatBubble from "../ChatBubble.vue";

const props = defineProps<{ channel: ChatChannel }>();
defineEmits<{ "open-sidebar": [] }>();
const { currentRoom, messages } = props.channel;

const el = ref<HTMLElement | null>(null);
function scrollToBottom() {
  nextTick(() => {
    if (el.value) el.value.scrollTop = el.value.scrollHeight;
  });
}
watch(messages, scrollToBottom, { deep: true });
</script>

<template>
  <div ref="el" class="min-h-0 space-y-4 overflow-y-auto p-4 bg-primary-bg-light dark:bg-primary-bg-dark">
    <OyaEmptyState v-if="!currentRoom" icon="comments" size="lg" class="h-full">
      {{ $t("chat.emptyHint") }}
      <template #action>
        <OyaButton class="mt-2 lg:hidden" @click="$emit('open-sidebar')">Select a room</OyaButton>
      </template>
    </OyaEmptyState>
    <ChatBubble v-for="msg in messages" :key="msg.id" :message="msg" />
  </div>
</template>
