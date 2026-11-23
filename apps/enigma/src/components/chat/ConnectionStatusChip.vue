<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { OyaBadge } from "petalite/primitives";
import type { WsStatus } from "rakotis";

type BadgeTone = "neutral" | "success" | "warn" | "muted" | "pulse";

// `linked`: how many other members have a live link to this device.
const props = defineProps<{ status: WsStatus; linked?: number; compact?: boolean }>();
const { t } = useI18n();

const label = computed(() => {
  switch (props.status) {
    case "connected":
      return t("chat.linkedTo", { n: props.linked ?? 1 }, props.linked ?? 1);
    case "waiting":
      return t("chat.waitingForOthers");
    case "connecting":
      return t("chat.statusConnecting");
    case "disconnected":
      return t("chat.statusOffline");
    case "error":
      return t("chat.statusError");
    default:
      return props.status;
  }
});

const tone = computed<BadgeTone>(() => {
  if (props.status === "connected") return "success";
  if (props.status === "connecting") return "pulse";
  if (props.status === "error") return "warn";
  return "muted";
});

const icon = computed(() =>
  props.status === "connected" ? "circle-nodes" : props.status === "waiting" ? "hourglass-half" : props.status === "error" ? "triangle-exclamation" : "plug",
);
</script>

<template>
  <OyaBadge :tone="tone" :icon="icon" :size="compact ? 'sm' : 'md'">
    {{ label }}
  </OyaBadge>
</template>
