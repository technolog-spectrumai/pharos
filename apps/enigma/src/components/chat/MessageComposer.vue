<script setup lang="ts">
import { ref, computed, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaTextArea } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import AttachmentPreview from "./AttachmentPreview.vue";
import EmojiPicker from "./EmojiPicker.vue";
import VoiceRecorderButton from "./VoiceRecorderButton.vue";

const { t } = useI18n();

const props = defineProps<{ channel: ChatChannel }>();
const ch = props.channel;
const { currentRoom, isParticipant, mlsStatus } = ch;

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

// Sending needs encryption, not a live link: a message for a member who is not
// linked yet waits on this device and goes when the link comes up.
const ready = computed(() => !!currentRoom.value && isParticipant.value && mlsStatus.value === "ready");
const canSend = computed(() => ready.value && (!!draft.value.trim() || !!pending.value));
const placeholder = computed(() =>
  !currentRoom.value
    ? t("chat.composerPickRoom")
    : !isParticipant.value
      ? t("chat.composerJoinFirst")
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
    } finally {
      uploadingImage.value = false;
      uploadProgress.value = 0;
      URL.revokeObjectURL(att.url);
    }
  }
  if (text) {
    ch.sendMessage(text);
    draft.value = "";
  }
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
    <AttachmentPreview v-if="pending" :pending="pending" @clear="clearPending" />

    <div v-if="uploadingImage" class="mb-2 flex items-center gap-2 text-xs opacity-60">
      <span>{{ $t("chat.sending") }}</span>
      <div class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-current/20">
        <div
          class="absolute left-0 top-0 h-full rounded-full bg-current transition-all duration-100"
          :style="{ width: uploadProgress + '%' }"
        ></div>
      </div>
      <span>{{ uploadProgress }}%</span>
    </div>

    <!-- One row of controls. On a phone the text field takes the first line on
         its own and the buttons sit under it; from sm up everything is one row. -->
    <div class="flex flex-wrap items-end gap-2 sm:flex-nowrap sm:gap-3">
      <OyaTextArea
        v-model="draft"
        :rows="1"
        :placeholder="placeholder"
        :disabled="!ready"
        class="order-first max-h-32 min-h-[2.75rem] w-full text-sm sm:order-none sm:w-auto sm:flex-1"
        @keydown="onKeydown"
      />
      <input
        ref="imageFileInput"
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        class="hidden"
        @change="handleImageFile"
      />
      <button
        type="button"
        :disabled="!ready || uploadingImage"
        :class="!ready ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80'"
        class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-accent-2 text-text-main-light transition sm:-order-1 dark:border-accent-1 dark:text-text-main-dark"
        :title="$t('chat.sendImage')"
        :aria-label="$t('chat.sendImage')"
        @click="imageFileInput?.click()"
      >
        <font-awesome-icon :icon="uploadingImage ? 'spinner' : 'image'" :spin="uploadingImage" />
      </button>
      <VoiceRecorderButton class="sm:-order-1" :disabled="!ready" @staged="onVoiceStaged" />
      <EmojiPicker class="sm:-order-1" :disabled="!ready" @select="draft += $event" />
      <OyaButton
        type="button"
        class="ml-auto shrink-0 sm:ml-0"
        :disabled="!canSend"
        :class="{ 'opacity-40 cursor-not-allowed': !canSend }"
        @click="send"
      >
        <font-awesome-icon icon="paper-plane" />{{ $t("chat.send") }}
      </OyaButton>
    </div>
  </div>
</template>
