<script setup lang="ts">
import { OyaAvatar, OyaBadge } from "rakotis";
import type { Participant } from "rakotis";

defineProps<{ participant: Participant; compact?: boolean }>();
</script>

<template>
  <div class="flex items-center gap-3">
    <OyaAvatar :name="participant.name" :src="participant.avatar_url" :size="compact ? 'sm' : 'md'" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold">{{ participant.name }}</p>
      <p v-if="!compact" class="text-xs opacity-60">Human</p>
    </div>
    <OyaBadge v-if="!compact" tone="success">On</OyaBadge>
  </div>
</template>
