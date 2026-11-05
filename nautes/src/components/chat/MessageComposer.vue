<script setup lang="ts">
import { ref, computed, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { OyaHpPrice, formatRemaining, messageActionId } from "rakotis";
import { OyaButton, OyaTextArea } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import AttachmentPreview from "./AttachmentPreview.vue";
import EmojiPicker from "./EmojiPicker.vue";
import VoiceRecorderButton from "./VoiceRecorderButton.vue";
import { useChatStore } from "../../stores/chat";
import { useNetworkStore } from "../../stores/network";
import { chargeHp, explainFor, priceFor } from "../hp/useHp";

const { t } = useI18n();

const props = defineProps<{ channel: ChatChannel }>();
const ch = props.channel;
const { currentRoom, isConnected, isParticipant, mlsStatus, selfMuteUntil } = ch;

// A live/soon-live voice call owns the default microphone device; block staging a
// voice message while one is active so the two don't fight over cpal input.
const voxBusy = computed(() =>
  ["calling", "connected"].includes(useChatStore().vox?.phase.value ?? "idle"),
);

// Which message lane this room is on right now. Both halves are live: Tor is a
// per-profile switch and MLS comes up asynchronously, so the rate chip below has
// to track them rather than sample once at mount.
const network = useNetworkStore();
const onTor = computed(() => network.useTor);
const msgAction = computed(() =>
  messageActionId({ tor: onTor.value, mlsReady: mlsStatus.value === "ready" }),
);
const msgPrice = computed(() => priceFor(msgAction.value));

const draft = ref("");
const uploadingImage = ref(false);
const uploadProgress = ref(0);
const imageFileInput = ref<HTMLInputElement | null>(null);

interface PendingAttachment {
  kind: "image" | "voice";
  data: File | Blob;
  url: string;
  label: string;
}
const pending = ref<PendingAttachment | null>(null);

function clearPending() {
  if (pending.value) {
    URL.revokeObjectURL(pending.value.url);
    pending.value = null;
  }
}
function stagePending(kind: "image" | "voice", data: File | Blob, label: string) {
  clearPending();
  pending.value = { kind, data, url: URL.createObjectURL(data), label };
}
onUnmounted(clearPending);

function handleImageFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (imageFileInput.value) imageFileInput.value.value = "";
  if (!file) return;
  stagePending("image", file, file.name);
}
function onVoiceStaged(blob: Blob, label: string) {
  stagePending("voice", blob, label);
}

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
    (!!draft.value.trim() || !!pending.value),
);
const composerDisabled = computed(
  () => !currentRoom.value || !isConnected.value || !isParticipant.value || mlsStatus.value !== "ready" || muted.value,
);
const attachDisabled = computed(() => !currentRoom.value || !isConnected.value || !isParticipant.value || muted.value);
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
  const att = pending.value;
  if (att) {
    pending.value = null;
    try {
      if (att.kind === "image") {
        uploadingImage.value = true;
        uploadProgress.value = 0;
        await ch.sendImage(att.data as File, (pct) => (uploadProgress.value = pct));
      } else {
        await ch.sendAudio(att.data as Blob);
      }
      // Attachments are billed by size, which is the whole reason size is billed
      // at all: on a clearnet lane a 4 MiB voice note is a far more distinctive
      // event to an observer than a line of text.
      await billSend(att.data instanceof Blob ? att.data.size : 0);
    } finally {
      uploadingImage.value = false;
      uploadProgress.value = 0;
      URL.revokeObjectURL(att.url);
    }
  }
  if (text) {
    ch.sendMessage(text);
    draft.value = "";
    // Text is bytes, so this is the base rate and nothing more — and on the safe
    // lane (MLS over Tor) the base rate is zero and nothing is written at all.
    await billSend(new Blob([text]).size);
  }
}

/** Bill one send on whichever lane the room is currently on. Never confirmed and
 *  never blocking: the price is a fraction of an HP, and a composer that stops
 *  to ask would be unusable. */
async function billSend(bytes: number): Promise<void> {
  await chargeHp(messageActionId({ tor: onTor.value, mlsReady: mlsStatus.value === "ready" }), {
    bytes,
  });
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
    <!-- The per-message rate for the lane this room is CURRENTLY on. This is the
         one price in the app that changes under you, and that is exactly its
         value: it drops to "Free" the moment MLS reports ready over Tor, which
         makes the encryption state legible in a way the lock badge alone is not. -->
    <div class="mb-2 flex items-center justify-end gap-2 text-[11px]">
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

    <AttachmentPreview v-if="pending" :pending="pending" @clear="clearPending" />

    <div v-if="uploadingImage" class="mb-2 flex items-center gap-2 text-xs opacity-60">
      <span>Sending…</span>
      <div class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-current/20">
        <div
          class="absolute left-0 top-0 h-full rounded-full bg-current transition-all duration-100"
          :style="{ width: uploadProgress + '%' }"
        ></div>
      </div>
      <span>{{ uploadProgress }}%</span>
    </div>

    <div class="flex gap-3">
      <input
        ref="imageFileInput"
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        class="hidden"
        @change="handleImageFile"
      />
      <button
        type="button"
        :disabled="attachDisabled || uploadingImage"
        :class="[
          'border-accent-2 text-text-main-light dark:border-accent-1 dark:text-text-main-dark',
          attachDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80',
        ]"
        class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition"
        :title="$t('chat.sendImage')"
        @click="imageFileInput?.click()"
      >
        <font-awesome-icon :icon="uploadingImage ? 'spinner' : 'image'" :spin="uploadingImage" />
      </button>

      <VoiceRecorderButton :disabled="!currentRoom || !isParticipant || voxBusy" @staged="onVoiceStaged" />
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
        <font-awesome-icon icon="paper-plane" />Send
      </OyaButton>
    </div>
  </div>
</template>
