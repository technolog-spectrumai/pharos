<script setup lang="ts">
// Chips input over faros usernames — the "who gets in" control of a cloud
// invite. All state lives in useRecipientPicker; this is markup only.
import { OyaBadge } from "rakotis";
import type { Recipient, RecipientPicker } from "./useRecipientPicker";

defineProps<{ picker: RecipientPicker; darkMode?: boolean }>();

const TONE: Record<Recipient["state"], "pulse" | "neutral" | "muted" | "warn"> = {
  resolving: "pulse",
  ok: "neutral",
  self: "muted",
  unknown: "warn",
  error: "warn",
};
const ICON: Record<Recipient["state"], string> = {
  resolving: "spinner",
  ok: "check",
  self: "user",
  unknown: "triangle-exclamation",
  error: "triangle-exclamation",
};

function label(r: Recipient): { key: string; args?: Record<string, unknown> } {
  switch (r.state) {
    case "resolving": return { key: "cloud.recipientResolving" };
    case "ok":
      return r.nodeIds.length > 1
        ? { key: "cloud.recipientOkDevices", args: { n: r.nodeIds.length } }
        : { key: "cloud.recipientOk" };
    case "self": return { key: "cloud.recipientSelf" };
    case "unknown": return { key: "cloud.recipientUnknown" };
    default: return { key: "cloud.recipientRetry" };
  }
}
</script>

<template>
  <div class="space-y-2">
    <p class="text-xs font-semibold uppercase tracking-wide opacity-70">
      {{ $t('cloud.recipientsLabel') }}
    </p>

    <div
      class="flex flex-wrap items-center gap-2 rounded-lg border p-2"
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
    >
      <span
        v-for="r in picker.recipients.value"
        :key="r.username"
        class="inline-flex items-center gap-1.5"
        :data-testid="`recipient-chip-${r.username}`"
      >
        <OyaBadge :tone="TONE[r.state]" :icon="ICON[r.state]" :title="r.error || undefined">
          <span class="max-w-[12rem] truncate">{{ r.username }}</span>
          <span class="opacity-70" :data-testid="`recipient-state-${r.username}`">
            · {{ $t(label(r).key, label(r).args ?? {}) }}
          </span>
        </OyaBadge>
        <button
          v-if="r.state === 'error'"
          type="button"
          class="text-xs underline opacity-70 transition hover:opacity-100"
          :data-testid="`recipient-retry-${r.username}`"
          @click="picker.retry(r.username)"
        >
          {{ $t('cloud.recipientRetry') }}
        </button>
        <button
          type="button"
          class="opacity-50 transition hover:opacity-100"
          :aria-label="$t('cloud.recipientRemove')"
          :data-testid="`recipient-remove-${r.username}`"
          @click="picker.remove(r.username)"
        >
          <font-awesome-icon icon="xmark" class="text-xs" />
        </button>
      </span>

      <input
        v-model="picker.draft.value"
        type="text"
        :placeholder="$t('cloud.recipientsPlaceholder')"
        :disabled="picker.atMax.value"
        class="min-w-[10rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="recipient-input"
        @keydown.enter.prevent="picker.commitDraft()"
        @keydown="(e: KeyboardEvent) => { if (e.key === ',') { e.preventDefault(); picker.commitDraft(); } }"
        @blur="picker.commitDraft()"
      />
    </div>

    <p class="text-xs opacity-60">
      {{ picker.atMax.value ? $t('cloud.recipientsMax', { n: picker.max }) : $t('cloud.recipientsHint') }}
    </p>
  </div>
</template>
