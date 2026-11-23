<script setup lang="ts">
import { OyaEmptyState } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import ParticipantRow from "./ParticipantRow.vue";

const props = defineProps<{ channel: ChatChannel; compact?: boolean }>();
const { participants } = props.channel;
</script>

<template>
  <div class="space-y-3">
    <ParticipantRow
      v-for="p in participants"
      :key="p.id ?? p.name"
      :participant="p"
      :compact="compact"
    />
    <OyaEmptyState v-if="!participants.length" size="sm">
      {{ compact ? $t("chat.noParticipants") : $t("chat.noParticipantsYet") }}
    </OyaEmptyState>
  </div>
</template>
