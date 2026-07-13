<script setup lang="ts">
import { ref } from "vue";
import { OyaTextField, OyaIconButton } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ controller: P2pRoomsController; scanning?: boolean }>();
defineEmits<{ "toggle-camera": [] }>();
const { ticket, scanError, joinRoom, scanFile } = props.controller;

const fileInput = ref<HTMLInputElement | null>(null);
</script>

<template>
  <div class="space-y-2.5">
    <p class="pt-1 text-xs font-semibold uppercase tracking-wide opacity-60">
      <font-awesome-icon icon="camera" class="mr-1" />{{ $t("chat.joinChat") }}
    </p>

    <div class="flex gap-2">
      <OyaTextField v-model="ticket" size="sm" :placeholder="$t('chat.pasteTicket')" @enter="joinRoom" />
      <button
        class="shrink-0 rounded-lg border border-current/20 px-2 py-1.5 text-xs font-semibold transition hover:opacity-80"
        @click="joinRoom"
      >
        {{ $t("chat.join") }}
      </button>
      <OyaIconButton
        :icon="scanning ? 'xmark' : 'camera'"
        size="sm"
        :label="$t('chat.scanQr')"
        @click="$emit('toggle-camera')"
      />
      <OyaIconButton icon="image" size="sm" :label="$t('chat.uploadQr')" @click="fileInput?.click()" />
      <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="scanFile" />
    </div>

    <p v-if="scanError" class="text-[10px] text-red-400">{{ $t(scanError) }}</p>
  </div>
</template>
