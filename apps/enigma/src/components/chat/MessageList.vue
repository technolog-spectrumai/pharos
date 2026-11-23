<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { OyaButton, OyaEmptyState } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";
import ChatBubble from "../ChatBubble.vue";

const props = defineProps<{ channel: ChatChannel; controller: P2pRoomsController }>();
defineEmits<{ "open-sidebar": [] }>();
const { currentRoom, messages, participants, p2pRooms } = props.channel;

const el = ref<HTMLElement | null>(null);
function scrollToBottom() {
  nextTick(() => {
    if (el.value) el.value.scrollTop = el.value.scrollHeight;
  });
}
watch(messages, scrollToBottom, { deep: true });

const isSystem = (type: string) => type === "system_info" || type === "system_error";

// Runs: consecutive messages from the same sender within five minutes read as one
// block (name on the first, avatar on the last).
const RUN_GAP_MS = 5 * 60_000;
function sameRun(a: { type: string; user: string; self: boolean; timestamp: Date } | undefined, b: typeof a): boolean {
  if (!a || !b || isSystem(a.type) || isSystem(b.type)) return false;
  return a.self === b.self && a.user === b.user && Math.abs(+new Date(b.timestamp) - +new Date(a.timestamp)) < RUN_GAP_MS;
}
const runs = computed(() =>
  messages.value.map((m, i, all) => ({ first: !sameRun(all[i - 1], m), last: !sameRun(m, all[i + 1]) })),
);

// Alone in the room: the one useful thing to do is to invite someone, so say so
// where the conversation would be.
const entry = computed(() => p2pRooms.value.find((r) => r.room === currentRoom.value?.slug) ?? null);
const alone = computed(() => !!currentRoom.value && participants.value.length <= 1);
</script>

<template>
  <div ref="el" class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-1 sm:px-4 bg-primary-bg-light dark:bg-primary-bg-dark">
    <!-- As in Signal, a short conversation sits at the bottom, by the composer. -->
    <div class="flex min-h-full flex-col justify-end">
    <OyaEmptyState v-if="!currentRoom" icon="comments" size="lg" class="h-full">
      {{ $t("chat.emptyHint") }}
      <template #action>
        <OyaButton class="mt-2 lg:hidden" @click="$emit('open-sidebar')">{{ $t("chat.selectARoom") }}</OyaButton>
      </template>
    </OyaEmptyState>

    <div
      v-if="alone && entry"
      class="mx-auto mt-3 flex max-w-md flex-col items-center gap-2 rounded-2xl border border-current/10 p-4 text-center"
      data-testid="alone-card"
    >
      <font-awesome-icon icon="user-plus" class="text-2xl text-accent-light dark:text-accent-dark" />
      <p class="font-semibold">{{ $t("chat.aloneTitle") }}</p>
      <p class="text-sm opacity-70">{{ $t("chat.aloneHint") }}</p>
      <OyaButton @click="controller.openInfo(entry)">
        <font-awesome-icon icon="user-plus" />{{ $t("chat.invite") }}
      </OyaButton>
    </div>

    <template v-for="(msg, i) in messages" :key="msg.id">
      <!-- Notices from the app are a quiet line, not a message from someone. -->
      <p
        v-if="isSystem(msg.type)"
        class="mx-auto my-3 max-w-[90%] text-center text-xs leading-relaxed"
        :class="msg.type === 'system_error' ? 'text-warn-dark' : 'opacity-50'"
        data-testid="system-line"
      >
        {{ msg.content }}
      </p>
      <ChatBubble v-else :message="msg" :first="runs[i].first" :last="runs[i].last" />
    </template>
    </div>
  </div>
</template>
