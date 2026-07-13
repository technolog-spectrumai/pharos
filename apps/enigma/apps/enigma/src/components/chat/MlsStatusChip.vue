<script setup lang="ts">
import { computed } from "vue";
import { OyaBadge } from "rakotis";
import type { MlsStatus } from "rakotis";

type BadgeTone = "neutral" | "success" | "warn" | "muted" | "pulse";

const props = defineProps<{
  status: MlsStatus;
  error?: string | null;
  encrypted: boolean;
  compact?: boolean;
}>();

const label = computed(
  () =>
    (
      {
        idle: "Not encrypted",
        initializing: "Initializing…",
        key_exchange: "Key exchange…",
        ready: "Encrypted",
        error: "Enc. error",
      } as Record<string, string>
    )[props.status] ?? props.status,
);

const tone = computed<BadgeTone>(() => {
  if (props.status === "ready") return "success";
  if (props.status === "initializing" || props.status === "key_exchange") return "pulse";
  if (props.status === "error") return "warn";
  return "muted";
});
</script>

<template>
  <OyaBadge :tone="tone" :icon="encrypted ? 'lock' : 'lock-open'" :title="error ?? undefined" :size="compact ? 'sm' : 'md'">
    {{ label }}
  </OyaBadge>
</template>
