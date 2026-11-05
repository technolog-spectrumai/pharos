<script setup lang="ts">
import { computed } from "vue";
import { OyaBadge } from "petalite/primitives";
import type { MlsStatus } from "rakotis";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

type BadgeTone = "neutral" | "success" | "warn" | "muted" | "pulse";

const props = defineProps<{
  status: MlsStatus;
  error?: string | null;
  encrypted: boolean;
  compact?: boolean;
}>();

// The security state of the room, so it is translated like everything else a user
// has to read to decide whether to type something. An unknown status falls through
// to its raw wire value rather than a wrong reassuring word.
const LABEL_KEYS: Record<string, string> = {
  idle: "chat.mlsIdle",
  initializing: "chat.mlsInitializing",
  key_exchange: "chat.mlsKeyExchange",
  ready: "chat.mlsReady",
  error: "chat.mlsError",
};

const label = computed(() => {
  const key = LABEL_KEYS[props.status];
  return key ? t(key) : props.status;
});

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
