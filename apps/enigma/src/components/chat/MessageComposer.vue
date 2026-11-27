<script setup lang="ts">
import { ref, computed, nextTick, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
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
// The field grows with what is typed, up to a few lines, as in Signal.
const field = ref<HTMLTextAreaElement | null>(null);
function grow() {
  const el = field.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
}
watch(draft, () => nextTick(grow));
const hasContent = computed(() => !!draft.value.trim() || !!pending.value);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="shrink-0 border-t border-current/10 px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:px-3 bg-bubble-bg-light dark:bg-bubble-bg-dark">
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

    <!-- Signal's composer: attach, a rounded field with the emoji button inside it,
         and one round button that records a voice note while the field is empty
         and sends once there is something to send. -->
    <div class="flex items-end gap-2">
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
        :class="!ready ? 'opacity-40 cursor-not-allowed' : 'hover:bg-current/10'"
        class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg transition"
        :title="$t('chat.sendImage')"
        :aria-label="$t('chat.sendImage')"
        @click="imageFileInput?.click()"
      >
        <font-awesome-icon :icon="uploadingImage ? 'spinner' : 'plus'" :spin="uploadingImage" />
      </button>

      <div
        class="flex min-w-0 flex-1 items-end rounded-3xl bg-black/5 pl-4 pr-1 dark:bg-white/10"
        :class="{ 'opacity-50': !ready }"
      >
        <textarea
          ref="field"
          v-model="draft"
          rows="1"
          :placeholder="placeholder"
          :disabled="!ready"
          class="max-h-32 min-h-[2.75rem] min-w-0 flex-1 resize-none bg-transparent py-3 text-[15px] leading-snug outline-none placeholder:opacity-50"
          data-testid="composer-field"
          @keydown="onKeydown"
        />
        <EmojiPicker bare :disabled="!ready" class="mb-1" @select="draft += $event" />
      </div>

      <button
        v-if="hasContent"
        type="button"
        :disabled="!canSend"
        class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#4f5bc4] text-white transition hover:opacity-90 disabled:opacity-40"
        :title="$t('chat.send')"
        :aria-label="$t('chat.send')"
        data-testid="send-button"
        @click="send"
      >
        <font-awesome-icon icon="paper-plane" />
      </button>
      <VoiceRecorderButton v-else round :disabled="!ready" @staged="onVoiceStaged" />
    </div>
  </div>
</template>
