<script setup lang="ts">
import { useChatStore } from "../stores/chat";
import ChatPanel from "../components/ChatPanel.vue";
import VoxPanel from "../components/VoxPanel.vue";
import SyncPanel from "../components/SyncPanel.vue";
import FilePanel from "../components/FilePanel.vue";

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

      <button
        type="button"
        :class="activeTab === 'vox'
          ? (darkMode ? 'border-accent-dark bg-bubble-bg-dark' : 'border-accent-light bg-bubble-bg-light')
          : 'border-current/15 opacity-60 hover:opacity-100'"
        class="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-bold transition"
        @click="chat.setTab('vox')"
      >
        <font-awesome-icon icon="phone" />
        {{ $t('chat.tabVox') }}
      </button>

      <button
        type="button"
        :class="activeTab === 'sync'
          ? (darkMode ? 'border-accent-dark bg-bubble-bg-dark' : 'border-accent-light bg-bubble-bg-light')
          : 'border-current/15 opacity-60 hover:opacity-100'"
        class="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-bold transition"
        @click="chat.setTab('sync')"
      >
        <font-awesome-icon icon="right-left" />
        {{ $t('chat.tabSync') }}
        <span
          v-if="activeTab !== 'sync' && chat.dataSync.state.value === 'incoming'"
          class="rounded-full bg-warn-dark px-1.5 py-0.5 text-[10px] font-bold text-primary-bg-dark"
        >!</span>
      </button>

      <button
        type="button"
        :class="activeTab === 'files'
          ? (darkMode ? 'border-accent-dark bg-bubble-bg-dark' : 'border-accent-light bg-bubble-bg-light')
          : 'border-current/15 opacity-60 hover:opacity-100'"
        class="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-bold transition"
        @click="chat.setTab('files')"
      >
        <font-awesome-icon icon="file-arrow-down" />
        {{ $t('chat.tabFiles') }}
        <span
          v-if="activeTab !== 'files' && chat.fileShare.state.value === 'incoming'"
          class="rounded-full bg-warn-dark px-1.5 py-0.5 text-[10px] font-bold text-primary-bg-dark"
        >!</span>
      </button>
    </div>

    <!-- Chat panels stay mounted (v-show) so both chats remain live in the background.
         Vox (voice) is its own panel — a live 1:1 call, no message history. -->
    <div class="min-h-0 flex-1">
      <ChatPanel v-show="activeTab === 'relay'" :dark-mode="darkMode" :channel="chat.relay" />
      <ChatPanel v-show="activeTab === 'p2p'" :dark-mode="darkMode" :channel="chat.p2p" />
      <VoxPanel v-show="activeTab === 'vox'" :dark-mode="darkMode" />
      <SyncPanel v-show="activeTab === 'sync'" :dark-mode="darkMode" />
      <FilePanel v-show="activeTab === 'files'" :dark-mode="darkMode" />
    </div>
  </div>
</template>
