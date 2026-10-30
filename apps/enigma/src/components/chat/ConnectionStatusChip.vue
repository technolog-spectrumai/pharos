<script setup lang="ts">
import { computed } from "vue";
import { OyaBadge } from "petalite/primitives";
import type { WsStatus } from "rakotis";

type BadgeTone = "neutral" | "success" | "warn" | "muted" | "pulse";

const props = defineProps<{ status: WsStatus; compact?: boolean }>();

const label = computed(
  () =>
    (
      { connected: "Connected", connecting: "Connecting…", disconnected: "Offline", error: "Error" } as Record<
        string,
        string
      >
    )[props.status] ?? props.status,
);

const tone = computed<BadgeTone>(() => {
  if (props.status === "connected") return "success";
  if (props.status === "connecting") return "pulse";
  if (props.status === "error") return "warn";
  return "muted";
});
</script>

<template>
  <OyaBadge :tone="tone" :icon="status === 'connected' ? 'check' : 'xmark'" :size="compact ? 'sm' : 'md'">
    {{ label }}
  </OyaBadge>
</template>
