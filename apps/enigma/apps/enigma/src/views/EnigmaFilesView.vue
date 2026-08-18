<script setup lang="ts">
import { ref } from "vue";
import { getBuildConfig } from "rakotis";
import FilePanel from "../components/chat/FilePanel.vue";
import DevicesTab from "../components/devices/DevicesTab.vue";
import KeyringPanel from "../components/local/KeyringPanel.vue";
import LocalPanel from "../components/local/LocalPanel.vue";

// darkMode is class-based (`.dark` on <html>); the prop also drives the
// segmented pill borders (mirroring EnigmaConfigView's tab pill).
defineProps<{ darkMode?: boolean }>();

// A build without device linking has no Devices tab at all (the pairing UI and
// the per-file sync both ride the devlink machinery).
const devicesAllowed = getBuildConfig().devices_allow_linking;
// Same rule for the key ring: keyring.enabled off = no Keys tab, no dormant UI.
const keyringAllowed = getBuildConfig().keyring_enabled;

// P2P (direct peer transfer) vs Local (passphrase-protected files encrypted on
// this device) vs Devices (the user's OWN linked devices: per-file push/pull +
// pairing — never a friend). There is no server-backed tab: Enigma stores
// nothing off-device.
type FilesTab = "p2p" | "local" | "devices" | "keys";
const activeTab = ref<FilesTab>("p2p");
</script>

<template>
  <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <!-- Fills <main> exactly; each sub-tab panel scrolls inside the pane below. -->
    <!-- Sub-tab pills -->
    <!-- Four pills must fit a phone: labels drop below `sm` (icons carry the
         meaning), rows never wrap, and overflow scrolls instead of clipping. -->
    <div
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex gap-1 overflow-x-auto rounded-xl border p-1 text-sm font-semibold"
    >
      <button
        type="button"
        :class="activeTab === 'p2p'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'p2p'"
      >
        <font-awesome-icon icon="circle-nodes" /><span class="hidden sm:inline">{{ $t('files.p2pTab') }}</span>
      </button>
      <button
        type="button"
        :class="activeTab === 'local'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'local'"
      >
        <font-awesome-icon icon="lock" /><span class="hidden sm:inline">{{ $t('files.localTab') }}</span>
      </button>
      <button
        v-if="devicesAllowed"
        type="button"
        :class="activeTab === 'devices'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'devices'"
      >
        <font-awesome-icon icon="mobile-screen" /><span class="hidden sm:inline">{{ $t('files.devicesTab') }}</span>
      </button>
      <button
        v-if="keyringAllowed"
        type="button"
        :class="activeTab === 'keys'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        data-testid="files-tab-keys"
        @click="activeTab = 'keys'"
      >
        <font-awesome-icon icon="key" /><span class="hidden sm:inline">{{ $t('keys.tab') }}</span>
      </button>
    </div>

    <!-- P2P file transfer: offer a file to a peer of the active room, accept or
         decline incoming offers, watch transfer progress. -->
    <!-- The pane is a flex COLUMN, not a bare block: every panel below sizes
         itself with `flex-1 min-h-0` + its own `overflow-y-auto`, which a
         display:block wrapper silently ignores — the panel then grew past the
         pane and got clipped by the view's `overflow-hidden` (Devices worst of
         all, since its list is the longest). -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <FilePanel v-if="activeTab === 'p2p'" />
      <!-- Devices: the user's own linked devices — per-file push/pull + pairing. -->
      <DevicesTab v-else-if="activeTab === 'devices' && devicesAllowed" :dark-mode="darkMode" />
      <!-- Keys: the key ring — one passphrase, many locked files (device-local). -->
      <KeyringPanel v-else-if="activeTab === 'keys' && keyringAllowed" :dark-mode="darkMode" />
      <!-- Local: passphrase-protected files encrypted on this device, and the notes
           editor for reading and editing local text files. -->
      <LocalPanel v-else :dark-mode="darkMode" />
    </div>
  </div>
</template>
