<script setup lang="ts">
import { useChatStore } from "../stores/chat";
import ChatPanel from "../components/ChatPanel.vue";

// darkMode is now class-based (`.dark` on <html>); the prop is declared only to
// absorb the fall-through attr App.vue still passes during the Config/Profile transition.
defineProps<{ darkMode?: boolean }>();

const chat = useChatStore();
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <!-- Single serverless P2P chat surface: create a room (show its QR) or join
         one (scan / paste a ticket) from the panel's sidebar. -->
    <div class="min-h-0 flex-1">
      <ChatPanel :channel="chat.p2p" />
    </div>
  </div>
</template>
