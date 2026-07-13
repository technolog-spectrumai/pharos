<script setup lang="ts">
import { ref, computed, onUnmounted } from "vue";
import { OyaButton, OyaTextArea } from "rakotis";
import type { ChatChannel } from "rakotis";
import AttachmentPreview from "./AttachmentPreview.vue";
import EmojiPicker from "./EmojiPicker.vue";
import VoiceRecorderButton from "./VoiceRecorderButton.vue";

const props = defineProps<{ channel: ChatChannel }>();
const ch = props.channel;
const { currentRoom, isConnected, isParticipant, mlsStatus } = ch;

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

const canSend = computed(
  () =>
    !!currentRoom.value &&
    isConnected.value &&
    isParticipant.value &&
    mlsStatus.value === "ready" &&
    (!!draft.value.trim() || !!pending.value),
);
const composerDisabled = computed(
  () => !currentRoom.value || !isConnected.value || !isParticipant.value || mlsStatus.value !== "ready",
);
const attachDisabled = computed(() => !currentRoom.value || !isConnected.value || !isParticipant.value);
const placeholder = computed(() =>
  !currentRoom.value
    ? "Select a room to start chatting"
    : !isParticipant.value
      ? "Join this room to send messages"
      : mlsStatus.value !== "ready"
        ? "Establishing secure session…"
        : "Message…",
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
        title="Send image"
        @click="imageFileInput?.click()"
      >
        <font-awesome-icon :icon="uploadingImage ? 'spinner' : 'image'" :spin="uploadingImage" />
      </button>

      <VoiceRecorderButton :disabled="!currentRoom || !isParticipant" @staged="onVoiceStaged" />
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
