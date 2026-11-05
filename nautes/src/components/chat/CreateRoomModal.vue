<script setup lang="ts">
import { OyaModal, OyaTextField } from "petalite/primitives";
import RoomShareCard from "./RoomShareCard.vue";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ open: boolean; controller: P2pRoomsController }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const { name, createdRoom, createBusy, createError, createRoom } = props.controller;

// Every Nautes room is a Tor room: the spinner says the wait is Tor's, and the
// creator hosts the onion (the captain ★ hint).
const tor = true;

function close() {
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-4 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="circle-nodes" />{{ $t("chat.newChat") }}
      </p>

      <!-- Name form -->
      <template v-if="!createdRoom && !createBusy && !createError">
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
      <div v-else-if="createdRoom" class="space-y-2.5">
        <p class="flex items-center gap-2 text-sm font-semibold text-success-dark">
          <font-awesome-icon v-if="tor" icon="star" class="text-highlight" />{{ $t("chat.youAreHost") }}
        </p>
        <p v-if="tor" class="text-xs opacity-60">{{ $t("chat.hostStarHint") }}</p>
        <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareTicket") }}</p>
        <!-- Mint an invitation and see its QR without leaving this modal — the
             same card Room info uses, so the two can never disagree. -->
        <RoomShareCard :room-slug="createdRoom.slug" :room-name="createdRoom.name" :tor="tor" />
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
