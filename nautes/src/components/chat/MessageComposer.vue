<script setup lang="ts">
// The message box: short text only (Pharos sends no images, voice or files).
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { OyaHpPrice, formatRemaining, messageActionId } from "rakotis";
import { OyaButton, OyaTextArea } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import EmojiPicker from "./EmojiPicker.vue";
import { chargeHp, explainFor, priceFor } from "../hp/useHp";
import { policy } from "../../config/app";

const MAX_MESSAGE_CHARS = policy.maxMessageChars;

const { t } = useI18n();

const props = defineProps<{ channel: ChatChannel }>();
const ch = props.channel;
const { currentRoom, isConnected, isParticipant, mlsStatus, selfMuteUntil } = ch;

// Every message travels over Tor; MLS comes up asynchronously, so the rate chip
// tracks it rather than sampling once at mount.
const msgAction = computed(() => messageActionId({ tor: true, mlsReady: mlsStatus.value === "ready" }));
const msgPrice = computed(() => priceFor(msgAction.value));

const draft = ref("");
const length = computed(() => [...draft.value.trim()].length);
const tooLong = computed(() => length.value > MAX_MESSAGE_CHARS);

// Captain-imposed timed mute: the composer locks with a countdown (the channel
// also refuses sends, and every peer drops a muted member's messages).
const muted = computed(() => !!selfMuteUntil.value);
const canSend = computed(
  () =>
    !!currentRoom.value &&
    isConnected.value &&
    isParticipant.value &&
    mlsStatus.value === "ready" &&
    !muted.value &&
    length.value > 0 &&
    !tooLong.value,
);
const composerDisabled = computed(
  () => !currentRoom.value || !isConnected.value || !isParticipant.value || mlsStatus.value !== "ready" || muted.value,
);
const placeholder = computed(() =>
  !currentRoom.value
    ? t("chat.composerPickRoom")
    : !isParticipant.value
      ? t("chat.composerJoinFirst")
      : muted.value
        ? t("chat.mutedSelf", { time: formatRemaining(selfMuteUntil.value!, Date.now()) })
        : mlsStatus.value !== "ready"
          ? t("chat.composerEstablishing")
          : t("chat.composerPlaceholder"),
);

async function send() {
  if (!canSend.value) return;
  const text = draft.value.trim();
  ch.sendMessage(text);
  draft.value = "";
  // On the safe lane (MLS over Tor) the base rate is zero and nothing is written.
  await chargeHp(msgAction.value, { bytes: new Blob([text]).size });
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="border-t border-current/10 p-4 bg-bubble-bg-light dark:bg-bubble-bg-dark">
    <!-- The per-message rate: "Free" once MLS is ready over Tor, which makes the
         encryption state legible in a way the lock badge alone is not. -->
    <div class="mb-2 flex items-center justify-end gap-2 text-[11px]">
      <span
        v-if="draft"
        class="mr-auto tabular-nums"
        :class="tooLong ? 'font-bold text-error-light dark:text-error-dark' : 'opacity-60'"
        data-testid="msg-length"
      >
        {{ $t('chat.length', { n: length, max: MAX_MESSAGE_CHARS }) }}
      </span>
      <span
        v-if="msgPrice === 0"
        class="rounded-md border border-success-light/40 px-1.5 py-0.5 font-bold text-success-light dark:border-success-dark/40 dark:text-success-dark"
        data-testid="hp-msg-free"
      >
        {{ $t('hp.free') }}
      </span>
      <OyaHpPrice
        v-else
        :centi="msgPrice"
        :unit="$t('hp.unitMessage')"
        :explain="explainFor(msgAction)"
        data-testid="hp-msg-rate"
      />
    </div>

    <div class="flex gap-3">
      <EmojiPicker :disabled="!currentRoom || !isParticipant" @select="draft += $event" />
      <OyaTextArea
        v-model="draft"
        :rows="1"
        :placeholder="placeholder"
        :disabled="composerDisabled"
        class="max-h-32 min-h-[3rem] flex-1 text-sm"
        @keydown="onKeydown"
      />
      <OyaButton type="button" :disabled="!canSend" :class="{ 'opacity-40 cursor-not-allowed': !canSend }" @click="send">
        <font-awesome-icon icon="paper-plane" />{{ $t('chat.send') }}
      </OyaButton>
    </div>
  </div>
</template>
