<script setup lang="ts">
import { ref } from "vue";
import { getBuildConfig } from "rakotis";
import FilePanel from "../components/chat/FilePanel.vue";
import DevicesTab from "../components/devices/DevicesTab.vue";
import LocalPanel from "../components/local/LocalPanel.vue";

// darkMode is class-based (`.dark` on <html>); the prop also drives the
// segmented pill borders (mirroring EnigmaConfigView's tab pill).
defineProps<{ darkMode?: boolean }>();

// A build without device linking has no Devices tab at all (the pairing UI and
// the per-file sync both ride the devlink machinery).
const devicesAllowed = getBuildConfig().devices_allow_linking;

// P2P (direct peer transfer) vs Local (passphrase-protected files encrypted on
// this device) vs Devices (the user's OWN linked devices: per-file push/pull +
// pairing — never a friend). Server-stored files moved to the top-level Cloud
// tab (cloud.md) together with the rest of the server surface.
type FilesTab = "p2p" | "local" | "devices";
const activeTab = ref<FilesTab>("p2p");
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <!-- Sub-tab pills -->
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
        :class="activeTab === 'local'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'local'"
      >
        <font-awesome-icon icon="lock" />{{ $t('files.localTab') }}
      </button>
      <button
        v-if="devicesAllowed"
        type="button"
        :class="activeTab === 'devices'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'devices'"
      >
        <font-awesome-icon icon="mobile-screen" />{{ $t('files.devicesTab') }}
      </button>
    </div>

    <!-- P2P file transfer: offer a file to a peer of the active room, accept or
         decline incoming offers, watch transfer progress. -->
    <div class="min-h-0 flex-1">
      <FilePanel v-if="activeTab === 'p2p'" />
      <!-- Devices: the user's own linked devices — per-file push/pull + pairing. -->
      <DevicesTab v-else-if="activeTab === 'devices' && devicesAllowed" :dark-mode="darkMode" />
      <!-- Local: passphrase-protected files encrypted on this device, and the notes
           editor for reading and editing local text files. -->
      <LocalPanel v-else :dark-mode="darkMode" />
    </div>
  </div>
</template>
