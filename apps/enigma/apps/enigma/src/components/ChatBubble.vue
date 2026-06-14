<script setup lang="ts">
import { ref, onMounted } from "vue";
import type { Message } from "../stores/chat";

const props = defineProps<{
  darkMode: boolean;
  message: Message;
  canSaveToVault?: boolean;
}>();

const emit = defineEmits<{
  (e: "joinP2p", ticket: string): void;
  (e: "joinP2pAuto", name: string): void;
  (e: "saveToVault", message: Message): void;
}>();

// "Join private room" invite cards carry a P2P ticket → render it as a QR code.
const qr = ref("");
onMounted(async () => {
  if (props.message.type === "p2p_invite" && props.message.invite_ticket) {
    try {
      const { toDataURL } = await import("qrcode");
      qr.value = await toDataURL(props.message.invite_ticket, { errorCorrectionLevel: "L", margin: 1, width: 180 });
    } catch { /* ignore */ }
  }
});
</script>

<template>
  <article
    class="flex min-w-0 gap-3"
    :class="message.self ? 'justify-end' : 'justify-start'"
  >
    <div
      v-if="!message.self"
      :class="
        message.type === 'system_error' || message.type === 'system_info'
          ? 'border-current/20 opacity-50'
          : darkMode ? 'border-accent-1' : 'border-accent-2'
      "
      class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border text-xs font-bold"
    >
      <img
        v-if="message.avatar_url"
        :src="message.avatar_url"
        :alt="message.user"
        class="h-full w-full object-cover"
      />
      <span v-else>{{ message.initials }}</span>
    </div>

    <div
      :class="[
        message.type === 'system_error'
          ? 'border-warn-dark bg-warn-dark/10 text-warn-dark'
          : message.type === 'system_info'
            ? 'border-current/10 opacity-60 italic'
            : darkMode
              ? 'bg-bubble-bg-dark border-accent-1'
              : 'bg-bubble-bg-light border-accent-2',
        message.self ? 'text-right' : '',
      ]"
      class="min-w-0 max-w-[calc(100%-3.25rem)] overflow-hidden rounded-lg border p-3 shadow-sm sm:max-w-[78%] xl:max-w-[42rem]"
    >
      <p class="text-xs font-semibold opacity-60">{{ message.user }}</p>

      <!-- P2P "join private room" invite card (Forum only) -->
      <div v-if="message.type === 'p2p_invite'" class="mt-1 space-y-2">
        <p class="flex items-center gap-1.5 text-sm font-semibold">
          <font-awesome-icon icon="circle-nodes" />{{ $t('chat.joinPrivateRoom') }}
        </p>
        <p v-if="message.invite_name && !message.invite_auto" class="text-xs opacity-70">{{ message.invite_name }}</p>
        <img v-if="qr" :src="qr" alt="" class="h-36 w-36 rounded-lg bg-white p-1.5" />
        <button
          v-if="!message.self"
          type="button"
          class="rounded-lg border border-current/25 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
          @click="message.invite_auto ? emit('joinP2pAuto', message.invite_name ?? '') : emit('joinP2p', message.invite_ticket!)"
        >
          <font-awesome-icon icon="circle-nodes" class="mr-1" />{{ $t('chat.join') }}
        </button>
        <p v-else class="text-[10px] opacity-50">{{ $t('chat.invitePosted') }}</p>
      </div>

      <a
        v-else-if="message.type === 'image_message' && message.image_data"
        :href="message.image_data"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-1 block"
      >
        <img
          :src="message.image_data"
          alt="image"
          class="max-h-64 max-w-full rounded object-contain"
        />
      </a>
      <audio
        v-else-if="message.type === 'voice_message' && message.audio_data"
        :src="message.audio_data"
        controls
        class="mt-2 w-full max-w-xs rounded"
      />
      <p v-else class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90 [overflow-wrap:anywhere]">
        {{ message.content }}
      </p>
      <button
        v-if="canSaveToVault && message.type === 'image_message' && message.image_data"
        type="button"
        class="mt-1 text-[10px] underline opacity-60 transition hover:opacity-100"
        :class="message.self ? 'ml-auto block' : ''"
        @click="emit('saveToVault', message)"
      >
        <font-awesome-icon icon="hard-drive" class="mr-1" />{{ $t('chat.saveToVault') }}
      </button>

      <p
        class="mt-1 flex items-center gap-1 text-[10px] opacity-40"
        :class="message.self ? 'justify-end' : ''"
      >
        <font-awesome-icon
          v-if="message.encrypted"
          icon="lock"
          class="text-success-dark opacity-80"
          title="End-to-end encrypted"
        />
        {{ message.timestamp.toLocaleTimeString() }}
      </p>
    </div>

    <div
      v-if="message.self"
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border text-xs font-bold"
    >
      <img
        v-if="message.avatar_url"
        :src="message.avatar_url"
        :alt="message.user"
        class="h-full w-full object-cover"
      />
      <span v-else>{{ message.initials }}</span>
    </div>
  </article>
</template>
