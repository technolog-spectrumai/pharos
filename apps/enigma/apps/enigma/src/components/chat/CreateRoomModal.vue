<script setup lang="ts">
import { ref, watch } from "vue";
import { OyaModal, OyaTextField, OyaQrCode, OyaCopyField, getUseTor } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ open: boolean; controller: P2pRoomsController }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const { name, createdTicket, createdCode, createBusy, createError, createRoom } = props.controller;

// Whether this will be a Tor room — drives the spinner wording + the captain ★ hint.
const tor = ref(false);
watch(
  () => props.open,
  async (o) => {
    if (o) tor.value = await getUseTor();
  },
);

function close() {
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div class="w-full max-w-sm space-y-4 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="circle-nodes" />{{ $t("chat.newChat") }}
      </p>

      <!-- Name form -->
      <template v-if="!createdTicket && !createBusy && !createError">
        <OyaTextField v-model="name" :placeholder="$t('chat.newRoomName')" @enter="createRoom" />
        <button
          type="button"
          class="w-full rounded-lg bg-accent-dark px-4 py-2 text-sm font-semibold text-primary-bg-dark transition hover:opacity-90"
          @click="createRoom"
        >
          {{ $t("chat.create") }}
        </button>
      </template>

      <!-- Launching spinner -->
      <div v-else-if="createBusy" class="flex flex-col items-center gap-3 py-6 text-center">
        <font-awesome-icon icon="spinner" spin class="text-3xl text-accent-dark" />
        <p class="text-sm opacity-70">{{ tor ? $t("chat.launchingOnion") : $t("chat.creatingRoom") }}</p>
      </div>

      <!-- Success: you're the host + QR to share -->
      <div v-else-if="createdTicket" class="space-y-2.5">
        <p class="flex items-center gap-2 text-sm font-semibold text-success-dark">
          <font-awesome-icon v-if="tor" icon="star" class="text-highlight" />{{ $t("chat.youAreHost") }}
        </p>
        <p v-if="tor" class="text-xs opacity-60">{{ $t("chat.hostStarHint") }}</p>
        <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareTicket") }}</p>
        <OyaQrCode :value="createdTicket" :size="176" alt="Room QR code" />
        <p class="text-center text-[10px] opacity-50">{{ $t("chat.scanToJoin") }}</p>
        <OyaCopyField :value="createdTicket" mono :copy-label="$t('chat.copy')" />
        <!-- Ticketless-join room code (DHT rendezvous) — only with discovery on -->
        <template v-if="createdCode">
          <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareCode") }}</p>
          <OyaCopyField :value="createdCode" mono :copy-label="$t('chat.copy')" />
        </template>
      </div>

      <!-- Error -->
      <div v-else-if="createError" class="space-y-3">
        <p class="flex items-center gap-2 text-sm text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />{{ $t("chat.launchFailed") }}
        </p>
        <p class="text-xs opacity-70">{{ $t(createError) }}</p>
        <button
          type="button"
          class="w-full rounded-lg border border-current/20 px-4 py-2 text-sm font-semibold transition hover:opacity-80"
          @click="createRoom"
        >
          {{ $t("chat.retry") }}
        </button>
      </div>
    </div>

    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        @click="close"
      >
        {{ $t("chat.close") }}
      </button>
    </template>
  </OyaModal>
</template>
