<script setup lang="ts">
// Selection-bound side panel. Editing happens here rather than on the canvas
// because cytoscape labels are canvas-painted — there is no DOM element to
// attach an inline editor to. Placeholder: the full node/edge forms (with the
// Trix content editor) land in the inspector step.
import { OyaEmptyState } from "rakotis";
import type { Mind } from "./useMind";

defineProps<{
  mind: Mind;
  darkMode?: boolean;
}>();
</script>

<template>
  <div
    :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
    class="flex w-full flex-col gap-3 overflow-y-auto rounded-xl border p-3 lg:w-80"
  >
    <OyaEmptyState icon="diagram-project">{{ $t('mind.inspectorEmpty') }}</OyaEmptyState>
  </div>
</template>
