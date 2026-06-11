<script setup lang="ts">
// Aurora relay chat — MLS-encrypted (where supported) chat over the toto telegraph
// WebSocket relay. No P2P, no voice calls. Async voice messages + images are
// supported (recorded clip / picked file relayed over the socket).
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { useChatStore } from "../stores/chat";
import ChatBubble from "../components/ChatBubble.vue";

defineProps<{ darkMode: boolean }>();

const chat = useChatStore();
const relay = chat.relay;

const { rooms, loadingRooms, currentRoom, messages, participants, isConnected, isParticipant, mlsStatus, isEncrypted, error } = relay;

const draft = ref("");
const scroller = ref<HTMLElement | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);

const encrypted = computed(() => isEncrypted.value);

onMounted(() => {
  void relay.fetchRooms();
  void chat.syncRuntimeIdentity();
});

watch(messages, async () => {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}, { deep: true });

function openRoom(slug: string) {
  void relay.joinRoom(slug);
}

function send() {
  const text = draft.value.trim();
  if (!text) return;
  void relay.sendMessage(text);
  draft.value = "";
}

function pickImage() {
  imageInput.value?.click();
}
function onImage(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void relay.sendImage(file);
  if (imageInput.value) imageInput.value.value = "";
}

// ── Async voice message (record → relay), no real-time call ──────────────────
const recording = ref(false);
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

async function toggleRecord() {
  if (recording.value) {
    recorder?.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
      if (blob.size) void relay.sendAudio(blob);
      recording.value = false;
    };
    recorder.start();
    recording.value = true;
  } catch {
    recording.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 gap-3 overflow-hidden">
    <!-- Room list -->
    <aside
      :class="darkMode ? 'border-accent-1 bg-bubble-bg-dark' : 'border-accent-2 bg-bubble-bg-light'"
      class="hidden w-60 shrink-0 flex-col overflow-y-auto rounded-lg border p-2 sm:flex"
    >
      <p class="px-2 py-1 text-[10px] uppercase tracking-wide opacity-50">{{ $t('chat.rooms') }}</p>
      <p v-if="loadingRooms" class="px-2 py-2 text-xs opacity-50">…</p>
      <button
        v-for="r in rooms"
        :key="r.slug"
        type="button"
        :class="currentRoom?.slug === r.slug ? (darkMode ? 'bg-accent-dark/30' : 'bg-accent-light/20') : 'hover:opacity-70'"
        class="flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm transition"
        @click="openRoom(r.slug)"
      >
        <span class="truncate">{{ r.name }}</span>
        <span class="text-[10px] opacity-50">{{ r.participant_count }}</span>
      </button>
    </aside>

    <!-- Conversation -->
    <section class="flex min-w-0 flex-1 flex-col">
      <header
        :class="darkMode ? 'border-accent-1 bg-bubble-bg-dark' : 'border-accent-2 bg-bubble-bg-light'"
        class="flex shrink-0 items-center justify-between gap-2 rounded-lg border px-3 py-2"
      >
        <div class="min-w-0">
          <p class="truncate text-sm font-bold">{{ currentRoom?.name ?? $t('chat.selectRoom') }}</p>
          <p class="text-[10px] opacity-50">
            <span v-if="isConnected">{{ encrypted ? '🔒 ' + $t('chat.encrypted') : $t('chat.connected') }}</span>
            <span v-else>{{ $t('chat.disconnected') }}</span>
            <span v-if="participants.length"> · {{ participants.length }}</span>
            <span v-if="mlsStatus === 'key_exchange'"> · 🔑</span>
          </p>
        </div>
        <button
          v-if="currentRoom && !isParticipant"
          type="button"
          class="shrink-0 rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
          @click="relay.joinParticipant()"
        >{{ $t('chat.join') }}</button>
        <button
          v-else-if="currentRoom"
          type="button"
          class="shrink-0 rounded-lg border border-current/20 px-3 py-1.5 text-xs transition hover:opacity-80"
          @click="relay.leaveParticipant()"
        >{{ $t('chat.leave') }}</button>
      </header>

      <p v-if="error" class="mt-2 rounded-lg bg-warn-dark/20 px-3 py-1.5 text-xs text-warn-dark">{{ error }}</p>

      <div ref="scroller" class="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto px-1">
        <ChatBubble
          v-for="m in messages"
          :key="m.id"
          :dark-mode="darkMode"
          :message="m"
          :can-save-to-vault="false"
        />
      </div>

      <!-- Composer -->
      <div
        v-if="currentRoom && isParticipant"
        :class="darkMode ? 'border-accent-1 bg-bubble-bg-dark' : 'border-accent-2 bg-bubble-bg-light'"
        class="mt-2 flex shrink-0 items-center gap-2 rounded-lg border px-2 py-2"
      >
        <button type="button" class="rounded-lg px-2 py-1.5 text-sm transition hover:opacity-70" :title="$t('chat.image')" @click="pickImage">
          <font-awesome-icon icon="image" />
        </button>
        <input ref="imageInput" type="file" accept="image/*" class="hidden" @change="onImage" />
        <button
          type="button"
          :class="recording ? 'text-warn-dark' : ''"
          class="rounded-lg px-2 py-1.5 text-sm transition hover:opacity-70"
          :title="$t('chat.voice')"
          @click="toggleRecord"
        >
          <font-awesome-icon icon="microphone" />
        </button>
        <input
          v-model="draft"
          type="text"
          :placeholder="$t('chat.typeMessage')"
          class="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none"
          @keydown.enter="send"
        />
        <button
          type="button"
          :disabled="!isConnected"
          class="rounded-lg bg-accent-dark px-3 py-1.5 text-sm font-semibold text-primary-bg-dark transition hover:opacity-90 disabled:opacity-40"
          @click="send"
        >
          <font-awesome-icon icon="paper-plane" />
        </button>
      </div>
    </section>
  </div>
</template>
