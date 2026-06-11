<script setup lang="ts">
import { computed } from "vue";
import { useChatStore } from "../stores/chat";

defineProps<{ darkMode: boolean }>();

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

const chat = useChatStore();
const p2p = chat.p2p;
const file = chat.fileShare;

// File transfer rides the p2p chat's MLS group — it needs an active, encrypted p2p room.
const ready = computed(() => !!p2p.currentRoom.value && p2p.isEncrypted.value);
const peers = computed(() =>
  p2p.participants.value.filter((pp) => pp.name !== p2p.currentUserName.value),
);
const pct = computed(() => Math.round(file.progress.value * 100));

function fmtSize(bytes: number): string {
  if (!bytes) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}
</script>

<template>
  <div
    :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
    class="flex h-full flex-col overflow-hidden rounded-xl border shadow-md"
  >
    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-current/10 p-4">
      <font-awesome-icon icon="file-arrow-down" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
      <h2 class="text-lg font-bold">{{ $t('fileShare.title') }}</h2>
    </div>

    <div class="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center">
      <!-- Desktop-only -->
      <template v-if="!_isTauri()">
        <font-awesome-icon icon="desktop" class="text-3xl opacity-30" />
        <p class="text-sm opacity-60">{{ $t('fileShare.desktopOnly') }}</p>
      </template>

      <!-- Needs an encrypted p2p room -->
      <template v-else-if="!ready">
        <font-awesome-icon icon="circle-nodes" class="text-3xl opacity-30" />
        <p class="text-sm opacity-60">{{ $t('fileShare.needP2p') }}</p>
        <button
          class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
          @click="chat.setTab('p2p')"
        >{{ $t('fileShare.goToP2p') }}</button>
      </template>

      <!-- Incoming offer (recipient) -->
      <template v-else-if="file.state.value === 'incoming'">
        <font-awesome-icon icon="inbox" class="text-3xl" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
        <p class="text-sm">
          <span class="font-bold">{{ file.peerName.value || $t('fileShare.aPeer') }}</span>
          {{ $t('fileShare.wantsToSend') }}
        </p>
        <div :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'" class="rounded-lg px-4 py-3">
          <p class="text-sm font-semibold break-all">{{ file.fileName.value }}</p>
          <p class="text-xs opacity-50 mt-0.5">{{ fmtSize(file.fileSize.value) }}</p>
        </div>
        <div class="flex gap-2">
          <button
            class="rounded-lg bg-red-500/90 px-4 py-2 text-xs font-bold text-white transition hover:opacity-90"
            @click="file.decline()"
          ><font-awesome-icon icon="xmark" /> {{ $t('fileShare.decline') }}</button>
          <button
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="rounded-lg px-4 py-2 text-xs font-bold transition hover:opacity-90"
            @click="file.accept()"
          ><font-awesome-icon icon="download" /> {{ $t('fileShare.accept') }}</button>
        </div>
      </template>

      <!-- Transferring -->
      <template v-else-if="file.state.value === 'transferring'">
        <font-awesome-icon icon="spinner" spin class="text-3xl" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
        <p class="text-sm font-semibold">
          {{ file.direction.value === 'send' ? $t('fileShare.sending') : $t('fileShare.receiving') }}
        </p>
        <p class="text-xs opacity-60 break-all">{{ file.fileName.value }}</p>
        <div :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'" class="h-2 w-56 overflow-hidden rounded-full">
          <div :class="darkMode ? 'bg-accent-dark' : 'bg-accent-light'" class="h-full rounded-full transition-all" :style="`width:${pct}%`" />
        </div>
        <p class="text-xs opacity-50">{{ pct }}% · {{ fmtSize(file.fileSize.value) }}</p>
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
        <font-awesome-icon icon="circle-check" class="text-3xl text-green-500" />
        <p class="text-sm font-semibold">{{ $t('fileShare.done') }}</p>
        <p class="text-xs opacity-60 break-all">{{ file.fileName.value }}</p>
        <button
          class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
          @click="file.reset()"
        >{{ $t('fileShare.again') }}</button>
      </template>

      <!-- Declined / error -->
      <template v-else-if="file.state.value === 'declined' || file.state.value === 'error'">
        <font-awesome-icon icon="circle-exclamation" class="text-3xl text-yellow-500" />
        <p class="text-sm">{{ file.state.value === 'declined' ? $t('fileShare.declined') : (file.error.value || $t('fileShare.failed')) }}</p>
        <button
          class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
          @click="file.reset()"
        >{{ $t('fileShare.again') }}</button>
      </template>

      <!-- Idle: pick who to send to -->
      <template v-else>
        <font-awesome-icon icon="file-arrow-up" class="text-3xl" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
        <p class="max-w-xs text-sm opacity-70">{{ $t('fileShare.choosePeer') }}</p>

        <div class="w-full max-w-xs space-y-2">
          <div
            v-for="p in peers" :key="p.id ?? p.name"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="flex items-center gap-3 rounded-lg border px-3 py-2 text-left"
          >
            <div :class="darkMode ? 'border-accent-1' : 'border-accent-2'" class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border text-xs font-bold">
              <img v-if="p.avatar_url" :src="p.avatar_url" :alt="p.name" class="h-full w-full object-cover" />
              <span v-else>{{ p.name.slice(0, 2).toUpperCase() }}</span>
            </div>
            <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ p.name }}</span>
            <button
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold transition hover:opacity-90"
              @click="file.offer({ id: String(p.id ?? p.name), name: p.name })"
            ><font-awesome-icon icon="file-arrow-up" /> {{ $t('fileShare.send') }}</button>
          </div>
          <p v-if="!peers.length" class="text-xs opacity-40">{{ $t('fileShare.noPeers') }}</p>
        </div>

        <p class="text-xs opacity-40">🔒 {{ $t('fileShare.encrypted') }}</p>
      </template>
    </div>
  </div>
</template>
