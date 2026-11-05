<script setup lang="ts">
// Map sub-tab composition: toolbar over canvas + inspector. Owns the tool mode
// (view state, dropped on tab switch by design) and routes canvas-owned actions
// (layout, fit) from the toolbar to the graph component holding the cy handle.
import { ref } from "vue";
import MindGraph, { type MindTool } from "./MindGraph.vue";
import MindInspector from "./MindInspector.vue";
import MindToolbar from "./MindToolbar.vue";
import type { Mind } from "./useMind";

defineProps<{
  mind: Mind;
  darkMode?: boolean;
}>();

const tool = ref<MindTool>("select");
const graph = ref<InstanceType<typeof MindGraph> | null>(null);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <MindToolbar
      :mind="mind"
      :tool="tool"
      :dark-mode="darkMode"
      @update:tool="tool = $event"
      @auto-layout="graph?.autoLayout()"
      @zoom-fit="graph?.zoomFit()"
    >
      <slot name="toolbar-extra" />
    </MindToolbar>
    <div class="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
      <MindGraph
        ref="graph"
        :mind="mind"
        :tool="tool"
        :dark-mode="darkMode"
        @update:tool="tool = $event"
      />
      <MindInspector :mind="mind" :dark-mode="darkMode" />
    </div>
  </div>
</template>
