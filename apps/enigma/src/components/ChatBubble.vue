<script setup lang="ts">
// One message, the way Signal draws it: ours on the right in the accent colour,
// theirs on the left in grey. In a run of messages from the same person, the
// name shows on the first bubble and the avatar beside the last, so a run reads
// as one block. The time (and the lock) sit small inside the bubble.
import { computed } from "vue";
import { formatTime } from "rakotis";
import { OyaAvatar } from "petalite/primitives";
import type { Message } from "../stores/chat";

const props = withDefaults(defineProps<{ message: Message; first?: boolean; last?: boolean }>(), {
  first: true,
  last: true,
});

// A steady colour per name, so a person is recognisable down the conversation.
const NAME_COLOURS = ["#e07a5f", "#81b29a", "#f2cc8f", "#6aa9e9", "#c792ea", "#4fc1b0", "#f28fad", "#a3be8c"];
const nameColour = computed(() => {
  let h = 0;
  for (const c of props.message.user ?? "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return NAME_COLOURS[h % NAME_COLOURS.length];
});
</script>

<template>
  <article
    class="flex min-w-0 items-end gap-2"
    :class="[message.self ? 'justify-end' : 'justify-start', first ? 'mt-3' : 'mt-0.5']"
  >
    <template v-if="!message.self">
      <OyaAvatar
        v-if="last"
        size="sm"
        :name="message.user"
        :src="message.avatar_url"
        :initials="message.initials"
      />
      <span v-else class="w-8 shrink-0" />
    </template>

    <div
      :class="[
        message.self
          ? 'bg-[#4f5bc4] text-white'
          : 'bg-black/5 text-text-main-light dark:bg-white/10 dark:text-text-main-dark',
        message.self ? (last ? 'rounded-br-md' : '') : (last ? 'rounded-bl-md' : ''),
      ]"
      class="min-w-0 max-w-[80%] overflow-hidden rounded-2xl px-3 py-2 sm:max-w-[70%] xl:max-w-[36rem]"
      data-testid="bubble"
    >
      <p v-if="!message.self && first" class="mb-0.5 text-xs font-semibold" :style="{ color: nameColour }">
        {{ message.user }}
      </p>
      <a
        v-if="message.type === 'image_message' && message.image_data"
        :href="message.image_data"
        target="_blank"
        rel="noopener noreferrer"
        class="block"
      >
        <img :src="message.image_data" alt="image" class="max-h-72 max-w-full rounded-xl object-contain" />
      </a>
      <audio
        v-else-if="message.type === 'voice_message' && message.audio_data"
        :src="message.audio_data"
        controls
        class="w-60 max-w-full"
      />
      <!-- A map share (pin / location / region) from the Map tab, which this
           app no longer has — in an old history, or from a peer on an older
           build. Say so instead of rendering an empty bubble: it carries no
           text of its own. -->
      <p v-else-if="message.type.startsWith('map_')" class="text-xs italic opacity-60"
         data-testid="map-share-unavailable">
        {{ $t('chat.mapShareUnavailable') }}
      </p>
      <p v-else class="whitespace-pre-wrap break-words text-[15px] leading-snug [overflow-wrap:anywhere]">
        {{ message.content }}
      </p>


      <p
        class="mt-0.5 flex items-center justify-end gap-1 text-[10px]"
        :class="message.self ? 'text-white/70' : 'opacity-50'"
      >
        {{ formatTime(message.timestamp) }}
        <font-awesome-icon v-if="message.encrypted" icon="lock" :title="$t('chat.a11yEncrypted')" />
      </p>
    </div>
  </article>
</template>
