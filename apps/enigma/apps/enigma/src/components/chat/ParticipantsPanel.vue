<script setup lang="ts">
import { ref } from "vue";
import { OyaEmptyState } from "rakotis";
import type { ChatChannel, Participant } from "rakotis";
import ParticipantRow from "./ParticipantRow.vue";
import ModerateMemberModal from "./ModerateMemberModal.vue";

const props = defineProps<{ channel: ChatChannel; compact?: boolean }>();
const { participants, amCaptain, mlsIdentity } = props.channel;

// Captain-only moderation sheet for the clicked member.
const moderateOpen = ref(false);
const moderateTarget = ref<Participant | null>(null);
function openModerate(p: Participant) {
  moderateTarget.value = p;
  moderateOpen.value = true;
}
</script>

<template>
  <div class="space-y-3">
    <ParticipantRow
      v-for="p in participants"
      :key="p.id ?? p.name"
      :participant="p"
      :compact="compact"
      :can-moderate="amCaptain && !!p.id && p.id !== mlsIdentity"
      @moderate="openModerate(p)"
    />
    <OyaEmptyState v-if="!participants.length" size="sm">
      {{ compact ? "No participants." : "No participants yet." }}
    </OyaEmptyState>
    <ModerateMemberModal v-model:open="moderateOpen" :participant="moderateTarget" :channel="channel" />
  </div>
</template>
