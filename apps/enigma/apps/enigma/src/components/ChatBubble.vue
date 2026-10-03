<script setup lang="ts">
import { OyaAvatar, formatTime } from "rakotis";
import type { Message } from "../stores/chat";

defineProps<{ message: Message }>();
</script>

<template>
  <article class="flex min-w-0 gap-3" :class="message.self ? 'justify-end' : 'justify-start'">
    <OyaAvatar
      v-if="!message.self"
      :name="message.user"
      :src="message.avatar_url"
      :initials="message.initials"
      :muted="message.type === 'system_error' || message.type === 'system_info'"
    />

    <div
      :class="[
        message.type === 'system_error'
          ? 'border-warn-dark bg-warn-dark/10 text-warn-dark'
          : message.type === 'system_info'
            ? 'border-current/10 opacity-60 italic'
            : 'bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1',
        message.self ? 'text-right' : '',
      ]"
      class="min-w-0 max-w-[calc(100%-3.25rem)] overflow-hidden rounded-lg border p-3 shadow-sm sm:max-w-[78%] xl:max-w-[42rem]"
    >
      <p class="text-xs font-semibold opacity-60">{{ message.user }}</p>

      <a
        v-if="message.type === 'image_message' && message.image_data"
        :href="message.image_data"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-1 block"
      >
        <img :src="message.image_data" alt="image" class="max-h-64 max-w-full rounded object-contain" />
      </a>
      <audio
        v-else-if="message.type === 'voice_message' && message.audio_data"
        :src="message.audio_data"
        controls
        class="mt-2 w-full max-w-xs rounded"
      />
      <!-- A map share (pin / location / region) from the Map tab, which this
           app no longer has — in an old history, or from a peer on an older
           build. Say so instead of rendering an empty bubble: it carries no
           text of its own. -->
      <p v-else-if="message.type.startsWith('map_')" class="mt-1 text-xs italic opacity-50"
         data-testid="map-share-unavailable">
        {{ $t('chat.mapShareUnavailable') }}
      </p>
      <p v-else class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90 [overflow-wrap:anywhere]">
        {{ message.content }}
      </p>

      <p class="mt-1 flex items-center gap-1 text-[10px] opacity-40" :class="message.self ? 'justify-end' : ''">
        <font-awesome-icon
          v-if="message.encrypted"
          icon="lock"
          class="text-success-dark opacity-80"
          :title="$t('chat.a11yEncrypted')"
        />
        {{ formatTime(message.timestamp) }}
      </p>
    </div>

    <OyaAvatar
      v-if="message.self"
      :name="message.user"
      :src="message.avatar_url"
      :initials="message.initials"
    />
  </article>
</template>
