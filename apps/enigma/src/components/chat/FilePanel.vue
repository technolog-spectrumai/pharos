<script setup lang="ts">
// P2P file-transfer UI (restored from limbo/) — the full surface of the Files tab
// (EnigmaFilesView). All state lives in the chat store's `fileShare` singleton, so
// transfers keep running while the user is on another tab; the App nav marks the
// Files tab with a dot when an offer is waiting.
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useChatStore } from "../../stores/chat";
import { isTabVisible } from "../../tabs";
import { useNetworkStore } from "../../stores/network";
import { policy } from "../../config/app";
import { formatBytes } from "rakotis";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

const router = useRouter();
const chat = useChatStore();
const p2p = chat.p2p;
const file = chat.fileShare;

// File transfer is iroh-only (file_xfer.rs errors in Tor/airplane mode) — the
// Send buttons stay visible but disabled, with the shared reason line shown.
const network = useNetworkStore();
const canSend = computed(() => network.canFileTransfer);
onMounted(() => { void network.refresh(); });

// File transfer rides the p2p chat's MLS group — it needs an active, encrypted p2p room.
const ready = computed(() => !!p2p.currentRoom.value && p2p.isEncrypted.value);
const peers = computed(() =>
  p2p.participants.value.filter((pp) =>
    pp.id ? pp.id !== p2p.mlsIdentity.value : pp.name !== p2p.currentUserName.value,
  ),
);
const pct = computed(() => Math.round(file.progress.value * 100));
// Tiny transfers finish instantly — below the build threshold the bar is noise.
const showBar = computed(() => file.fileSize.value > policy.fileShare.progressBarMinBytes);

// The app's one byte formatter, so a size in the Files tab and the same size on a
// map card cannot disagree about the decimal separator.
const fmtSize = formatBytes;
</script>

