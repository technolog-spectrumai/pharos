<script setup lang="ts">
// The transcript.
//
// APPEND-ONLY BY CONSTRUCTION: every run adds an entry and nothing above it is
// ever rewritten, so the run before last is still there to compare against.
// Clear empties it and does nothing else — there is no session to restart.
import { useI18n } from "vue-i18n";
import { OyaButton } from "petalite/primitives";
import type { RunEntry } from "../platform/workspace";

defineProps<{ entries: readonly RunEntry[] }>();
const emit = defineEmits<{ clear: [] }>();
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <section class="flex h-full flex-col" data-testid="output">
    <header class="flex items-center justify-between border-b px-3 py-2">
      <span class="text-xs font-semibold uppercase tracking-wide opacity-70">
        {{ t("console.title") }}
      </span>
      <OyaButton variant="secondary" data-testid="clear" @click="emit('clear')">
        {{ t("console.clear") }}
      </OyaButton>
    </header>

    <div class="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
      <p v-if="!entries.length" class="py-6 text-center opacity-40" data-testid="empty">
        {{ t("console.empty") }}
      </p>

      <div v-for="entry in entries" :key="entry.id" class="mb-3 border-l-2 pl-3"
           :class="entry.status === 'error' ? 'border-red-500/60' : 'border-current/20'"
           data-testid="entry">
        <div class="flex items-baseline gap-2 opacity-60">
          <span>[{{ entry.id }}]</span>
          <span class="truncate text-[0.65rem]">{{ entry.source }}</span>
          <span v-if="entry.exitCode !== null && entry.exitCode !== 0">
            {{ t("console.exitCode", { code: entry.exitCode }) }}
          </span>
        </div>

        <p v-if="entry.status === 'queued'" class="opacity-70">
          {{ t("console.queued") }}
        </p>
        <p v-if="entry.passes" class="opacity-60">
          {{ t("console.passes", { count: entry.passes }) }}
        </p>

        <!-- ONE stream. The runner merges stderr into stdout so a traceback
             sits where it happened relative to the prints around it — which is
             more use than two streams a reader has to reassemble by guessing. -->
        <pre v-if="entry.stdout" class="whitespace-pre-wrap">{{ entry.stdout }}</pre>
        <pre v-if="entry.error" class="whitespace-pre-wrap text-red-500">{{ entry.error }}</pre>

        <p v-if="entry.files.length" class="mt-1 opacity-60">
          {{ t("console.files", { names: entry.files.join(", ") }) }}
        </p>
      </div>
    </div>

    <!-- One sentence, not a tooltip: it changes what a person can do. -->
    <footer class="border-t px-3 py-1.5 text-xs opacity-55">
      {{ t("console.freshEachTime") }}
    </footer>
  </section>
</template>
