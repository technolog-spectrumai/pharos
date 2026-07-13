<script setup lang="ts">
import { OyaTextField, OyaQrCode, OyaCopyField } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ controller: P2pRoomsController }>();
const { name, createdTicket, createRoom } = props.controller;
</script>

<template>
  <div class="space-y-2.5">
    <p class="text-xs font-semibold uppercase tracking-wide opacity-60">
      <font-awesome-icon icon="circle-nodes" class="mr-1" />{{ $t("chat.newChat") }}
    </p>

    <div class="flex gap-2">
      <OyaTextField v-model="name" size="sm" :placeholder="$t('chat.newRoomName')" @enter="createRoom" />
      <!-- Plain text button: the accessible name "Create" is asserted by the e2e smoke. -->
      <button
        class="shrink-0 rounded-lg border border-current/20 px-2 py-1.5 text-xs font-semibold transition hover:opacity-80"
        @click="createRoom"
      >
        {{ $t("chat.create") }}
      </button>
    </div>

    <div v-if="createdTicket" class="space-y-1.5">
      <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareTicket") }}</p>
      <OyaQrCode :value="createdTicket" :size="176" alt="Room QR code" />
      <p class="text-center text-[10px] opacity-50">{{ $t("chat.scanToJoin") }}</p>
      <OyaCopyField :value="createdTicket" mono :copy-label="$t('chat.copy')" />
    </div>
  </div>
</template>