<template>
  <div
    class="flex h-full w-full flex-col overflow-hidden rounded-lg border shadow-md bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1"
  >
    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-current/10 p-4">
      <font-awesome-icon icon="file-arrow-down" class="text-accent-light dark:text-accent-dark" />
      <h2 class="text-lg font-bold">{{ $t('fileShare.title') }}</h2>
    </div>

    <!-- Scroller OUTSIDE, centering INSIDE: `justify-center` on the scroll
         container itself would push a tall offer/progress card past the top
         edge, out of scroll reach. `min-h-0` lets this pane shrink below its
         content so `overflow-y-auto` fires instead of the parent clipping it. -->
    <div class="min-h-0 flex-1 overflow-y-auto p-6 text-center">
      <div class="flex min-h-full flex-col items-center justify-center gap-4">
        <!-- Desktop-only -->
        <template v-if="!_isTauri()">
          <font-awesome-icon icon="desktop" class="text-3xl opacity-30" />
          <p class="text-sm opacity-60">{{ $t('fileShare.desktopOnly') }}</p>
        </template>

        <!-- Needs an encrypted p2p room -->
        <template v-else-if="!ready">
          <font-awesome-icon icon="circle-nodes" class="text-3xl opacity-30" />
          <p class="text-sm opacity-60">{{ $t('fileShare.needP2p') }}</p>
          <!-- Only offered while the Chat tab exists for this user (src/tabs.ts):
               hidden, the route guard would just bounce them back here. -->
          <button
            v-if="isTabVisible('chat')"
            class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
            @click="router.push('/chat')"
          >{{ $t('fileShare.goToChat') }}</button>
        </template>

        <!-- Incoming offer (recipient) -->
        <template v-else-if="file.state.value === 'incoming'">
          <font-awesome-icon icon="inbox" class="text-3xl text-accent-light dark:text-accent-dark" />
          <p class="text-sm">
            <span class="font-bold">{{ file.peerName.value || $t('fileShare.aPeer') }}</span>
            {{ $t('fileShare.wantsToSend') }}
          </p>
          <div class="rounded-lg bg-sunken-light px-4 py-3 dark:bg-sunken-dark">
            <p class="text-sm font-semibold break-all">{{ file.fileName.value }}</p>
            <p class="text-xs opacity-50 mt-0.5">{{ fmtSize(file.fileSize.value) }}</p>
          </div>
          <div class="flex gap-2">
            <button
              class="rounded-lg bg-warn-light/90 px-4 py-2 text-xs font-bold text-white transition hover:opacity-90 dark:bg-warn-dark/90"
              @click="file.decline()"
            ><font-awesome-icon icon="xmark" /> {{ $t('fileShare.decline') }}</button>
            <button
              class="rounded-lg bg-accent-light px-4 py-2 text-xs font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
              @click="file.accept()"
            ><font-awesome-icon icon="download" /> {{ $t('fileShare.accept') }}</button>
          </div>
        </template>

        <!-- Transferring -->
        <template v-else-if="file.state.value === 'transferring'">
          <font-awesome-icon icon="spinner" spin class="text-3xl text-accent-light dark:text-accent-dark" />
          <p class="text-sm font-semibold">
            {{ file.direction.value === 'send' ? $t('fileShare.sending') : $t('fileShare.receiving') }}
          </p>
          <p class="text-xs opacity-60 break-all">{{ file.fileName.value }}</p>
          <template v-if="showBar">
            <div class="h-2 w-56 overflow-hidden rounded-full bg-sunken-light dark:bg-sunken-dark">
              <div class="h-full rounded-full bg-accent-light transition-all dark:bg-accent-dark" :style="`width:${pct}%`" />
            </div>
            <p class="text-xs opacity-50">{{ pct }}% · {{ fmtSize(file.fileSize.value) }}</p>
          </template>
          <p v-else class="text-xs opacity-50">{{ fmtSize(file.fileSize.value) }}</p>
          <button class="text-xs underline opacity-70 hover:opacity-100" @click="file.cancel()">{{ $t('common.cancel') }}</button>
        </template>

        <!-- Offering (host, awaiting accept) -->
        <template v-else-if="file.state.value === 'offering'">
          <font-awesome-icon icon="paper-plane" class="text-3xl opacity-40" />
          <p class="text-sm">{{ $t('fileShare.waitingAccept', { name: file.peerName.value || $t('fileShare.aPeer') }) }}</p>
          <p class="text-xs opacity-60 break-all">{{ file.fileName.value }} · {{ fmtSize(file.fileSize.value) }}</p>
          <button class="text-xs underline opacity-70 hover:opacity-100" @click="file.cancel()">{{ $t('common.cancel') }}</button>
        </template>

        <!-- Done -->
        <template v-else-if="file.state.value === 'done'">
          <font-awesome-icon icon="circle-check" class="text-3xl text-success-light dark:text-success-dark" />
          <p class="text-sm font-semibold">{{ $t('fileShare.done') }}</p>
          <p class="text-xs opacity-60 break-all">{{ file.fileName.value }}</p>
          <button
            class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
            @click="file.reset()"
          >{{ $t('fileShare.again') }}</button>
        </template>

        <!-- Declined / error -->
        <template v-else-if="file.state.value === 'declined' || file.state.value === 'error'">
          <font-awesome-icon icon="circle-exclamation" class="text-3xl text-highlight" />
          <p class="text-sm">{{ file.state.value === 'declined' ? $t('fileShare.declined') : (file.error.value || $t('fileShare.failed')) }}</p>
          <button
            class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
            @click="file.reset()"
          >{{ $t('fileShare.again') }}</button>
        </template>

        <!-- Idle: pick who to send to -->
        <template v-else>
          <font-awesome-icon icon="file-arrow-up" class="text-3xl text-accent-light dark:text-accent-dark" />
          <p class="max-w-xs text-sm opacity-70">{{ $t('fileShare.choosePeer') }}</p>

          <p
            v-if="!canSend"
            data-testid="fileshare-blocked"
            class="max-w-xs rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-500"
          >{{ $t(network.blockedReasonKey) }}</p>

          <div class="w-full max-w-xs space-y-2">
            <div
              v-for="p in peers" :key="p.id ?? p.name"
              class="flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 text-left dark:border-accent-1"
            >
              <div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-accent-2 text-xs font-bold dark:border-accent-1">
                <img v-if="p.avatar_url" :src="p.avatar_url" :alt="p.name" class="h-full w-full object-cover" />
                <span v-else>{{ p.name.slice(0, 2).toUpperCase() }}</span>
              </div>
              <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ p.name }}</span>
              <button
                class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-bold text-primary-bg-light transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-accent-dark dark:text-primary-bg-dark"
                :disabled="!canSend"
                @click="file.offer({ id: String(p.id ?? p.name), name: p.name })"
              ><font-awesome-icon icon="file-arrow-up" /> {{ $t('fileShare.send') }}</button>
            </div>
            <p v-if="!peers.length" class="text-xs opacity-40">{{ $t('fileShare.noPeers') }}</p>
          </div>

          <p class="text-xs opacity-40">🔒 {{ $t('fileShare.encrypted') }}</p>
        </template>
      </div>
    </div>
  </div>
</template>
