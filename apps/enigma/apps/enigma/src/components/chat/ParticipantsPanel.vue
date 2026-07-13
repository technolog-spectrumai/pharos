<script setup lang="ts">
import { OyaEmptyState } from "rakotis";
import type { ChatChannel } from "rakotis";
import ParticipantRow from "./ParticipantRow.vue";

const props = defineProps<{ channel: ChatChannel; compact?: boolean }>();
const { participants } = props.channel;
</script>

<template>
  <div class="space-y-3">
    <ParticipantRow v-for="p in participants" :key="p.id ?? p.name" :participant="p" :compact="compact" />
    <OyaEmptyState v-if="!participants.length" size="sm">
      {{ compact ? "No participants." : "No participants yet." }}
    </OyaEmptyState>
  </div>
</template>
