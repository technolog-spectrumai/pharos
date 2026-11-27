<script setup lang="ts">
import LetterAvatar from "../LetterAvatar.vue";
import type { Participant } from "rakotis";

defineProps<{ participant: Participant; compact?: boolean }>();
</script>

<template>
  <div class="flex items-center gap-3">
    <LetterAvatar :name="participant.name" :size="compact ? 'sm' : 'md'" />
    <p class="min-w-0 flex-1 truncate text-sm font-semibold">{{ participant.name }}</p>
    <span
      v-if="participant.linked !== undefined"
      class="flex shrink-0 items-center gap-1.5 text-xs"
      :class="participant.linked ? 'text-success-light dark:text-success-dark' : 'opacity-50'"
    >
      <span class="h-2 w-2 rounded-full" :class="participant.linked ? 'bg-current' : 'border border-current'" />
      {{ participant.linked ? $t("chat.memberLinked") : $t("chat.memberAway") }}
    </span>
  </div>
</template>
