<script setup lang="ts">
import { ref } from "vue";
import FilePanel from "../components/chat/FilePanel.vue";
import CloudPanel from "../components/cloud/CloudPanel.vue";

// darkMode is class-based (`.dark` on <html>); the prop also drives the
// segmented pill borders (mirroring EnigmaConfigView's tab pill).
defineProps<{ darkMode?: boolean }>();

// P2P (direct peer transfer) vs Cloud (the user's own Enigma Cloud server).
type FilesTab = "p2p" | "cloud";
const activeTab = ref<FilesTab>("p2p");
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <!-- P2P / Cloud tabs -->
    <div
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex gap-1 rounded-xl border p-1 text-sm font-semibold"
    >
      <button
        type="button"
        :class="activeTab === 'p2p'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'p2p'"
      >
        <font-awesome-icon icon="circle-nodes" />{{ $t('files.p2pTab') }}
      </button>
      <button
        type="button"
        :class="activeTab === 'cloud'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'cloud'"
      >
        <font-awesome-icon icon="cloud" />{{ $t('files.cloudTab') }}
      </button>
    </div>

    <!-- P2P file transfer: offer a file to a peer of the active room, accept or
         decline incoming offers, watch transfer progress. -->
    <div class="min-h-0 flex-1">
      <FilePanel v-if="activeTab === 'p2p'" />
      <!-- Enigma Cloud: files stored on the user's own server. -->
      <CloudPanel v-else />
    </div>
  </div>
</template>
