<script setup lang="ts">
import { useChatStore } from "../stores/chat";
import ChatPanel from "../components/ChatPanel.vue";

defineProps<{ darkMode: boolean }>();

const chat = useChatStore();
const activeTab = chat.activeTab; // Ref<ChatTab>

// Per-channel unread counters (badge on the inactive tab).
const relayUnread = chat.relay.unread;
const p2pUnread = chat.p2p.unread;
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <!-- Tab bar: Forum (relay) | P2P -->
    <div class="flex shrink-0 gap-2">
      <button
        type="button"
        :class="activeTab === 'relay'
          ? (darkMode ? 'border-accent-dark bg-bubble-bg-dark' : 'border-accent-light bg-bubble-bg-light')
          : 'border-current/15 opacity-60 hover:opacity-100'"
        class="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-bold transition"
        @click="chat.setTab('relay')"
      >
        <font-awesome-icon icon="satellite-dish" />
        {{ $t('chat.tabForum') }}
        <span
          v-if="activeTab !== 'relay' && relayUnread"
          class="rounded-full bg-warn-dark px-1.5 py-0.5 text-[10px] font-bold text-primary-bg-dark"
        >{{ relayUnread > 99 ? '99+' : relayUnread }}</span>
      </button>

      <button
        type="button"
        :class="activeTab === 'p2p'
          ? (darkMode ? 'border-accent-dark bg-bubble-bg-dark' : 'border-accent-light bg-bubble-bg-light')
          : 'border-current/15 opacity-60 hover:opacity-100'"
        class="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-bold transition"
        @click="chat.setTab('p2p')"
      >
        <font-awesome-icon icon="circle-nodes" />
        {{ $t('chat.tabP2p') }}
        <span
          v-if="activeTab !== 'p2p' && p2pUnread"
          class="rounded-full bg-warn-dark px-1.5 py-0.5 text-[10px] font-bold text-primary-bg-dark"
        >{{ p2pUnread > 99 ? '99+' : p2pUnread }}</span>
      </button>
    </div>

    <!-- Both panels stay mounted (v-show) so both chats remain live in the background -->
    <div class="min-h-0 flex-1">
      <ChatPanel v-show="activeTab === 'relay'" :dark-mode="darkMode" :channel="chat.relay" />
      <ChatPanel v-show="activeTab === 'p2p'" :dark-mode="darkMode" :channel="chat.p2p" />
    </div>
  </div>
</template>
