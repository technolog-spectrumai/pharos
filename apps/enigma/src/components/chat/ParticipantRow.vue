<script setup lang="ts">
import { formatRemaining } from "rakotis";
import { OyaAvatar, OyaBadge } from "petalite/primitives";
import type { Participant } from "rakotis";

// `canModerate` = the local user is the room captain and this row is not them —
// shows the moderation (gavel) button; the panel opens the moderation sheet.
defineProps<{ participant: Participant; compact?: boolean; canModerate?: boolean }>();
defineEmits<{ moderate: [] }>();
</script>

<template>
  <div class="flex items-center gap-3">
    <OyaAvatar :name="participant.name" :src="participant.avatar_url" :size="compact ? 'sm' : 'md'" />
    <div class="min-w-0 flex-1">
      <p class="flex items-center gap-1.5 truncate text-sm font-semibold">
        {{ participant.name }}
        <font-awesome-icon
          v-if="participant.isCaptain"
          icon="star"
          class="shrink-0 text-highlight"
          :title="$t('chat.captain')"
        />
        <font-awesome-icon
          v-if="participant.muteUntil && participant.muteUntil > Date.now()"
          icon="comment-slash"
          class="shrink-0 text-warn-dark"
          :title="$t('chat.mutedFor', { time: formatRemaining(participant.muteUntil, Date.now()) })"
        />
      </p>
    </div>
    <button
      v-if="canModerate"
      type="button"
      class="shrink-0 rounded-lg border border-transparent px-2 py-1 text-xs opacity-50 transition hover:border-current/20 hover:opacity-100"
      :title="$t('chat.moderate')"
      @click="$emit('moderate')"
    >
      <font-awesome-icon icon="gavel" />
    </button>
    <OyaBadge v-if="!compact" tone="success">On</OyaBadge>
  </div>
</template>
