<script setup lang="ts">
// Mind canvas host. The cytoscape instance lives and dies with this component
// (the memory-history router unmounts views on navigation) — the document in
// the useMind singleton is the only source of truth, and positions flow
// cy → doc exclusively on drag end.
//
// Placeholder shell: the cytoscape wiring lands in the canvas step; the wrapper
// and host geometry are final so layout (and the e2e height probe) hold.
import type { Mind } from "./useMind";

export type MindTool = "select" | "add-note" | "add-topic" | "connect";

defineProps<{
  mind: Mind;
  tool: MindTool;
  darkMode?: boolean;
}>();

defineEmits<{ "update:tool": [MindTool] }>();

function autoLayout() {}
function zoomFit() {}

defineExpose({ autoLayout, zoomFit });
</script>

<template>
  <!-- min-h guards the canvas against flex collapse; the host is absolutely
       positioned so cytoscape always measures a real box (MapPanel pattern). -->
  <div class="relative min-h-[24rem] flex-1 overflow-hidden rounded-xl bg-sunken-light dark:bg-sunken-dark">
    <div data-testid="mind-canvas" class="absolute inset-0 h-full w-full" />
  </div>
</template>
