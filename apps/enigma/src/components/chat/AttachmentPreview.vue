<script setup lang="ts">
defineProps<{ pending: { kind: "image" | "voice"; url: string; label: string } }>();
defineEmits<{ clear: [] }>();
</script>

<template>
  <div
    class="mb-2 flex items-center gap-3 rounded-lg border px-3 py-2 border-accent-2 bg-primary-bg-light dark:border-accent-1 dark:bg-primary-bg-dark"
  >
    <img v-if="pending.kind === 'image'" :src="pending.url" alt="" class="h-12 w-12 shrink-0 rounded object-cover" />
    <audio v-else :src="pending.url" controls class="h-9 min-w-0 max-w-[220px]" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-xs font-semibold">
        {{ pending.kind === "image" ? $t("chat.imageReady") : $t("chat.voiceReady") }}
      </p>
      <p class="truncate text-[11px] opacity-60">{{ pending.label }}</p>
    </div>
    <button
      type="button"
      class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs font-semibold transition hover:opacity-80"
      @click="$emit('clear')"
    >
      <font-awesome-icon icon="xmark" class="mr-1" />{{ $t("common.cancel") }}
    </button>
  </div>
</template>
