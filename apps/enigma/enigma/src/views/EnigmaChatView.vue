<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useChatStore } from "../stores/chat";
import OyaCard from "../components/OyaCard.vue";
import OyaButton from "../components/OyaButton.vue";

defineProps<{ darkMode: boolean }>();

const router = useRouter();
const chat = useChatStore();
const { rooms, currentRoom, messages, participants, wsStatus, loadingRooms, isConnected } =
  storeToRefs(chat);

const draft = ref("");
const messagesEl = ref<HTMLElement | null>(null);

onMounted(() => {
  if (!rooms.value.length) chat.fetchRooms();
});

onUnmounted(() => {
  // Keep WS alive across navigation — only clear on explicit leave
});

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  });
}

watch(messages, scrollToBottom, { deep: true });

function send() {
  if (!draft.value.trim()) return;
  chat.sendMessage(draft.value);
  draft.value = "";
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

const statusLabel = computed(() => {
  const map: Record<string, string> = {
    connected: "Live",
    connecting: "Connecting…",
    disconnected: "Offline",
    error: "Error",
  };
  return map[wsStatus.value] ?? wsStatus.value;
});

const statusClass = computed(() => ({
  connected: "bg-success-dark text-primary-bg-dark",
  connecting: "bg-warn-dark text-primary-bg-dark",
  disconnected: "opacity-50 border-current/20",
  error: "bg-warn-dark text-primary-bg-dark",
}[wsStatus.value] ?? ""));
</script>

<template>
  <section
    class="mx-auto grid w-full max-w-7xl flex-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_16rem]"
  >
    <!-- ROOMS -->
    <OyaCard :dark-mode="darkMode" class="hidden min-h-[70vh] flex-col lg:flex">
      <div class="flex items-center justify-between border-b border-current/10 pb-3">
        <h2 class="text-sm font-bold">
          <font-awesome-icon icon="comments" class="mr-2" />
          Rooms
        </h2>
        <button
          class="text-xs underline opacity-70 hover:opacity-100"
          @click="router.push('/')"
        >
          ← Back
        </button>
      </div>

      <div v-if="loadingRooms" class="mt-4 text-xs opacity-50">Loading…</div>

      <nav v-else class="mt-4 flex-1 space-y-2 overflow-y-auto">
        <button
          v-for="room in rooms"
          :key="room.slug"
          :class="
            currentRoom?.slug === room.slug
              ? darkMode
                ? 'bg-primary-bg-dark border-accent-dark'
                : 'bg-primary-bg-light border-accent-light'
              : darkMode
                ? 'border-accent-1 hover:bg-primary-bg-dark'
                : 'border-accent-2 hover:bg-primary-bg-light'
          "
          class="w-full rounded-lg border px-3 py-3 text-left transition"
          @click="chat.joinRoom(room.slug)"
        >
          <span class="block truncate text-sm font-semibold">{{ room.name }}</span>
          <span class="mt-1 block text-xs opacity-60">{{ room.participant_count }} participant{{ room.participant_count === 1 ? "" : "s" }}</span>
        </button>

        <p v-if="!rooms.length" class="text-xs opacity-50">No rooms found.</p>
      </nav>

      <OyaButton :dark-mode="darkMode" class="mt-4 w-full">
        <font-awesome-icon icon="plus" />
        New room
      </OyaButton>
    </OyaCard>

    <!-- CHATBOX -->
    <OyaCard
      :dark-mode="darkMode"
      :padded="false"
      class="grid min-h-[70vh] overflow-hidden grid-rows-[auto_minmax(0,1fr)_auto]"
    >
      <!-- Chat header -->
      <header class="flex flex-wrap items-center gap-3 border-b border-current/10 p-4">
        <div class="min-w-0 flex-1">
          <p
            :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
            class="text-xs font-semibold uppercase tracking-wide"
          >
            {{ currentRoom ? "Active room" : "No room selected" }}
          </p>
          <h2 class="mt-1 truncate text-2xl font-bold">
            {{ currentRoom?.name ?? "Select a room" }}
          </h2>
          <div v-if="currentRoom" class="mt-1 flex flex-wrap gap-3 text-xs opacity-70">
            <span>{{ currentRoom.participant_count }} participant{{ currentRoom.participant_count === 1 ? "" : "s" }}</span>
          </div>
        </div>

        <span
          :class="statusClass"
          class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold shadow-sm transition"
        >
          <font-awesome-icon
            :icon="isConnected ? 'check' : wsStatus === 'connecting' ? 'lock' : 'xmark'"
          />
          {{ statusLabel }}
        </span>
      </header>

      <!-- Messages -->
      <div
        ref="messagesEl"
        :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'"
        class="min-h-0 space-y-4 overflow-y-auto p-4"
      >
        <!-- Empty state -->
        <div
          v-if="!currentRoom"
          class="flex h-full flex-col items-center justify-center gap-3 opacity-40"
        >
          <font-awesome-icon icon="comments" class="text-4xl" />
          <p class="text-sm">Pick a room from the sidebar to start chatting.</p>
        </div>

        <article
          v-for="msg in messages"
          :key="msg.id"
          class="flex min-w-0 gap-3"
          :class="msg.self ? 'justify-end' : 'justify-start'"
        >
          <!-- Avatar (others) -->
          <div
            v-if="!msg.self"
            :class="
              msg.participant_type === 'ai_agent'
                ? darkMode
                  ? 'bg-accent-dark text-primary-bg-dark'
                  : 'bg-accent-light text-primary-bg-light'
                : msg.type === 'system_error' || msg.type === 'system_info'
                  ? 'border-current/20 opacity-50'
                  : darkMode
                    ? 'border-accent-1'
                    : 'border-accent-2'
            "
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border text-xs font-bold"
          >
            <img
              v-if="msg.avatar_url"
              :src="msg.avatar_url"
              :alt="msg.initials"
              class="h-full w-full rounded-lg object-cover"
            />
            <span v-else>{{ msg.initials }}</span>
          </div>

          <!-- Bubble -->
          <div
            :class="[
              msg.type === 'system_error'
                ? 'border-warn-dark bg-warn-dark/10 text-warn-dark'
                : msg.type === 'system_info'
                  ? 'border-current/10 opacity-60 italic'
                  : darkMode
                    ? 'bg-bubble-bg-dark border-accent-1'
                    : 'bg-bubble-bg-light border-accent-2',
              msg.self ? 'text-right' : '',
            ]"
            class="min-w-0 max-w-[calc(100%-3.25rem)] overflow-hidden rounded-lg border p-3 shadow-sm sm:max-w-[78%]"
          >
            <p class="text-xs font-semibold opacity-60">{{ msg.user }}</p>
            <p
              class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90 [overflow-wrap:anywhere]"
            >
              {{ msg.content }}
            </p>
            <p class="mt-1 text-[10px] opacity-40">
              {{ msg.timestamp.toLocaleTimeString() }}
            </p>
          </div>

          <!-- Avatar (self) -->
          <div
            v-if="msg.self"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border text-xs font-bold"
          >
            {{ msg.initials }}
          </div>
        </article>
      </div>

      <!-- Composer -->
      <div
        :class="darkMode ? 'bg-bubble-bg-dark' : 'bg-bubble-bg-light'"
        class="border-t border-current/10 p-4"
      >
        <div class="flex gap-3">
          <textarea
            v-model="draft"
            rows="1"
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            :disabled="!isConnected"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30 disabled:opacity-30'
                : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30 disabled:opacity-30'
            "
            class="max-h-32 min-h-[3rem] flex-1 resize-none rounded-lg border px-3 py-2.5 text-sm outline-none transition"
            @keydown="onKeydown"
          />
          <OyaButton
            :dark-mode="darkMode"
            :type="'button'"
            :class="{ 'opacity-40 cursor-not-allowed': !isConnected || !draft.trim() }"
            @click="send"
          >
            <font-awesome-icon icon="paper-plane" />
            Send
          </OyaButton>
        </div>
      </div>
    </OyaCard>

    <!-- PARTICIPANTS -->
    <OyaCard :dark-mode="darkMode" class="hidden min-h-[70vh] lg:block">
      <div class="border-b border-current/10 pb-3">
        <h2
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-lg font-bold"
        >
          <font-awesome-icon icon="user" class="mr-2" />
          Participants
        </h2>
      </div>

      <div class="mt-4 space-y-3">
        <div
          v-for="p in participants"
          :key="p.name"
          class="flex items-center gap-3"
        >
          <div
            :class="
              p.type === 'ai_agent'
                ? darkMode
                  ? 'bg-accent-dark text-primary-bg-dark border-accent-dark'
                  : 'bg-accent-light text-primary-bg-light border-accent-light'
                : darkMode
                  ? 'border-accent-1'
                  : 'border-accent-2'
            "
            class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border text-xs font-bold"
          >
            <img
              v-if="p.avatar_url"
              :src="p.avatar_url"
              :alt="p.name"
              class="h-full w-full object-cover"
            />
            <span v-else>{{ p.name.slice(0, 2).toUpperCase() }}</span>
          </div>

          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ p.name }}</p>
            <p class="text-xs opacity-60">{{ p.type === "ai_agent" ? "AI Agent" : "Human" }}</p>
          </div>

          <span
            :class="
              darkMode
                ? 'bg-success-dark text-primary-bg-dark'
                : 'bg-success-light text-primary-bg-light'
            "
            class="rounded-full px-2 py-0.5 text-xs font-bold"
          >
            On
          </span>
        </div>

        <p v-if="!participants.length" class="text-xs opacity-40">
          No participants yet.
        </p>
      </div>
    </OyaCard>
  </section>
</template>
