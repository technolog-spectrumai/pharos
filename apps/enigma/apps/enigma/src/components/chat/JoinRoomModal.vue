<script setup lang="ts">
import { ref } from "vue";
import { OyaModal, OyaTextField, OyaIconButton } from "rakotis";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{
  open: boolean;
  channel: ChatChannel;
  controller: P2pRoomsController;
  scanning?: boolean;
}>();
const emit = defineEmits<{ "update:open": [boolean]; "toggle-camera": [] }>();

const { ticket, scanError, joinStarted, joinError, joiningTor, joinCancelling, joinRoom, cancelJoin, scanFile, resetJoin } =
  props.controller;
// Live status from the channel — "established" = MLS Encrypted.
const { isEncrypted, mlsStatus } = props.channel;

const fileInput = ref<HTMLInputElement | null>(null);
function close() {
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div class="w-full max-w-sm space-y-4 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="right-to-bracket" />{{ $t("chat.joinChat") }}
      </p>

      <!-- Paste / scan / upload form -->
      <template v-if="!joinStarted">
        <OyaTextField v-model="ticket" :placeholder="$t('chat.pasteTicket')" @enter="joinRoom" />
        <div class="flex gap-2">
          <button
            type="button"
            class="flex-1 rounded-lg bg-accent-dark px-4 py-2 text-sm font-semibold text-primary-bg-dark transition hover:opacity-90"
            @click="joinRoom"
          >
            {{ $t("chat.join") }}
          </button>
          <OyaIconButton :icon="scanning ? 'xmark' : 'camera'" :label="$t('chat.scanQr')" @click="emit('toggle-camera')" />
          <OyaIconButton icon="image" :label="$t('chat.uploadQr')" @click="fileInput?.click()" />
          <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="scanFile" />
        </div>
        <p v-if="scanError" class="text-xs text-warn-dark">{{ $t(scanError) }}</p>
      </template>

      <!-- Connecting → established / error -->
      <div v-else class="flex flex-col items-center gap-3 py-6 text-center">
        <font-awesome-icon v-if="joinError" icon="triangle-exclamation" class="text-3xl text-warn-dark" />
        <font-awesome-icon v-else-if="isEncrypted" icon="lock" class="text-3xl text-success-dark" />
        <font-awesome-icon v-else icon="spinner" spin class="text-3xl text-accent-dark" />
        <p class="text-sm font-semibold">
          {{
            joinError
              ? $t(joinError)
              : isEncrypted
                ? $t("chat.connectedOk")
                : mlsStatus === "key_exchange"
                  ? $t("chat.encrypting")
                  : $t("chat.joining")
          }}
        </p>
        <button
          v-if="joinError"
          type="button"
          class="rounded-lg border border-current/20 px-4 py-2 text-sm font-semibold transition hover:opacity-80"
          @click="resetJoin"
        >
          {{ $t("chat.retry") }}
        </button>
        <!-- Tor joins host + dial an onion, which can hang; let the user abort so
             the onion lock is freed and a retry doesn't hit "already in use". -->
        <button
          v-else-if="joiningTor && !isEncrypted"
          type="button"
          :disabled="joinCancelling"
          class="rounded-lg border border-current/20 px-4 py-2 text-sm font-semibold transition hover:opacity-80 disabled:opacity-50"
          @click="cancelJoin"
        >
          {{ joinCancelling ? $t("chat.cancelling") : $t("chat.cancelJoin") }}
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
