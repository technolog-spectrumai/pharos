<script setup lang="ts">
import { ref } from "vue";
import { OyaModal, OyaTextField, OyaIconButton } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{
  open: boolean;
  channel: ChatChannel;
  controller: P2pRoomsController;
}>();
// `open-camera` hands the screen over to the scanner: the parent CLOSES this modal
// while the camera is up (both are body-teleported overlays, so leaving this one
// mounted painted its backdrop + card over the live feed) and reopens it on the
// decode/dismiss, because the connect → MLS progress and the auto-close countdown
// live here.
const emit = defineEmits<{ "update:open": [boolean]; "open-camera": [] }>();

const { ticket, scanError, joinStarted, joinError, joiningTor, autoCloseSecs, joinRoom, cancelJoin, scanFile, resetJoin, invitePeek } =
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
    <div
      data-testid="join-room-modal"
      class="w-full max-w-sm space-y-4 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
    >
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="right-to-bracket" />{{ $t("chat.joinChat") }}
      </p>

      <!-- Paste / scan / upload form -->
      <template v-if="!joinStarted">
        <OyaTextField v-model="ticket" :placeholder="$t('chat.pasteTicket')" @enter="joinRoom" />
        <!-- A scanned invitation says who is inviting you before it is redeemed:
             an invitation is a connection to a person, not a topic to join. -->
        <p
          v-if="invitePeek"
          class="text-xs opacity-70"
          data-testid="invite-peek"
        >
          {{ $t("invite.redeeming", { who: invitePeek.inviter.slice(0, 12) }) }}
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class="flex-1 rounded-lg bg-accent-dark px-4 py-2 text-sm font-semibold text-primary-bg-dark transition hover:opacity-90"
            @click="joinRoom"
          >
            {{ $t("chat.join") }}
          </button>
          <OyaIconButton
            icon="camera"
            data-testid="join-scan"
            :label="$t('chat.scanQr')"
            @click="emit('open-camera')"
          />
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
                  : joiningTor
                    ? $t("chat.launchingOnion")
                    : $t("chat.joining")
          }}
        </p>
        <!-- Terminal outcome (established or error) → the window closes itself after
             one more connect-timeout interval (total lifetime ≈ 2× the timeout). -->
        <p v-if="autoCloseSecs !== null" class="text-xs opacity-60">
          {{ $t("chat.autoClose", { n: autoCloseSecs }) }}
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
          class="rounded-lg border border-current/20 px-4 py-2 text-sm font-semibold transition hover:opacity-80"
          @click="cancelJoin"
        >
          {{ $t("chat.cancelJoin") }}
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
