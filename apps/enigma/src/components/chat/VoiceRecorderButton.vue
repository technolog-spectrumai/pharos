<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { isTauri, invoke } from "rakotis";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

// `round`: the composer's round accent button (Signal's mic).
defineProps<{ disabled?: boolean; round?: boolean }>();
const emit = defineEmits<{ staged: [Blob, string] }>();

const isRecording = ref(false);
const recordingSeconds = ref(0);
let mediaRecorder: MediaRecorder | null = null;
let recordingChunks: Blob[] = [];
let recordingInterval: ReturnType<typeof setInterval> | null = null;

function label() {
  const m = Math.floor(recordingSeconds.value / 60);
  const s = recordingSeconds.value % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function stopTimer() {
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
}
function pickAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

async function toggle() {
  if (isRecording.value) {
    if (isTauri()) {
      stopTimer();
      isRecording.value = false;
      try {
        const bytes = await invoke<number[]>("audio_stop_recording");
        if (bytes.length > 0) {
          const blob = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
          emit("staged", blob, t("chat.voiceCaption", { time: label() }));
        }
      } catch (e) {
        console.error("[voice] stop failed:", e);
      }
    } else {
      mediaRecorder?.stop();
    }
    return;
  }
  try {
    recordingSeconds.value = 0;
    if (isTauri()) {
      await invoke("audio_start_recording");
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunks = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunks.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopTimer();
        isRecording.value = false;
        if (recordingChunks.length === 0) return;
        const blob = new Blob(recordingChunks, { type: mr.mimeType || mimeType || "audio/webm" });
        emit("staged", blob, t("chat.voiceCaption", { time: label() }));
      };
      mr.start();
      mediaRecorder = mr;
    }
    isRecording.value = true;
    recordingInterval = setInterval(() => {
      recordingSeconds.value++;
    }, 1000);
  } catch (e) {
    console.error("[voice] recording failed:", e);
  }
}

onUnmounted(stopTimer);
</script>

<template>
  <button
    :disabled="disabled"
    :class="[
      round
        ? (isRecording ? 'bg-warn-dark text-white animate-pulse' : 'bg-[#4f5bc4] text-white') + ' h-11 min-w-11 rounded-full px-3'
        : (isRecording
          ? 'border-warn-light text-warn-light dark:border-warn-dark dark:text-warn-dark animate-pulse'
          : 'border-accent-2 text-text-main-light dark:border-accent-1 dark:text-text-main-dark') + ' h-11 rounded-lg border px-2.5',
      disabled ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80',
    ]"
    class="inline-flex shrink-0 items-center justify-center gap-1.5 transition"
    :title="isRecording ? t('chat.stopRecording') : t('chat.recordVoice')"
    :aria-label="isRecording ? t('chat.stopRecording') : t('chat.recordVoice')"
    @click="toggle"
  >
    <font-awesome-icon :icon="isRecording ? 'stop' : 'microphone'" class="text-sm" />
    <span v-if="isRecording" class="font-mono text-xs">{{ label() }}</span>
  </button>
</template>
